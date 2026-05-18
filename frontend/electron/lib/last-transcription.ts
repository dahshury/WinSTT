/**
 * Single-slot memory of the most recent dictation transcription.
 *
 * `relay.ts` records the final (post-LLM / post-processing) text here at the
 * same point it auto-pastes it into the focused window. The exclusive
 * re-paste global shortcut (`repaste-hotkey.ts`) reads it back so the user
 * can re-inject the last transcript on demand without re-dictating.
 *
 * Deliberately a single slot, not the full transcription-history store: the
 * shortcut's contract is "paste the thing you just dictated", and history
 * persistence (electron-store) is a heavier, separately-owned concern.
 */

let lastTranscription = "";

/**
 * Remember `text` as the most recent transcription. Whitespace-only / empty
 * input is ignored so a "no audio detected" pass can't blank the slot — the
 * user still wants the previous real transcript re-pastable.
 */
export function setLastTranscription(text: string): void {
	if (text.trim() === "") {
		return;
	}
	lastTranscription = text;
}

/** The last recorded transcription, or "" when nothing has been dictated yet. */
export function getLastTranscription(): string {
	return lastTranscription;
}

/** Test hook: clear the slot so each test starts from a known empty state. */
export function __resetLastTranscriptionForTesting__(): void {
	lastTranscription = "";
}
