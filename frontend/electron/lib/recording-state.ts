import { getStoreValue } from "./store";

/**
 * Bridge between the hotkey module (which knows when the user pressed
 * PTT) and the relay (which sees server-emitted `recording_start` /
 * `recording_stop` events). The relay uses this to tell legitimate
 * starts (the user pressed) apart from stale / duplicate / wakeword-
 * retrigger starts that arrive after the user is done.
 *
 * State machine:
 *   - `signaledIntent`: set when the user presses PTT (or starts a
 *     toggle cycle). Cleared on the next consumed `recording_start`,
 *     or on `recording_stop` if it never arrived. Single-shot — one
 *     press authorises exactly one server start.
 *   - `recordingActive`: tracks whether we currently believe a
 *     recording is in flight. Used in toggle mode to distinguish the
 *     first press ("start") from the second ("stop") — only the
 *     start-press sets intent.
 */

let signaledIntent = false;
let recordingActive = false;

/**
 * Pure predicate: does a hotkey press in this mode (with the given
 * in-flight recording state) authorise the NEXT `recording_start`?
 *
 *   - "ptt"    → yes (always; held-down press signals intent unconditionally)
 *   - "toggle" → only when no recording is currently in flight; the
 *                second press of a toggle cycle is the "stop press" and
 *                MUST NOT refresh intent (a stray duplicate start
 *                arriving later would otherwise sneak through)
 *   - "listen" → no (hotkey is not involved in listen mode)
 *
 * Extracted from `notifyHotkeyPressed` to keep its cyclomatic complexity
 * low (single boolean check instead of two nested `if`s + `&&`).
 */
function shouldSignalIntent(mode: string, recording: boolean): boolean {
	return mode === "ptt" || (mode === "toggle" && !recording);
}

/**
 * Called from the hotkey module when the user activates the PTT/toggle
 * combo. Signals that the next server `recording_start` is legitimate.
 */
export function notifyHotkeyPressed(): void {
	const mode = getStoreValue("general.recordingMode");
	if (shouldSignalIntent(mode, recordingActive)) {
		signaledIntent = true;
	}
	// Listen mode doesn't use the hotkey for recording.
}

/**
 * Called by the relay on `recording_start`. Returns true if this start
 * is authorised (legitimate user-initiated or always-on listen mode),
 * false if the relay should ignore it (stale / duplicate / wakeword
 * retrigger after the user is done).
 *
 * Single-shot: a successful consume clears `signaledIntent`. The next
 * `recording_start` will only be honoured after another hotkey press
 * (or a stop + new press).
 */
export function consumeRecordingStart(): boolean {
	const mode = getStoreValue("general.recordingMode");
	if (mode === "listen") {
		recordingActive = true;
		return true;
	}
	if (signaledIntent) {
		signaledIntent = false;
		recordingActive = true;
		return true;
	}
	return false;
}

/**
 * Called by the relay on `recording_stop`. Clears any stale intent and
 * marks the recording as ended.
 */
export function notifyRecordingStop(): void {
	recordingActive = false;
	signaledIntent = false;
}

/** Diagnostic. */
export function debugRecordingState(): { active: boolean; pendingIntent: boolean } {
	return { active: recordingActive, pendingIntent: signaledIntent };
}

/** Test hook. */
export function __resetRecordingStateForTesting__(): void {
	signaledIntent = false;
	recordingActive = false;
}
