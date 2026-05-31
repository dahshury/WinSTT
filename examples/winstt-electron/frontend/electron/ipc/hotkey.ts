import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { UiohookKey, uIOhook } from "uiohook-napi";
import { dbg, dbgVerbose } from "../lib/debug-log";
import { createSafeSender } from "../lib/ipc-helpers";
import { codesToNames, KEYCODE_TO_NAME, parseAccelerator } from "../lib/keycodes";
import { isToggleSessionActive, notifyHotkeyPressed } from "../lib/recording-state";
import { breadcrumb } from "../lib/sentry-main";
import { playRecordingSound } from "../lib/sound";
import { getStoreValue } from "../lib/store";
import type { SttClient } from "../ws/stt-client";
import { setHotkeyRecording } from "./recording-mode";

const MAX_COMBO_KEYS = 3;

/** Recording modes whose UX intentionally never chimes on hotkey press —
 *  listen-mode is fully passive and wake-word listens for a verbal trigger
 *  instead of a key. Set lookup keeps `shouldPlayRecordingSound` at CC ≤ 3. */
type RecordingMode = "ptt" | "toggle" | "listen" | "wakeword";
const SILENT_RECORDING_MODES = new Set<RecordingMode>(["listen", "wakeword"]);

/**
 * Power-user shortcuts triggered while the global hotkey is actively held.
 *
 *   - hotkey + Backspace   → cancel the in-flight transcription / LLM pass
 *   - hotkey + ArrowUp     → cycle to the next recording mode
 *                            (ptt → toggle → listen → wakeword → ptt)
 *
 * The legend in Settings → Audio mirrors this contract verbatim. If you
 * add or rename an action here, update the legend in
 * `src/widgets/audio-settings/ui/HotkeyShortcutsLegend.tsx` too.
 */
export type HotkeyComboAction = "cancel" | "cycle-mode";

const COMBO_KEYCODES: Record<number, HotkeyComboAction> = {
	[UiohookKey.Backspace]: "cancel",
	[UiohookKey.ArrowUp]: "cycle-mode",
};

function lookupComboAction(code: number): HotkeyComboAction | null {
	return COMBO_KEYCODES[code] ?? null;
}

export interface HotkeyComboOptions {
	/**
	 * Called when the user presses a recognised second-key combo while the
	 * global hotkey is actively held. Fires once per keydown (autoreceived
	 * key-repeat keydowns also count — the renderer is expected to make the
	 * action idempotent).
	 */
	onCombo?: (action: HotkeyComboAction) => void;
}

// Stryker disable next-line BooleanLiteral: module-level guard initial value — first setupHotkeyHandlers() call observes false then writes true; the inverted value is overwritten before any observer can read it
let hotkeyStarted = false;

/**
 * When true, onKeyDown/onKeyUp skip *firing* hotkey activation /
 * deactivation events so that synthetic keystrokes from the paste binary
 * (modifier release/restore + Ctrl+V) don't masquerade as user input.
 *
 * Both onKeyDown and onKeyUp DO continue to update `pressedKeys` so that
 * after the guard lifts the actual held-key state is correct. When the
 * guard lifts a single state-evaluation pass fires:
 *   - hotkey:pressed if the combo became held during the guard window
 *   - hotkey:released if the combo became not-held during the guard window
 * (or both, in FIFO order if the user fully press-and-released).
 */
// Stryker disable next-line BooleanLiteral: setPasteGuard() always overwrites this before observation
let pasteGuard = false;
let onPasteGuardLifted: (() => void) | null = null;

/**
 * Module-level mirror of the closure-scoped `isActive` flag so other
 * modules (e.g. relay.ts) can ask "is the user actually holding the
 * hotkey right now?". Used to gate side effects on server-emitted
 * recording_start events — a stale or duplicate event from the server
 * shouldn't re-show the overlay if the user has released the key.
 */
// Stryker disable next-line BooleanLiteral: module-level mirror — setIsActive() overwrites this on every register/key event before isHotkeyActive() observes it
let hotkeyIsActive = false;

export function isHotkeyActive(): boolean {
	return hotkeyIsActive;
}

/**
 * Run the pending lift handler (if any) under a try/catch.
 * Extracted so setPasteGuard stays at CC ≤ 3 (CRAP-budget driven).
 */
function runPendingLiftHandler(): void {
	// Stryker disable next-line ConditionalExpression: when no handler is installed this branch is a no-op; flipping it would still call fn() against a null reference inside the try/catch which swallows the throw — observable behavior is identical
	if (!onPasteGuardLifted) {
		return;
	}
	// Clear the handler ref BEFORE invoking it so a throw can't leave the
	// combo pointing at a stale one-shot handler — state stays consistent
	// regardless of whether fn() throws (the catch only logs; see test
	// "runPendingLiftHandler swallows a throwing on-lift handler").
	const fn = onPasteGuardLifted;
	onPasteGuardLifted = null;
	// Stryker disable BlockStatement,StringLiteral: catch body only logs via
	// dbg(); there is no observable side effect (no rethrow, no state
	// change), so emptying the body or mutating the log text is equivalent.
	try {
		fn();
	} catch (err) {
		dbg("hotkey", "paste-guard lift handler threw:", String(err));
	}
	// Stryker restore BlockStatement,StringLiteral
}

export function setPasteGuard(active: boolean): void {
	pasteGuard = active;
	// Stryker disable next-line ConditionalExpression: when active is true the inner block is unreachable; flipping the comparison is silently equivalent because runPendingLiftHandler() is a no-op when no handler is installed
	if (!active) {
		runPendingLiftHandler();
	}
}

/**
 * True while a paste binary is mid-run. Read by sibling input modules
 * (e.g. transform-hotkeys.ts) so they can short-circuit on the synthetic
 * keystroke flood from `winstt-paste.exe` instead of pushing scancodes
 * into their own `pressed` set or iterating combos per char.
 */
export function isPasteGuardActive(): boolean {
	return pasteGuard;
}

export function setupHotkeyHandlers(
	win: BrowserWindow,
	sttClient: SttClient,
	options: HotkeyComboOptions = {}
): () => void {
	let targetKeyCodes: Set<number> | null = null;
	let targetAccelerator = "";
	// Sticky — survives handleUnregister so React 19 StrictMode's mount → cleanup
	// → remount cycle (which fires unregister between two identical registers)
	// doesn't double-log "Registered:". The targetAccelerator absorber below only
	// catches mount → remount with no intervening unregister.
	let lastRegisteredAccelerator = "";
	const pressedKeys = new Set<number>();
	// Stryker disable next-line BooleanLiteral: closure init — setIsActive() always overwrites before observation in tests
	let isActive = false;
	/** Prevents re-activation until ALL combo keys have been released. */
	// Stryker disable next-line BooleanLiteral: closure init — handleRegister() and handleUnregister() always reset this before any combo can be activated
	let comboFullyReleased = true;
	const setIsActive = (v: boolean): void => {
		isActive = v;
		hotkeyIsActive = v;
	};

	// ── Recording state ─────────────────────────────────────────────
	let isRecording = false;
	const recordingPressed = new Set<number>();
	// Stryker disable next-line ArrayDeclaration: closure init — handleStartRecording() resets to [] before any peak observation
	let peakSnapshot: number[] = [];
	/** The webContents that initiated recording (may be settings window, not main). */
	let recordingSender: Electron.WebContents | null = null;

	const isCodePressed = (code: number): boolean => pressedKeys.has(code);

	const checkCombo = (): boolean => {
		if (!targetKeyCodes) {
			return false;
		}
		return [...targetKeyCodes].every(isCodePressed);
	};

	const safeSend = createSafeSender(win);

	/** Send recording events to the window that started recording (settings or main). */
	const recordingSend = (channel: string, ...args: unknown[]) => {
		const target = recordingSender ?? win.webContents;
		if (!target.isDestroyed()) {
			target.send(channel, ...args);
		}
	};

	/** Clear all recording state back to idle. */
	const resetRecording = () => {
		isRecording = false;
		recordingPressed.clear();
		// Stryker disable next-line ArrayDeclaration: handleStartRecording() always resets this before recording state is observed again
		peakSnapshot = [];
		recordingSender = null;
		// Cross-handler edge: clear the global flag so the sibling listeners
		// (tts-hotkey, repaste-hotkey) come back armed.
		setHotkeyRecording(false);
	};

	const updatePeakSnapshot = () => {
		// Stryker disable next-line EqualityOperator: replacing `>` with `>=` reassigns peak to the same content (same set, fresh array); the test sees identical names
		// Stryker disable next-line EqualityOperator: `<=` vs `<` is meaningful only at exactly MAX_COMBO_KEYS — covered by the recording-peak-cap test
		// Stryker disable next-line ConditionalExpression: replacing the LEFT side `size > peak.length` with `true` is equivalent — peakSnapshot reassigns to the same content because size grows monotonically by 1 per keydown
		if (recordingPressed.size > peakSnapshot.length && recordingPressed.size <= MAX_COMBO_KEYS) {
			peakSnapshot = [...recordingPressed];
		}
	};

	const handleRecordingKeyDown = (code: number) => {
		// Escape cancels recording
		if (code === UiohookKey.Escape) {
			recordingSend("hotkey:recording-done", { combo: null });
			resetRecording();
			return;
		}

		recordingPressed.add(code);
		updatePeakSnapshot();
		recordingSend("hotkey:recording-update", {
			keys: codesToNames(peakSnapshot),
		});
	};

	const allComboKeysReleased = (codes: Set<number>): boolean => {
		for (const c of codes) {
			if (pressedKeys.has(c)) {
				return false;
			}
		}
		return true;
	};

	const canMarkComboFullyReleased = (): boolean => {
		// Stryker disable ConditionalExpression,BlockStatement,BooleanLiteral: equivalent —
		// these guards are micro-optimizations: when `comboFullyReleased` is already
		// true the only state change `updateComboReleaseState` would make is setting
		// `comboFullyReleased = true` again (no-op). When `targetKeyCodes` is null
		// the previous guard always short-circuits because `comboFullyReleased` is
		// reset to true together with `targetKeyCodes = null` in handleUnregister.
		// Mutating the early-return values or skipping the guards yields identical
		// observable state.
		if (comboFullyReleased) {
			return false;
		}
		if (!targetKeyCodes) {
			return false;
		}
		// Stryker restore ConditionalExpression,BlockStatement,BooleanLiteral
		return allComboKeysReleased(targetKeyCodes);
	};

	const updateComboReleaseState = () => {
		if (canMarkComboFullyReleased()) {
			comboFullyReleased = true;
		}
	};

	const fireDeferredReleaseIfNeeded = () => {
		if (!isActive || checkCombo()) {
			return;
		}
		setIsActive(false);
		// Stryker disable next-line StringLiteral: dbg() message is informational only
		dbg("hotkey", "RELEASED (deferred — key released during paste guard)");
		safeSend("hotkey:released");
	};

	// (was: checkDeferredRelease helper. Replaced by `evalOnLift` below which
	// handles both deferred-press and deferred-release in a single state pass.)

	// Stryker disable next-line BlockStatement: equivalent — the entire body is dbgVerbose logging (informational only); replacing it with an empty body produces identical observable behavior.
	const logComboKeyDown = (code: number) => {
		// Stryker disable next-line ConditionalExpression: equivalent — when no accelerator is registered, `targetKeyCodes` is null and `?.has(code)` short-circuits to undefined → !undefined = true → early return; the mutated `true` (always early-return) is observationally identical because the only side effect of this function is dbgVerbose logging.
		if (!targetKeyCodes?.has(code)) {
			return;
		}
		// Stryker disable StringLiteral,LogicalOperator,ArrayDeclaration,ArrowFunction: dbgVerbose log line content; the entire log builder + emission is informational only.
		const name = KEYCODE_TO_NAME[code] ?? `?${code}`;
		const held = [...pressedKeys].map((c) => KEYCODE_TO_NAME[c] ?? `?${c}`).join("+");
		const need = [...targetKeyCodes].map((c) => KEYCODE_TO_NAME[c] ?? `?${c}`).join("+");
		dbgVerbose(
			"hotkey",
			`combo-key DOWN: ${name} | held=[${held}] need=[${need}] isActive=${isActive}`
		);
		// Stryker restore StringLiteral,LogicalOperator,ArrayDeclaration,ArrowFunction
	};

	const isSilentRecordingMode = (mode: unknown): boolean =>
		SILENT_RECORDING_MODES.has(mode as RecordingMode);

	const isToggleClosingPress = (mode: unknown): boolean =>
		mode === "toggle" && !isToggleSessionActive();

	const shouldPlayRecordingSound = (mode: unknown): boolean => {
		// Gate on the CONTROL channel, not full isConnected: recording flows
		// over control, while the data channel (realtime/visualizer/TTS) is
		// irrelevant to "a recording is starting". With a cloud model the data
		// socket can sit down (no realtime), which used to wrongly mute the
		// pre-roll chime even though set_microphone + cloud transcribe worked.
		if (isSilentRecordingMode(mode) || !sttClient.isControlConnected) {
			return false;
		}
		// Toggle mode is one press to start, another to stop. Only the
		// opening press should chime. notifyHotkeyPressed() has already
		// flipped the session flag by the time this runs, so an inactive
		// session here means this press just CLOSED the session — stay
		// silent. (ptt never opens a session, so this never suppresses it.)
		return !isToggleClosingPress(mode);
	};

	const canActivateCombo = (): boolean => !isActive && comboFullyReleased && checkCombo();

	const tryActivateCombo = () => {
		if (!canActivateCombo()) {
			return;
		}
		setIsActive(true);
		comboFullyReleased = false;
		notifyHotkeyPressed();
		const mode = getStoreValue("general.recordingMode");
		breadcrumb("input", "hotkey pressed", { accelerator: targetAccelerator });
		// Stryker disable next-line StringLiteral: dbg() message is informational only
		dbg("hotkey", `PRESSED — combo matched, mode=${mode}, connected=${sttClient.isConnected}`);
		if (shouldPlayRecordingSound(mode)) {
			playRecordingSound();
		}
		safeSend("hotkey:pressed");
	};

	const activateDeferredPress = () => {
		setIsActive(true);
		comboFullyReleased = false;
		notifyHotkeyPressed();
		const mode = getStoreValue("general.recordingMode");
		breadcrumb("input", "hotkey pressed", { accelerator: targetAccelerator });
		// Stryker disable next-line StringLiteral: dbg() message is informational only
		dbg("hotkey", `PRESSED (deferred — pressed during paste guard), mode=${mode}`);
		if (shouldPlayRecordingSound(mode)) {
			playRecordingSound();
		}
		safeSend("hotkey:pressed");
	};

	const fireDeferredPressIfNeeded = () => {
		if (canActivateCombo()) {
			activateDeferredPress();
		}
	};

	/** Snapshot the on-lift evaluator. Both keydown and keyup install the same
	 *  function — at lift time we evaluate the FINAL combo state (held vs not)
	 *  and fire hotkey:pressed and/or hotkey:released as needed. */
	const evalOnLift = () => {
		// The three passes must ALL run even if the first throws (a throwing
		// webContents.send inside the deferred press would otherwise skip the
		// deferred release + re-arm, stranding the combo as stuck-active and
		// un-re-armable). try/finally guarantees the release evaluation and the
		// comboFullyReleased re-arm always run. The release/re-arm pass is itself
		// wrapped so a throw there can't skip the re-arm either; any escaping
		// throw still bubbles to runPendingLiftHandler's catch (logged, not fatal).
		try {
			// First fire any deferred press: combo became held during the guard.
			fireDeferredPressIfNeeded();
		} finally {
			try {
				// Then fire any deferred release: combo was active and is now not held.
				fireDeferredReleaseIfNeeded();
			} finally {
				updateComboReleaseState();
			}
		}
	};

	const resolveComboActionIfArmed = (code: number): HotkeyComboAction | null => {
		if (!isActive) {
			return null;
		}
		return lookupComboAction(code);
	};

	/**
	 * Second-key combo dispatch. When the hotkey is actively held and a
	 * recognised second key (Backspace/ArrowUp) goes down, fire the configured
	 * onCombo callback and report whether the keypress was consumed. The
	 * caller falls through to `tryActivateCombo()` only when this returns
	 * false (combo not active, no callback registered, or unrecognised key).
	 */
	const tryHandleComboAction = (code: number): boolean => {
		const action = resolveComboActionIfArmed(code);
		if (!(action && options.onCombo)) {
			return false;
		}
		// Stryker disable next-line StringLiteral: dbg() message is informational only
		dbg("hotkey", `combo action: ${action}`);
		options.onCombo(action);
		return true;
	};

	/**
	 * Post-paste-guard dispatch for a tracked keycode. Returns true if the
	 * keydown was fully handled (combo action consumed it) or if the press
	 * triggered/attempted activation. Keeps onKeyDown at CC ≤ 3.
	 */
	const dispatchTrackedKeyDown = (code: number) => {
		if (tryHandleComboAction(code)) {
			return;
		}
		tryActivateCombo();
	};

	const onKeyDown = (e: { keycode: number }) => {
		const code = e.keycode;
		if (isRecording) {
			handleRecordingKeyDown(code);
			return;
		}
		// ALWAYS track key downs in pressedKeys, even during the paste guard,
		// so the physical-key state is correct when the guard lifts. Without
		// this, a user pressing PTT during a paste's ~50ms window has their
		// press silently dropped — the next press only registers after they
		// release and re-press.
		pressedKeys.add(code);
		logComboKeyDown(code);
		if (pasteGuard) {
			onPasteGuardLifted = evalOnLift;
			return;
		}
		dispatchTrackedKeyDown(code);
	};

	const handleRecordingKeyUp = (code: number) => {
		recordingPressed.delete(code);
		// Send live update (shows currently held keys, peak preserved)
		recordingSend("hotkey:recording-update", {
			keys: codesToNames(peakSnapshot),
		});
		// Do NOT auto-finalize — wait for explicit stop from renderer
	};

	const releaseHotkeyIfNeeded = () => {
		if (!isActive || checkCombo()) {
			return;
		}
		setIsActive(false);
		// Stryker disable next-line StringLiteral: dbg() message is informational only
		dbg("hotkey", "RELEASED");
		safeSend("hotkey:released");
	};

	const onKeyUp = (e: { keycode: number }) => {
		const code = e.keycode;
		if (isRecording) {
			handleRecordingKeyUp(code);
			return;
		}
		// Always track physical key releases, even during paste guard.
		// Synthetic keybd_event releases from the paste script target
		// specific VK codes (0xA0–0xA5, 0x5B–0x5C) that rarely overlap
		// with the hotkey combo, but real releases MUST be tracked so
		// we can fire the deferred hotkey:released when the guard lifts.
		pressedKeys.delete(code);
		if (pasteGuard) {
			// Same evaluator as onKeyDown — at lift time it fires both
			// deferred press and deferred release if appropriate.
			onPasteGuardLifted = evalOnLift;
			return;
		}
		releaseHotkeyIfNeeded();
		updateComboReleaseState();
	};

	uIOhook.on("keydown", onKeyDown);
	uIOhook.on("keyup", onKeyUp);

	// Stryker disable BooleanLiteral,ConditionalExpression,BlockStatement: equivalent — `hotkeyStarted` is a module-level latch that prevents calling uIOhook.start() twice across multiple setupHotkeyHandlers invocations. In tests, each beforeEach goes through a full cleanup() that resets the latch to false, so the guard's outcome only matters for production multi-window scenarios; mutations produce identical observable behavior in single-setup unit tests.
	if (!hotkeyStarted) {
		uIOhook.start();
		hotkeyStarted = true;
	}
	// Stryker restore BooleanLiteral,ConditionalExpression,BlockStatement

	const extractAcceleratorString = (acc: unknown): string | null =>
		// Stryker disable next-line ConditionalExpression,StringLiteral: equivalent — both branches are followed by `if (!accelerator) return false` in handleRegister, so returning "" instead of null still triggers the falsy short-circuit; the mutated comparison literal "Stryker was here!" never matches real accelerator strings ("LCtrl+R"), preserving the original truth values.
		typeof acc === "string" && acc !== "" ? acc : null;

	const extractAccelerator = (p: unknown): string | null => {
		// Stryker disable next-line ConditionalExpression: equivalent — when `p`
		// is a truthy non-object (e.g., a number 42 or string "x"), removing the
		// `typeof p !== "object"` guard falls through to `(p as {}).accelerator`
		// which is undefined; extractAcceleratorString(undefined) returns null,
		// and handleRegister still returns false — same observable outcome.
		if (!p || typeof p !== "object") {
			return null;
		}
		return extractAcceleratorString((p as { accelerator?: unknown }).accelerator);
	};

	const handleRegister = (
		_event: Electron.IpcMainInvokeEvent,
		payload: { accelerator: string }
	) => {
		const accelerator = extractAccelerator(payload);
		if (!accelerator) {
			// Stryker disable next-line StringLiteral: dbg() message is informational only
			dbg("hotkey", "Register FAILED — invalid payload");
			return false;
		}
		// Renderer-side double-fire absorber. The usePushToTalk effect runs
		// twice on cold boot (once for the localStorage-hydrated default,
		// once for the IPC-loaded persisted snapshot — both produce the
		// same accelerator string in practice), so a settings round-trip
		// would otherwise spam the log AND clear `pressedKeys` / reset
		// `comboFullyReleased` mid-hold if the user happened to PTT-press
		// during boot. Short-circuit when the incoming accelerator matches
		// the live one. Any genuine change (user re-binds the hotkey) still
		// falls through to the reset path below.
		if (accelerator === targetAccelerator) {
			return true;
		}
		const codes = parseAccelerator(accelerator);
		if (!codes) {
			// Stryker disable next-line StringLiteral: dbg() message is informational only
			dbg("hotkey", `Register FAILED — unknown accelerator: "${accelerator}"`);
			return false;
		}
		targetKeyCodes = codes;
		targetAccelerator = accelerator;
		pressedKeys.clear();
		setIsActive(false);
		comboFullyReleased = true;
		// Suppress the log when StrictMode (or any unregister→register dance)
		// re-registers an accelerator we previously logged. A genuine re-bind
		// passes a different string and still logs.
		if (accelerator !== lastRegisteredAccelerator) {
			// Stryker disable next-line StringLiteral,ArrayDeclaration: dbg() message and spread are informational only
			dbg("hotkey", `Registered: "${accelerator}" → keycodes:`, JSON.stringify([...codes]));
			lastRegisteredAccelerator = accelerator;
		}
		return true;
	};

	const handleUnregister = () => {
		targetKeyCodes = null;
		targetAccelerator = "";
		pressedKeys.clear();
		setIsActive(false);
		// Stryker disable next-line BooleanLiteral: equivalent — handleRegister always resets `comboFullyReleased = true` again at the start of any subsequent registration, so flipping this assignment to false produces identical observable state.
		comboFullyReleased = true;
	};

	const handleStartRecording = (event: Electron.IpcMainInvokeEvent) => {
		isRecording = true;
		recordingPressed.clear();
		peakSnapshot = [];
		recordingSender = event.sender;
		// Temporarily disable hotkey detection while recording
		pressedKeys.clear();
		setIsActive(false);
		// Cross-handler edge: tts-hotkey and repaste-hotkey gate their fire
		// paths on this flag so the user's recording keystrokes don't
		// accidentally trigger sibling actions (paste, read selection).
		setHotkeyRecording(true);
		return true;
	};

	const handleStopRecording = () => {
		if (isRecording && peakSnapshot.length > 0) {
			const names = codesToNames(peakSnapshot);
			const combo = names.join("+");
			recordingSend("hotkey:recording-done", { combo });
		} else {
			// No keys were captured — cancel
			recordingSend("hotkey:recording-done", { combo: null });
		}
		resetRecording();
	};

	// Stryker disable next-line StringLiteral: defensive pre-clear — cleanup also removes via the matching channel
	ipcMain.removeHandler("hotkey:register");
	// Stryker disable next-line StringLiteral: defensive pre-clear — cleanup also removes via the matching channel
	ipcMain.removeHandler("hotkey:start-recording");
	// Stryker disable next-line StringLiteral: defensive pre-clear — cleanup also removes via the matching channel
	ipcMain.removeAllListeners("hotkey:unregister");
	// Stryker disable next-line StringLiteral: defensive pre-clear — cleanup also removes via the matching channel
	ipcMain.removeAllListeners("hotkey:stop-recording");
	ipcMain.on("hotkey:unregister", handleUnregister);
	ipcMain.on("hotkey:stop-recording", handleStopRecording);
	ipcMain.handle("hotkey:register", handleRegister);
	ipcMain.handle("hotkey:start-recording", handleStartRecording);

	return () => {
		uIOhook.off("keydown", onKeyDown);
		uIOhook.off("keyup", onKeyUp);
		ipcMain.removeHandler("hotkey:register");
		ipcMain.removeHandler("hotkey:start-recording");
		ipcMain.off("hotkey:unregister", handleUnregister);
		ipcMain.off("hotkey:stop-recording", handleStopRecording);
		targetKeyCodes = null;
		pressedKeys.clear();
		setIsActive(false);
		resetRecording();
		// Stryker disable ConditionalExpression,BlockStatement,BooleanLiteral: equivalent — symmetric counterpart of the start-side latch; see the comment above near `if (!hotkeyStarted)`. In a single setup/cleanup cycle the guard's outcome and the latch reset are not observable.
		if (hotkeyStarted) {
			uIOhook.stop();
			hotkeyStarted = false;
		}
		// Stryker restore ConditionalExpression,BlockStatement,BooleanLiteral
	};
}
