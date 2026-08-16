import { create } from "zustand";
import type { SentenceSpan } from "../lib/playback-queue";

/**
 * The text of the active read, as the synthesizer received it, plus where each
 * of its sentences has landed on the audio timeline so far.
 *
 * Kept OUT of `useTtsPlaybackStore` on purpose: that store is written from the
 * overlay's per-frame rAF (position/level), while this one changes only when a
 * read starts or a chunk arrives. Splitting them means the script subscribers
 * (the island's text body, which re-renders a whole paragraph) are not woken
 * 60 times a second by a position tick.
 */
interface TtsScriptStore {
	/** Drop the script unconditionally (used by tests and teardown). */
	clear: () => void;
	/**
	 * Drop the script IF it still belongs to `requestId`.
	 *
	 * Synthesis is serialized by the manager's lock but PLAYBACK is not: a second
	 * read can publish its script while the first one's buffered audio is still
	 * draining, so the first read's terminal event must not wipe the script that
	 * has already moved on. An empty id is the wildcard the cancel-all path emits
	 * and always clears.
	 */
	clearFor: (requestId: string) => void;
	/** The read this script belongs to, or `null` when there is none. */
	requestId: string | null;
	/** The final sentences, in synthesis order. Empty for reads with no script
	 *  (voice previews). */
	sentences: string[];
	/** Publish the script for a starting read. */
	setScript: (requestId: string, sentences: string[]) => void;
	/** Mirror the playback queue's per-sentence audio spans after a chunk. */
	setSpans: (spans: SentenceSpan[]) => void;
	/** Audio window of every sentence whose chunks have been decoded. Grows as
	 *  the read streams; empty until the first chunk lands. */
	spans: SentenceSpan[];
}

const EMPTY_SENTENCES: string[] = [];
const EMPTY_SPANS: SentenceSpan[] = [];

export const useTtsScriptStore = create<TtsScriptStore>()((set) => ({
	requestId: null,
	sentences: EMPTY_SENTENCES,
	spans: EMPTY_SPANS,
	setScript: (requestId, sentences) =>
		set({ requestId, sentences, spans: EMPTY_SPANS }),
	// A chunk lands per sentence (or more often), not per frame, so replacing the
	// array outright is cheap. Bail when the span count is unchanged AND the last
	// span's end is identical — the common "another chunk for the sentence we
	// already know about, same audio length" case would otherwise re-render the
	// whole script body for nothing.
	setSpans: (spans) =>
		set((state) => {
			const previous = state.spans;
			if (
				previous.length === spans.length &&
				previous.at(-1)?.end === spans.at(-1)?.end
			) {
				return state;
			}
			return { ...state, spans };
		}),
	clear: () =>
		set({ requestId: null, sentences: EMPTY_SENTENCES, spans: EMPTY_SPANS }),
	clearFor: (requestId) =>
		set((state) =>
			requestId === "" ||
			state.requestId === null ||
			state.requestId === requestId
				? {
						...state,
						requestId: null,
						sentences: EMPTY_SENTENCES,
						spans: EMPTY_SPANS,
					}
				: state,
		),
}));
