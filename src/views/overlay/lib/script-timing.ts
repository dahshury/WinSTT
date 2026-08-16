/**
 * Turns a read-aloud script (`tts:script` sentences) plus the playback queue's
 * per-sentence audio spans into word-level timings, so the overlay island can
 * sweep a highlight across the text as it is spoken — the same karaoke read the
 * History tab gives a recorded transcript.
 *
 * Deliberately NOT a forced alignment. History playback can afford one (the WAV
 * already exists, and a tiny Whisper aligns it off the hot path); a read-aloud
 * is streaming and must highlight the FIRST sentence before the last one has
 * even been synthesized. What we have instead is exact per-SENTENCE boundaries —
 * the manager renders one sentence per `synthesize_stream` call and stamps every
 * chunk with its index — so each sentence's window is precise and only the word
 * split inside it is estimated. Errors therefore reset at every sentence instead
 * of accumulating across the read.
 */

import type { SentenceSpan } from "./playback-queue";

/** One rendered token of the script, with its estimated audio window. */
export interface ScriptToken {
	/** Media seconds at which this token stops being the active one; `null`
	 *  while its sentence has no audio yet. */
	end: number | null;
	/** Position in the flat token list — the value {@link activeTokenIndex}
	 *  returns and the renderer keys on. */
	index: number;
	/** Index of the sentence this token came from (its `tts:script` position). */
	sentenceIndex: number;
	/** Media seconds at which this token becomes the active one; `null` while
	 *  its sentence has no audio yet. */
	start: number | null;
	/**
	 * True for a token shaped like an inline paralinguistic tag (`<laugh>`,
	 * `[sigh]`). Purely presentational — tags DO consume synthesis time, so they
	 * keep their slot in the timing distribution and can be the active token;
	 * they are just rendered as the delivery directions they are rather than as
	 * words. Both shipped tag syntaxes are matched because the vocabulary is
	 * per-engine (see the TTS catalog's `tagSyntax`).
	 */
	tag: boolean;
	text: string;
}

/**
 * A token's share of its sentence's audio. Character count is the workhorse —
 * longer words take longer to say — and the `+1` floor keeps a one-letter word
 * ("a", "I") from collapsing to a zero-length flash as the highlight passes it.
 */
function tokenWeight(text: string): number {
	return text.length + 1;
}

const TAG_SHAPED = /^[<[][^\s<>[\]]+[>\]][.,!?;:]?$/;

/** Split one sentence into whitespace-separated tokens, dropping the empties a
 *  leading/trailing/double space would otherwise produce. */
function tokenizeSentence(sentence: string): string[] {
	return sentence.split(/\s+/).filter((token) => token.length > 0);
}

/**
 * Build the flat token list for `sentences`, timing every token whose sentence
 * already has buffered audio in `spans`.
 *
 * Tokens from sentences that are still synthesizing are returned UNTIMED
 * (`start`/`end` `null`) rather than omitted: the island shows the whole script
 * from the moment the pill appears, and the untimed tail simply stays in its
 * "not spoken yet" style until its audio lands.
 */
export function buildScriptTokens(
	sentences: readonly string[],
	spans: readonly SentenceSpan[],
): ScriptToken[] {
	const spanByIndex = new Map(spans.map((span) => [span.index, span]));
	const tokens: ScriptToken[] = [];
	for (const [sentenceIndex, sentence] of sentences.entries()) {
		const texts = tokenizeSentence(sentence);
		if (texts.length === 0) {
			continue;
		}
		const span = spanByIndex.get(sentenceIndex);
		const total = texts.reduce((sum, text) => sum + tokenWeight(text), 0);
		// `span.end - span.start` is the sentence's real audio length; dividing it
		// by the weight total converts "share of the characters" into seconds.
		const perWeight =
			span && total > 0 ? (span.end - span.start) / total : null;
		let cursor = span?.start ?? 0;
		for (const text of texts) {
			const width = perWeight === null ? 0 : perWeight * tokenWeight(text);
			tokens.push({
				index: tokens.length,
				sentenceIndex,
				text,
				tag: TAG_SHAPED.test(text),
				start: perWeight === null ? null : cursor,
				end: perWeight === null ? null : cursor + width,
			});
			cursor += width;
		}
	}
	return tokens;
}

/**
 * The token under the playhead at `currentTime`, or `-1` when playback has not
 * reached the first timed token (or nothing is timed yet).
 *
 * Binary search over the timed prefix: tokens are emitted in playback order, and
 * every untimed token sits after every timed one (audio arrives sentence by
 * sentence), so the timed tokens form a sorted prefix.
 *
 * The playhead is allowed to sit slightly PAST the last timed token — the queue
 * clamps its clock to the buffered end, so between one sentence draining and the
 * next one arriving the last spoken word stays lit rather than blinking off.
 */
export function activeTokenIndex(
	tokens: readonly ScriptToken[],
	currentTime: number,
): number {
	let low = 0;
	let high = tokens.length - 1;
	let found = -1;
	while (low <= high) {
		const mid = (low + high) >>> 1;
		const token = tokens[mid];
		if (token?.start == null || token.start > currentTime) {
			high = mid - 1;
			continue;
		}
		found = mid;
		low = mid + 1;
	}
	return found;
}
