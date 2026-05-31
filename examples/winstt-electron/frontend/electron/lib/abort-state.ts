/**
 * Single-bit "the user just cancelled the current dictation session" flag.
 *
 * Why this exists separately from `recording-state.ts`:
 *
 *   - `recording-state.ts` tracks whether a hotkey press has consumed a
 *     `recording_start` yet. That's about ignoring stale / duplicate start
 *     events.
 *   - This module tracks whether the user pressed `hotkey + Backspace` to
 *     cancel — and therefore whether the relay should silently drop every
 *     downstream event (realtime captions, fullSentence, paste, history,
 *     LLM cleanup) for the current session.
 *
 * The two flags are orthogonal: a session can be active-and-not-cancelled,
 * active-and-cancelled (user hit backspace mid-stream), or idle.
 *
 * Why the gate is needed even though `recorder.abort()` and
 * `abortActiveOllamaChats()` both fire on cancel:
 *
 *   1. The server-side recorder cannot interrupt a transcribe() call that
 *      is already executing inside the ONNX runtime. If the user cancels
 *      after recording_stop but before transcription completes, the
 *      fullSentence event WILL still arrive at the renderer.
 *   2. When `processWithOllama` catches its own AbortError it returns the
 *      input text unchanged (so a model-swap-triggered abort can fall back
 *      cleanly). Without this flag, the relay's `handleFullSentence` would
 *      see `{ ok: false, text: original }` and happily paste it.
 *
 * So this gate is the defensive safety net: even if a late fullSentence
 * slips through or the LLM swallows its own abort, no text gets pasted,
 * no entry hits the history store, and no caption reaches the renderer.
 *
 * The flag is cleared on the next `recording_start` so a fresh session
 * (the user holding the hotkey again) starts clean.
 */

// Stryker disable next-line BooleanLiteral: initial value is overwritten by mark/clear before any observer reads it
let sessionAborted = false;

export function markSessionAborted(): void {
	sessionAborted = true;
}

export function clearSessionAborted(): void {
	sessionAborted = false;
}

export function isSessionAborted(): boolean {
	return sessionAborted;
}
