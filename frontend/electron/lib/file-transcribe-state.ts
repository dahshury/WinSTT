/**
 * Tiny shared flag: is the file-transcription queue currently busy?
 *
 * "Busy" means at least one file is queued, transcribing, or paused (terminal
 * rows — complete / error / canceled — sitting in the list don't count, so the
 * user can swap models again the moment real work drains).
 *
 * Lives in its own module so the model-swap guard (`stt-commands.ts`) can read
 * it without importing the whole queue orchestrator (`file-transcribe-queue.ts`)
 * — that would be a circular dependency. The queue writes the flag; everything
 * else only reads it. Mirrors the `recording-state.ts` bridge pattern.
 */

let queueBusy = false;

/** Called by the queue orchestrator whenever the busy state changes. */
export function setFileQueueBusy(next: boolean): void {
	queueBusy = next;
}

/**
 * True while the file-transcription queue has work in flight (queued /
 * transcribing / paused). Read by the model-swap handler to block a swap of
 * the shared STT model until the queue drains.
 */
export function isFileQueueBusy(): boolean {
	return queueBusy;
}
