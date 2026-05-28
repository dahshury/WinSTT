import type { BrowserWindow } from "electron";
import { ipcMain, screen } from "electron";
import { getStoreValue, store } from "../lib/store";

/**
 * Focus-pass-through hardening, modeled on Tauri's `tauri-nspanel` + Handy's
 * overlay implementation (examples/Handy/src-tauri/src/overlay.rs). The pill
 * is purely visual — it MUST NOT steal focus from the app the user is typing
 * into, or the dictation paste lands in the wrong window. Achieved purely
 * through Electron BrowserWindow APIs (no native NSPanel addon):
 *
 *   1. `setIgnoreMouseEvents(true, { forward: true })` — clicks fall through
 *      to the app underneath; mouse-move events still reach the renderer so
 *      the X cancel button can flip ignore off on hover.
 *   2. `setFocusable(false)` — operating system never gives the pill keyboard
 *      focus, even if the user clicks an interactive element on it.
 *   3. `setAlwaysOnTop("screen-saver", 1)` — highest documented z-order; the
 *      pill rides above other always-on-top windows and fullscreen apps.
 *   4. `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` — the
 *      pill follows the user across virtual desktops and stays visible when
 *      the target app is fullscreen (matches NSPanel's `canJoinAllSpaces` +
 *      `fullScreenAuxiliary` collection behavior on macOS).
 *   5. `skipTaskbar: true` and macOS `type: "panel"` are applied at
 *      BrowserWindow construction in main.ts (`createOverlayWindow`).
 *
 * Belt-and-suspenders: every call is wrapped in `safeCall` because some flags
 * are platform-specific (e.g. `setVisibleOnAllWorkspaces` is a no-op on
 * Windows but throws on some Electron builds for some signatures).
 */
function applyFocusPassThroughFlags(win: BrowserWindow): void {
	// Mirror examples/Handy/src-tauri/src/overlay.rs: the overlay is a
	// regular interactive window that simply doesn't STEAL focus on show.
	// Handy proved this is enough — they build with `.focused(false)` and
	// intentionally do NOT call any "ignore mouse" API or set
	// WS_EX_NOACTIVATE permanently. We tried both `setIgnoreMouseEvents`
	// (raced the click) and `setFocusable(false)` (touch landed, mouse
	// was swallowed by the transparent+alwaysOnTop+NOACTIVATE combination
	// on Windows). Dropping both is the only reliable fix for "mouse
	// click on X does nothing".
	//
	// Focus stealing is prevented by ALWAYS using `showInactive()` (in
	// applyShow below) which displays the window without activating it.
	// A user-initiated click momentarily focuses the overlay so React
	// can run the click handler — abortOperation immediately hides the
	// window, returning focus to the user's target app within a frame.
	//
	// `setAlwaysOnTop` + `setVisibleOnAllWorkspaces` give the pill the
	// screen-saver Z-order Handy uses on macOS / Windows.
	safeCall(() => win.setAlwaysOnTop(true, "screen-saver", 1));
	safeCall(() =>
		win.setVisibleOnAllWorkspaces(true, {
			visibleOnFullScreen: true,
		})
	);
}

/**
 * Coarse-grained "should the overlay even exist on this OS?" gate. Mirrors
 * Handy's behavior of defaulting Linux overlay to OFF because some Wayland /
 * GTK compositors break the paste pipeline when a transparent always-on-top
 * window appears mid-keystroke. Escape hatch: `WINSTT_FORCE_OVERLAY=1` lets
 * Linux users opt-in (with the documented caveat that focus stealing /
 * paste-failure may occur on their compositor).
 *
 * Truthy values: `"1"`, `"true"`, `"yes"`, `"on"` (case-insensitive). Empty
 * string and `"0"` / `"false"` / `"no"` / `"off"` are falsy. Matches the
 * convention in examples/Handy/src-tauri/src/overlay.rs `env_flag_enabled`.
 */
function isForceOverlayEnvFlagSet(): boolean {
	const raw = process.env.WINSTT_FORCE_OVERLAY;
	if (raw === undefined) {
		return false;
	}
	const norm = raw.trim().toLowerCase();
	if (norm === "" || norm === "0" || norm === "false" || norm === "no" || norm === "off") {
		return false;
	}
	return true;
}

/**
 * Resolve the user's `general.overlayPosition` setting to a concrete edge.
 * `"auto"` falls back to platform default (Linux → `"none"` unless the env
 * escape hatch is set, macOS / Windows → `"bottom"`).
 */
function resolveOverlayPosition(): "none" | "top" | "bottom" {
	const raw = getStoreValue("general.overlayPosition");
	if (raw === "none" || raw === "top" || raw === "bottom") {
		return raw;
	}
	// "auto"
	if (process.platform === "linux") {
		return isForceOverlayEnvFlagSet() ? "bottom" : "none";
	}
	return "bottom";
}

/**
 * Robust hide/show for the transparent recording-pill BrowserWindow.
 *
 * Why this is more elaborate than a single hide() call:
 *   - DWM caches the composited surface of transparent + alwaysOnTop
 *     windows. Under rapid hide → show → hide cycles a `hide()` can
 *     return before DWM has actually dropped the previous frame, so
 *     the pill stays visible until the next compositor pass.
 *   - `setOpacity(0)` updates the layered-window alpha and is the
 *     most immediate visibility signal DWM accepts.
 *   - `setPosition(-10000, -10000)` is a belt-and-suspenders fallback
 *     for any DWM ghost surface that survives both opacity and hide.
 *
 * Defense in depth:
 *   - We track the *desired* state (`hidden` | `shown`) explicitly.
 *   - `hideOverlay()` applies the hide pass immediately AND schedules
 *     re-applies at +50ms / +150ms / +400ms in case DWM swallowed the
 *     first one. Each re-apply checks `desired === "hidden"` so a
 *     show that lands during the retry window cancels the retries.
 *   - `showOverlay()` cancels pending hide retries before showing.
 *   - A reconciler ticker runs while we're in the "hidden" state for
 *     the first ~2s to catch any case where the surface still
 *     reappears (renderer paint, focus-stealing windows, etc).
 */

const HIDE_REAPPLY_DELAYS_MS = [50, 150, 400] as const;
const RECONCILE_INTERVAL_MS = 200;
const RECONCILE_MAX_DURATION_MS = 2000;

/**
 * Grace period before the OS-level hide pass actually runs in dynamic-island
 * mode. The renderer plays a panel-slide exit (translateY up + opacity-fade +
 * blur) inside the window when its `isVisible` flips false — if we yanked the
 * OS window to opacity:0 / hide() the instant the session ended, the user
 * would see a hard cut instead of the exit animation. Keeping the window
 * composited at full opacity for this many ms lets the renderer's animation
 * play out before the OS catches up. The value tracks the renderer's
 * REVEAL_CLOSE_DUR (350ms) in `shared/ui/dynamic-island/DynamicIsland.tsx`
 * plus a small buffer for the final frame to land in the compositor.
 *
 * Floating-bottom mode keeps the original synchronous hide — its chip /
 * bubble exit is 160ms and the user hasn't reported a missing animation
 * there. Both `desired = "hidden"` and `sessionWantsOverlay = false` flip
 * synchronously regardless of mode so any concurrent show race-check sees
 * the right intent; only the actual `applyHide()` is deferred.
 */
const DYNAMIC_ISLAND_HIDE_GRACE_MS = 400;

/**
 * DWM caches the most recently composited surface of transparent / always-on-
 * top windows. When the overlay is hidden after one session and shown again
 * for the next PTT press, the cached frame (pill + previous text) is what the
 * user sees for one or two compositor cycles — *before* the renderer's fresh
 * post-`recording_start` paint reaches the GPU. Background throttling on the
 * hidden window means the renderer's "clear" paint from the previous session
 * never updated the cache while hidden either, so the cache is whatever was
 * last on-screen.
 *
 * To hide that flash, `applyShow` reveals the window at opacity 0 first, then
 * ramps to 1 after this delay — enough for the renderer to:
 *   1. process STT_RECORDING_START IPC (~one event-loop tick),
 *   2. run Zustand setters + React reconcile (~one tick),
 *   3. submit a fresh paint to the compositor (~one frame).
 *
 * 80ms covers all three with margin while staying well under the ~150ms
 * threshold at which users perceive a deliberate delay.
 */
const SHOW_OPACITY_RAMP_DELAY_MS = 80;

let overlayWindow: BrowserWindow | null = null;

// The visible *main* WinSTT window. The pill is only a stand-in for the
// transcription surface the main window already renders, so the two must
// never be on screen at the same time. Tracked here so `showOverlay()` can
// suppress the pill while the main window is up and `syncOverlayToMainWindow`
// can restore it the moment the main window goes away.
let mainWindow: BrowserWindow | null = null;

// Whether the current dictation session wants the pill, independent of
// whether we're actually painting it right now. `showOverlay()` sets this
// even when suppressed (settings / main window visible); `hideOverlay()`
// clears it. `syncOverlayToMainWindow` reads it to decide whether a
// main-window hide should bring the pill back.
// Stryker disable next-line BooleanLiteral: closure init — show/hideOverlay
// always assign this before any consumer reads it.
let sessionWantsOverlay = false;

type DesiredState = "hidden" | "shown";
// Stryker disable next-line StringLiteral: equivalent — the public API
// (__resetOverlayForTesting__, hideOverlay, showOverlay) overwrites `desired`
// before any test reads it, so the initial literal is unobservable.
let desired: DesiredState = "hidden";

// Stryker disable next-line ArrayDeclaration: equivalent — clearPendingTimers
// resets this to [] and pendingTimers is push-only thereafter; the initial
// literal value is unobservable in tests because hideOverlay always pushes
// timers and the test setup resets state before each test.
let pendingTimers: ReturnType<typeof setTimeout>[] = [];
let reconcilerTimer: ReturnType<typeof setInterval> | null = null;
let reconcilerStartedAt = 0;

function clearPendingTimers(): void {
	for (const t of pendingTimers) {
		clearTimeout(t);
	}
	// Stryker disable next-line ArrayDeclaration: the only observable property
	// of `pendingTimers` after this assignment is `.length === 0` for the
	// `for (const t of pendingTimers)` loop next time. A mutant that assigns
	// `["Stryker was here"]` would later try to `clearTimeout("Stryker...")`
	// which is a silent no-op (clearTimeout coerces non-handles to a no-op),
	// so no test can distinguish it from the empty-array initialization.
	pendingTimers = [];
}

function stopReconciler(): void {
	// Stryker disable next-line ConditionalExpression: clearInterval(null)
	// is a silent no-op in Node, so dropping the `if (reconcilerTimer)` guard
	// has no observable effect — it's a defensive null-check.
	if (reconcilerTimer) {
		clearInterval(reconcilerTimer);
		reconcilerTimer = null;
	}
}

function safeCall(fn: () => void): void {
	try {
		fn();
	} catch {
		// best-effort — window may already be destroyed
	}
}

function applyHide(): void {
	const win = overlayWindow;
	// Stryker disable next-line ConditionalExpression,BlockStatement: defensive
	// null-check — every public caller (hideOverlay, the reconciler) already
	// guards against `overlayWindow === null` before invoking applyHide, so
	// this check is unreachable in practice and removing it is observably
	// equivalent at the test boundary.
	if (!win) {
		return;
	}
	// No setIgnoreMouseEvents call — the overlay window is now always
	// interactive (Handy parity, see applyFocusPassThroughFlags). Hide
	// just suppresses visibility / DWM compositing.
	//
	// Order matters: opacity first so DWM stops compositing this surface
	// immediately. Move offscreen as backup. Hide last so the canonical
	// state is consistent.
	safeCall(() => win.setOpacity(0));
	safeCall(() => win.setPosition(-10_000, -10_000));
	safeCall(() => win.hide());
}

function safeReturn<T>(fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch {
		return fallback;
	}
}

function applyShow(x: number, y: number): void {
	const win = overlayWindow;
	// Stryker disable next-line ConditionalExpression,BlockStatement: defensive
	// null-check — showOverlay (the only caller) already guards against
	// `overlayWindow === null` before invoking applyShow.
	if (!win) {
		return;
	}
	// No setIgnoreMouseEvents call — the overlay window is always
	// interactive (Handy parity). The X cancel button receives clicks
	// directly because the window simply catches them. Focus stealing is
	// prevented by `showInactive()` below (NOT `show()`), which puts the
	// pill on screen without activating it — the user's target app stays
	// the keyboard sink. Trade-off: clicks anywhere in the overlay
	// window's rect don't pass through to the app underneath while the
	// pill is shown, but the rect is only on screen DURING a recording /
	// LLM-thinking pass when the user isn't reaching for the app behind
	// it anyway.
	// Position first so the user never sees a flash at the offscreen
	// coordinates.
	safeCall(() => win.setPosition(x, y));

	// If we're re-showing an already-visible window (e.g. `maybeRunLlm` calls
	// `showOverlay()` when the pill is already on screen to overlay the
	// thinking indicator), skip the opacity ramp — keep it fully opaque.
	if (safeReturn(() => win.isVisible(), false)) {
		safeCall(() => win.setOpacity(1));
		safeCall(() => win.showInactive());
		return;
	}

	// Fresh show after a hide. Reveal at opacity 0, then ramp to 1 after the
	// renderer has had time to paint its post-`recording_start` empty state
	// into the compositor. See SHOW_OPACITY_RAMP_DELAY_MS for the rationale.
	safeCall(() => win.setOpacity(0));
	safeCall(() => win.showInactive());
	pendingTimers.push(
		setTimeout(() => {
			// `clearPendingTimers` would have cancelled this if a hide raced
			// in, but `desired` is the source of truth — re-check before
			// flipping opacity so a hide-then-show within the ramp window
			// can't accidentally reveal the still-stale composited surface.
			if (desired !== "shown") {
				return;
			}
			const w = overlayWindow;
			if (!w) {
				return;
			}
			// `safeCall` already absorbs the "window destroyed" case.
			safeCall(() => w.setOpacity(1));
		}, SHOW_OPACITY_RAMP_DELAY_MS)
	);
}

// Stryker disable next-line ConditionalExpression,BlockStatement,EqualityOperator: belt-and-
// suspenders — `showOverlay()` already calls `stopReconciler()` before flipping
// `desired = "shown"`, and the tick interval (200ms) doesn't align exactly with
// the 2000ms cutoff, so > vs >= and the `desired` self-check are observably
// equivalent in tests. The `desired` check keeps the code defensive against
// future callers.
function shouldStopReconciler(): boolean {
	return desired !== "hidden" || Date.now() - reconcilerStartedAt > RECONCILE_MAX_DURATION_MS;
}

function reconcileTick(): void {
	if (shouldStopReconciler()) {
		stopReconciler();
		return;
	}
	// If something (Windows, a focus event, a stale paint) re-showed
	// the window, re-apply hide. Idempotent — if already hidden it's
	// just a few cheap calls.
	// Stryker disable next-line OptionalChaining: defensive — by the time
	// the reconciler ticks, overlayWindow has been assigned by setOverlayWindow;
	// removing the optional chain doesn't crash any reachable test path.
	if (overlayWindow?.isVisible()) {
		applyHide();
	}
}

function startHideReconciler(): void {
	stopReconciler();
	reconcilerStartedAt = Date.now();
	reconcilerTimer = setInterval(reconcileTick, RECONCILE_INTERVAL_MS);
}

/**
 * Store reference to the overlay window. Also (re-)applies the NSPanel-
 * imitation focus-pass-through flags so any registration path — production
 * `createOverlayWindow`, or a test injecting a mock — gets the same hardened
 * behavior.
 */
export function setOverlayWindow(win: BrowserWindow): void {
	overlayWindow = win;
	applyFocusPassThroughFlags(win);
}

/**
 * Register (or clear, with `null` on main-window destruction) the main
 * WinSTT window so the pill can stay mutually exclusive with it.
 */
export function setMainWindow(win: BrowserWindow | null): void {
	mainWindow = win;
}

// The pill is suppressed only while the main window is actually *focused* —
// not merely visible. A visible-but-unfocused main window is the normal
// dictation case (the user is typing into another app), where the pill is
// still the only on-screen feed and must stay. `isFocused()` is already
// false for a hidden/minimized window, so this also covers those cases.
// Listen mode is handled separately by `isOverlaySuppressedBySettings()`
// (the pill never shows there regardless of focus).
function isMainWindowFocused(): boolean {
	return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused());
}

function isOverlaySuppressedBySettings(): boolean {
	const enabled = getStoreValue("general.showRecordingOverlay");
	const recordingMode = getStoreValue("general.recordingMode");
	// `overlayPosition === "none"` is a hard "do not show" override that
	// resolves the cross-platform / env-flag matrix above. Keeping it inside
	// the same suppression gate means every existing show/hide path — main
	// window focus sync, settings live-changes, etc. — already respects it.
	const position = resolveOverlayPosition();
	return !enabled || recordingMode === "listen" || position === "none";
}

/**
 * Compute the on-screen (x, y) for the overlay window for the given mode.
 *
 * `floating-bottom` (the historical layout): centered horizontally in the
 * primary display's *work area* (so it sits above the Windows taskbar),
 * 60px above the work-area bottom edge.
 *
 * `dynamic-island`: docked flush to the *physical top* of the primary
 * display (`bounds.y`), centered horizontally in `bounds.width`. The user
 * asked for "no distance between it and the top bezel of the desktop", so
 * we use `bounds` not `workArea` — a top-mounted taskbar would still get
 * painted under, mirroring Apple's Dynamic Island behavior.
 *
 * `overlayPosition === "top"` forces the top anchor even when `overlayMode`
 * is `floating-bottom` (and vice-versa for `"bottom"`). This mirrors Handy's
 * `OverlayPosition::Top` / `OverlayPosition::Bottom` which is purely about
 * screen-edge anchoring and orthogonal to layout style.
 */
function computeOverlayPosition(
	mode: "floating-bottom" | "dynamic-island",
	winWidth: number,
	winHeight: number
): { x: number; y: number } {
	const primaryDisplay = screen.getPrimaryDisplay();
	const position = resolveOverlayPosition();
	// `position === "none"` reaches here only if `showOverlay` was bypassed
	// (defensive) — fall back to the resting position so the window doesn't
	// flash at uninitialized (0,0). `position === "top"` and the dynamic-
	// island layout share the same top-bezel anchor.
	const wantTop = position === "top" || mode === "dynamic-island";
	if (wantTop) {
		const { x: boundsX, y: boundsY, width: boundsWidth } = primaryDisplay.bounds;
		return {
			x: boundsX + Math.round((boundsWidth - winWidth) / 2),
			y: boundsY,
		};
	}
	const { width, height } = primaryDisplay.workAreaSize;
	return {
		x: Math.round((width - winWidth) / 2),
		y: Math.round(height - winHeight - 60),
	};
}

function resolveOverlayMode(): "floating-bottom" | "dynamic-island" {
	const raw = getStoreValue("general.overlayMode");
	return raw === "dynamic-island" ? "dynamic-island" : "floating-bottom";
}

/**
 * Position and reveal the pill. Caller is responsible for the gating
 * (settings / main-window visibility) — this is the unconditional show.
 */
function doShow(): void {
	if (!overlayWindow) {
		return;
	}

	const [winWidth = 800, winHeight = 120] = overlayWindow.getSize();
	const { x, y } = computeOverlayPosition(resolveOverlayMode(), winWidth, winHeight);

	desired = "shown";
	clearPendingTimers();
	stopReconciler();
	applyShow(x, y);
}

/**
 * Re-anchor the pill in response to a live `general.overlayMode` change.
 * Only acts when the pill is currently visible — switching modes while the
 * pill is hidden is a no-op (the next `showOverlay()` will read the new
 * mode through `doShow()`).
 */
function getAliveOverlayWindow(): BrowserWindow | null {
	if (overlayWindow && !overlayWindow.isDestroyed()) {
		return overlayWindow;
	}
	return null;
}

function isOverlayLiveAndVisible(): boolean {
	const win = getAliveOverlayWindow();
	return win !== null && desired === "shown" && win.isVisible();
}

function repositionIfVisible(): void {
	if (!isOverlayLiveAndVisible()) {
		return;
	}
	const win = getAliveOverlayWindow();
	if (!win) {
		return;
	}
	const [winWidth = 800, winHeight = 120] = win.getSize();
	const { x, y } = computeOverlayPosition(resolveOverlayMode(), winWidth, winHeight);
	safeCall(() => win.setPosition(x, y));
}

/**
 * Show the overlay window with position and settings checks.
 * Fires synchronously — no debounce, no animation delay.
 *
 * The pill is suppressed while the main window is focused: it already
 * renders the same transcription + LLM thinking indicator, so the pill
 * would be a redundant duplicate. `sessionWantsOverlay` is still set so
 * `syncOverlayToMainWindow` can bring the pill back if the main window
 * loses focus before the session ends.
 */
const SHOW_OVERLAY_GATES: ReadonlyArray<() => boolean> = [
	() => !overlayWindow,
	isOverlaySuppressedBySettings,
	isMainWindowFocused,
];

function isOverlayShowGated(): boolean {
	return SHOW_OVERLAY_GATES.some((gate) => gate());
}

export function showOverlay(): void {
	sessionWantsOverlay = true;
	if (isOverlayShowGated()) {
		return;
	}
	doShow();
}

/**
 * Run the actual OS-level hide pass: `applyHide()` synchronously, then the
 * three DWM-defense re-applies on a tail of timers, then start the visible-
 * surface reconciler. Extracted so the two call paths in `performHide()`
 * (immediate for floating-bottom, deferred for dynamic-island) can share it.
 */
function runHidePass(): void {
	applyHide();
	// Re-apply at intervals to combat DWM compositor swallowing the first
	// hide under rapid show/hide cycles. Each tick checks `desired` so a
	// show that lands during the retry window cancels the work.
	for (const delay of HIDE_REAPPLY_DELAYS_MS) {
		pendingTimers.push(
			setTimeout(() => {
				if (desired === "hidden") {
					applyHide();
				}
			}, delay)
		);
	}
	startHideReconciler();
}

/**
 * Drop the pill off-screen with the full DWM-fighting retry dance, WITHOUT
 * touching `sessionWantsOverlay`. Used both by the public `hideOverlay()`
 * (session over) and by `syncOverlayToMainWindow` (session still live, the
 * main window is just covering for the pill).
 *
 * In `dynamic-island` overlay mode the actual OS hide is deferred by
 * `DYNAMIC_ISLAND_HIDE_GRACE_MS` so the renderer can play its slide-up exit
 * animation in a still-composited window. `desired = "hidden"` flips
 * immediately so a concurrent `showOverlay()` race-check still sees the
 * right intent (and cancels the pending hide via `clearPendingTimers`).
 * Floating-bottom keeps the original synchronous behavior.
 */
function performHide(): void {
	if (!overlayWindow) {
		return;
	}
	desired = "hidden";
	clearPendingTimers();

	if (resolveOverlayMode() === "dynamic-island") {
		pendingTimers.push(
			setTimeout(() => {
				if (desired === "hidden") {
					runHidePass();
				}
			}, DYNAMIC_ISLAND_HIDE_GRACE_MS)
		);
		return;
	}

	runHidePass();
}

/**
 * Hide the overlay window immediately, with multiple retry passes to
 * fight DWM compositor caching on transparent windows. Marks the session
 * as no longer wanting the pill so a later main-window hide can't
 * resurrect a finished session's pill.
 */
export function hideOverlay(): void {
	sessionWantsOverlay = false;
	performHide();
}

/**
 * Keep the pill and the focused main window mutually exclusive. Driven by
 * the main window's focus / blur / hide / minimize events (wired in
 * main.ts).
 *
 * - Main window focused → drop the pill (it's redundant; the main window
 *   shows the same transcription + thinking indicator). Intent is kept so
 *   the pill can return when focus is lost.
 * - Main window not focused, session still wants the pill, not otherwise
 *   suppressed → bring the pill back so the live feed isn't lost.
 */
function canShowAfterMainBlur(): boolean {
	return sessionWantsOverlay && overlayWindow !== null && !isOverlaySuppressedBySettings();
}

export function syncOverlayToMainWindow(): void {
	if (isMainWindowFocused()) {
		performHide();
		return;
	}
	if (canShowAfterMainBlur()) {
		doShow();
	}
}

function hideOverlayImmediate(): void {
	hideOverlay();
}

/**
 * Setup overlay handlers for settings changes.
 * Returns a cleanup function that removes the store watchers.
 */
export function setupOverlayHandlers(): () => void {
	const disposeOverlaySetting = store.onDidChange("general.showRecordingOverlay", (newValue) => {
		if (!newValue) {
			hideOverlayImmediate();
		}
	});
	const disposeModeSetting = store.onDidChange("general.recordingMode", (newValue) => {
		if (newValue === "listen") {
			hideOverlayImmediate();
		}
	});
	// Live overlay-mode swap: reposition the visible pill in place so the
	// user sees the layout change immediately rather than after the next
	// recording session.
	const disposeOverlayMode = store.onDidChange("general.overlayMode", () => {
		repositionIfVisible();
	});
	// Live screen-edge swap: same idea — reposition in place if the user
	// flips `general.overlayPosition` from top to bottom (or vice-versa)
	// mid-session. A flip TO `"none"` is handled by `isOverlaySuppressedBy
	// Settings` on the next show; if a pill is currently visible the user
	// would expect it to vanish, so call `performHide` directly here.
	const disposeOverlayPosition = store.onDidChange("general.overlayPosition", () => {
		if (resolveOverlayPosition() === "none") {
			performHide();
		} else {
			repositionIfVisible();
		}
	});
	// The overlay window is created with `setIgnoreMouseEvents(true, { forward: true })`
	// so clicks pass through to the app underneath while hover events still reach
	// the renderer for hit-testing. The renderer flips ignore off (`ignore: false`)
	// while the cursor sits over the X cancel button so the click lands; on leave
	// it flips back to (true, { forward: true }) so clicks resume falling through.
	ipcMain.on("overlay:set-ignore-mouse", (_event, payload: unknown) => {
		if (!overlayWindow || overlayWindow.isDestroyed()) {
			return;
		}
		const ignore = Boolean(
			payload && typeof payload === "object" && (payload as { ignore?: unknown }).ignore
		);
		overlayWindow.setIgnoreMouseEvents(ignore, ignore ? { forward: true } : undefined);
	});
	return () => {
		disposeOverlaySetting();
		disposeModeSetting();
		disposeOverlayMode();
		disposeOverlayPosition();
		clearPendingTimers();
		stopReconciler();
		ipcMain.removeAllListeners("overlay:set-ignore-mouse");
	};
}

/** Test hook: reset all overlay module state. */
export function __resetOverlayForTesting__(): void {
	desired = "hidden";
	sessionWantsOverlay = false;
	mainWindow = null;
	clearPendingTimers();
	stopReconciler();
	overlayWindow = null;
}

/**
 * Test-only: directly mutate `sessionWantsOverlay`. Production callers go
 * through `showOverlay()` / `hideOverlay()`; tests for `canShowAfterMainBlur`
 * need to set this flag without also flipping the gating other fields the
 * predicate reads from.
 */
export function __setSessionWantsOverlayForTesting__(value: boolean): void {
	sessionWantsOverlay = value;
}

/** Test-only: aggregator exposing the private helpers exercised by the
 *  `canShowAfterMainBlur` / `syncOverlayToMainWindow` CRAP-gate tests.
 *  Keeping the production API surface intact while letting tests assert
 *  branch coverage on the helpers directly. */
export const __overlay_test_helpers__ = {
	canShowAfterMainBlur,
};
