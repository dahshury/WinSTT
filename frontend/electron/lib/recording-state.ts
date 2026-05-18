import { getStoreValue } from "./store";

/**
 * Bridge between the hotkey module (which knows when the user pressed
 * PTT) and the relay (which sees server-emitted `recording_start` /
 * `recording_stop` events). The relay uses this to tell legitimate
 * starts (the user pressed) apart from stale / duplicate / wakeword-
 * retrigger starts that arrive after the user is done.
 *
 * State machine:
 *   - `signaledIntent`: set when the user presses PTT. Cleared on the
 *     next consumed `recording_start`, or on `recording_stop` if it
 *     never arrived. Single-shot — one press authorises exactly one
 *     server start. This is the PTT model: one press → one recording.
 *   - `toggleSessionActive`: set on the toggle-ON press, cleared on the
 *     toggle-OFF press. While active, EVERY `recording_start` is
 *     authorised — toggle mode is a *continuous* session where the
 *     server auto-stops on silence and auto-restarts on the next
 *     utterance, all under a single user press. Without this, only the
 *     first utterance of a toggle session showed the pill; the 2nd,
 *     3rd, … were rejected as "stale" and the overlay never reappeared.
 *   - `recordingActive`: tracks whether we currently believe a
 *     recording is in flight. Diagnostic / parity with the old model.
 */

let signaledIntent = false;
let recordingActive = false;
let toggleSessionActive = false;

/**
 * Pure predicate: in this mode, does the SERVER own the session lifecycle
 * (loopback / wake-word detector) rather than the hotkey? When true, every
 * `recording_start` is authorised unconditionally.
 */
function isServerDrivenMode(mode: string): boolean {
	return mode === "listen" || mode === "wakeword";
}

/**
 * Called from the hotkey module when the user activates the PTT/toggle
 * combo.
 *
 *   - "ptt": signal single-shot intent (one press → one recording).
 *   - "toggle": the press toggles a *session*. The first press (no
 *     active session) opens it — authorising every `recording_start`
 *     until the user presses again. The second press (session active)
 *     closes it — the server tears down via `set_microphone(false)` and
 *     no further starts are authorised.
 *   - "listen"/"wakeword": hotkey is not involved.
 */
export function notifyHotkeyPressed(): void {
	const mode = getStoreValue("general.recordingMode");
	if (mode === "ptt") {
		signaledIntent = true;
		toggleSessionActive = false;
		return;
	}
	if (mode === "toggle") {
		// The session flag alone authorises every `recording_start` in
		// the session (see consumeRecordingStart). We deliberately do NOT
		// also set `signaledIntent` — that single-shot PTT flag would
		// otherwise leak one authorised start if the user switched to PTT
		// mid-session without pressing toggle-off.
		toggleSessionActive = !toggleSessionActive;
		signaledIntent = false;
		return;
	}
	// listen / wakeword: server-driven, hotkey not involved. Drop any
	// stale toggle session left over from a mode switch.
	toggleSessionActive = false;
}

/**
 * Called by the relay on `recording_start`. Returns true if this start
 * is authorised (legitimate user-initiated, an in-progress toggle
 * session, or always-on listen/wakeword), false if the relay should
 * ignore it (stale / duplicate / wakeword retrigger after the user is
 * done).
 *
 * PTT intent is single-shot: a successful consume clears
 * `signaledIntent`. A toggle session is NOT cleared by consume — it
 * stays open across the silence-driven stop/restart cycles until the
 * user presses to close it.
 */
export function consumeRecordingStart(): boolean {
	const mode = getStoreValue("general.recordingMode");
	const toggleAuthorised = mode === "toggle" && toggleSessionActive;
	const authorised = isServerDrivenMode(mode) || signaledIntent || toggleAuthorised;
	if (!authorised) {
		return false;
	}
	signaledIntent = false;
	recordingActive = true;
	return true;
}

/**
 * Called by the relay on `recording_stop`. Clears the in-flight flag and
 * any single-shot PTT intent, but PRESERVES an open toggle session so
 * the next utterance in the same session is still authorised (the whole
 * point of toggle mode — continuous dictation across natural pauses).
 */
export function notifyRecordingStop(): void {
	recordingActive = false;
	signaledIntent = false;
}

/**
 * True while a toggle-mode session is open — i.e. between the toggle-ON
 * press and the toggle-OFF press. The hotkey module reads this AFTER
 * calling `notifyHotkeyPressed()` to tell the opening press (session now
 * active → play the start cue) apart from the closing press (session now
 * inactive → stay silent; only the first press should chime).
 */
export function isToggleSessionActive(): boolean {
	return toggleSessionActive;
}

/** Diagnostic. */
export function debugRecordingState(): {
	active: boolean;
	pendingIntent: boolean;
	toggleSession: boolean;
} {
	return {
		active: recordingActive,
		pendingIntent: signaledIntent,
		toggleSession: toggleSessionActive,
	};
}

/** Test hook. */
export function __resetRecordingStateForTesting__(): void {
	signaledIntent = false;
	recordingActive = false;
	toggleSessionActive = false;
}
