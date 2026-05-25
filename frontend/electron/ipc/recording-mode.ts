/**
 * Process-wide "user is recording a new hotkey" flag.
 *
 * Why this exists: three independent listeners observe physical keys —
 *   - `hotkey.ts`        (uiohook, push-to-talk)
 *   - `tts-hotkey.ts`    (uiohook, TTS read-selection combo)
 *   - `repaste-hotkey.ts` (Electron globalShortcut, exclusive re-paste)
 *
 * When the user starts recording a NEW combo in the UI, only the listener
 * whose `hotkey:start-recording` IPC fires actually pauses itself. The other
 * two keep firing, so pressing e.g. the current re-paste combo while recording
 * the dictation hotkey would also paste the last transcription mid-recording.
 *
 * This module is the cross-handler edge: any handler that enters recording
 * mode calls `setHotkeyRecording(true)`, and every handler short-circuits its
 * firing path while `isAnyHotkeyRecording()` is true. The Electron-side
 * globalShortcut for re-paste cannot be passively gated (Electron swallows
 * the accelerator before any JS runs), so it subscribes to the edge via
 * `onHotkeyRecordingChange` and unregisters/re-registers itself.
 *
 * Edge-only emission keeps repaste's unregister/register cycle bounded: we
 * only fire the listener when the boolean actually flips.
 */

type Listener = (recording: boolean) => void;

let recording = false;
const listeners = new Set<Listener>();

export function isAnyHotkeyRecording(): boolean {
	return recording;
}

function notifyListener(listener: Listener, active: boolean): void {
	try {
		listener(active);
	} catch {
		// A misbehaving subscriber must not break the others.
	}
}

export function setHotkeyRecording(active: boolean): void {
	if (recording === active) {
		return;
	}
	recording = active;
	for (const listener of listeners) {
		notifyListener(listener, active);
	}
}

/** Subscribe to recording-mode edges. Returns an unsubscribe. */
export function onHotkeyRecordingChange(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Test-only escape hatch: drop all subscribers + reset the flag. */
export function _resetHotkeyRecordingState(): void {
	recording = false;
	listeners.clear();
}
