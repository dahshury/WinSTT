/**
 * Serialize async tasks into a FIFO chain.
 *
 * Used by the relay's `fullSentence` handling: each utterance's LLM
 * post-processing + paste-enqueue must happen in the order utterances
 * were spoken, even when individual LLM latencies vary. Without
 * serialization, fullSentence2 with a fast LLM would `pasteText` before
 * fullSentence1's slow LLM completes — and the user sees pastes in the
 * wrong order.
 *
 * Errors are swallowed so that one task failing doesn't break the chain
 * for subsequent tasks. Callers should log inside their task if they
 * care about per-task failures.
 */

export interface SerialQueue {
	/** How many tasks are queued (running + waiting). Diagnostic only. */
	depth(): number;
	enqueue(fn: () => Promise<void> | void): void;
}

export function createSerialQueue(): SerialQueue {
	let chain: Promise<void> = Promise.resolve();
	let depth = 0;
	return {
		enqueue(fn: () => Promise<void> | void): void {
			depth += 1;
			chain = chain
				.then(() => fn())
				.catch(() => undefined)
				.finally(() => {
					depth -= 1;
				});
		},
		depth(): number {
			return depth;
		},
	};
}
