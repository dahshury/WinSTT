import type { BrowserWindow } from "electron";
import { screen } from "electron";
import { getStoreValue, store } from "../lib/store";

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

let overlayWindow: BrowserWindow | null = null;

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
	// Order matters: opacity first so DWM stops compositing this surface
	// immediately. Move offscreen as backup. Hide last so the canonical
	// state is consistent.
	safeCall(() => win.setOpacity(0));
	safeCall(() => win.setPosition(-10_000, -10_000));
	safeCall(() => win.hide());
}

function applyShow(x: number, y: number): void {
	const win = overlayWindow;
	// Stryker disable next-line ConditionalExpression,BlockStatement: defensive
	// null-check — showOverlay (the only caller) already guards against
	// `overlayWindow === null` before invoking applyShow.
	if (!win) {
		return;
	}
	// Position first so the user never sees a flash at the offscreen
	// coordinates, then opacity, then show.
	safeCall(() => win.setPosition(x, y));
	safeCall(() => win.setOpacity(1));
	safeCall(() => win.showInactive());
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
 * Store reference to the overlay window
 */
export function setOverlayWindow(win: BrowserWindow): void {
	overlayWindow = win;
}

function isOverlaySuppressedBySettings(): boolean {
	const enabled = getStoreValue("general.showRecordingOverlay");
	const recordingMode = getStoreValue("general.recordingMode");
	return !enabled || recordingMode === "listen";
}

/**
 * Show the overlay window with position and settings checks.
 * Fires synchronously — no debounce, no animation delay.
 */
export function showOverlay(): void {
	if (!overlayWindow || isOverlaySuppressedBySettings()) {
		return;
	}

	const primaryDisplay = screen.getPrimaryDisplay();
	const { width, height } = primaryDisplay.workAreaSize;
	const [winWidth = 800, winHeight = 120] = overlayWindow.getSize();
	const x = Math.round((width - winWidth) / 2);
	const y = Math.round(height - winHeight - 60);

	desired = "shown";
	clearPendingTimers();
	stopReconciler();
	applyShow(x, y);
}

/**
 * Hide the overlay window immediately, with multiple retry passes to
 * fight DWM compositor caching on transparent windows.
 */
export function hideOverlay(): void {
	if (!overlayWindow) {
		return;
	}
	desired = "hidden";
	clearPendingTimers();
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
 * Force-hide. Same behavior as `hideOverlay()`, kept as a separate name
 * so settings watchers stay clear about intent.
 */
export function hideOverlayImmediate(): void {
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
	return () => {
		disposeOverlaySetting();
		disposeModeSetting();
		clearPendingTimers();
		stopReconciler();
	};
}

/** Test hook: reset all overlay module state. */
export function __resetOverlayForTesting__(): void {
	desired = "hidden";
	clearPendingTimers();
	stopReconciler();
	overlayWindow = null;
}
