/**
 * Sentence-chunked read-aloud orchestration.
 *
 * A read is synthesized **sentence-by-sentence under one parent requestId** so
 * the renderer's gap-free playback queue plays it as one continuous utterance.
 * Splitting into sentences is what makes the pill's speed control work at
 * natural pitch: each upcoming sentence is (re-)synthesized at the reader's
 * live speed (the server changes tempo without pitch-shifting), so a speed
 * change mid-read takes effect at the **next sentence** — the currently-playing
 * one finishes at its original speed. (A `playbackRate` tweak would be simpler
 * but shifts pitch, which we explicitly don't want.)
 *
 * This module holds only the **pure, side-effect-free** pieces (sentence split,
 * speed-step cycle, the sequential drive loop) so they're unit-testable without
 * a server or AudioContext. The concrete per-sentence synthesis (cloud HTTP /
 * local WS) is injected by `tts.ts`.
 */

// NOTE: the speed-step VALUES + cycle live renderer-side (the pill computes the
// next speed and sends it via `ttsSetSpeed`); this module only sequences the
// read and `tts.ts` clamps the received speed. No speed-cycle logic here.

const DEFAULT_MAX_SENTENCE_LEN = 240;

// Hoisted to module scope (Biome `useTopLevelRegex`): these run per read.
const WHITESPACE_RE = /\s+/;
// Each match: a run of non-terminators + one-or-more terminators (and any
// trailing close-quote/bracket), OR the final un-terminated run.
const SENTENCE_RE = /[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g;

/**
 * Break `long` into ≤`maxLen` pieces on whitespace boundaries (never mid-word
 * unless a single word exceeds `maxLen`, in which case it's hard-split). Keeps
 * one over-long sentence from blocking the whole read on a single synthesis.
 */
function chunkLongSentence(long: string, maxLen: number): string[] {
	const words = long.split(WHITESPACE_RE);
	const out: string[] = [];
	let current = "";
	for (const word of words) {
		const candidate = current ? `${current} ${word}` : word;
		if (candidate.length <= maxLen) {
			current = candidate;
			continue;
		}
		if (current) {
			out.push(current);
		}
		// A single word longer than maxLen is hard-split into maxLen slices.
		if (word.length > maxLen) {
			for (let i = 0; i < word.length; i += maxLen) {
				out.push(word.slice(i, i + maxLen));
			}
			current = "";
		} else {
			current = word;
		}
	}
	if (current) {
		out.push(current);
	}
	return out;
}

/**
 * Split `text` into sentence-sized chunks for sequential synthesis. Splits after
 * sentence-ending punctuation (`. ! ?`, optionally followed by a closing quote/
 * bracket) and caps over-long sentences at `maxLen`. Returns `[]` for blank
 * input. Trailing text with no terminator becomes its own chunk.
 */
export function splitSentences(text: string, maxLen = DEFAULT_MAX_SENTENCE_LEN): string[] {
	const trimmed = text.trim();
	if (!trimmed) {
		return [];
	}
	const rough = trimmed.match(SENTENCE_RE) ?? [trimmed];
	const out: string[] = [];
	for (const piece of rough) {
		const sentence = piece.trim();
		if (!sentence) {
			continue;
		}
		if (sentence.length <= maxLen) {
			out.push(sentence);
		} else {
			out.push(...chunkLongSentence(sentence, maxLen));
		}
	}
	return out;
}

/** Live read state the drive loop polls between sentences. */
export interface SentenceReadControl {
	/** Current speed — read fresh before each sentence so a mid-read change
	 *  applies to the *next* sentence (the playing one finishes at its speed). */
	getSpeed: () => number;
	/** True once the read was cancelled (discard / STT override / superseded). */
	isCancelled: () => boolean;
}

/**
 * Drive a read sequentially: synthesize each sentence (awaiting its audio fully
 * forwarded) before the next, bailing the instant the read is cancelled. Speed
 * is sampled per sentence from `control`. Order is preserved (sentence i's audio
 * is forwarded before i+1's), which is what lets the renderer queue play the
 * whole read gap-free under one requestId.
 */
export async function runSentenceRead(
	text: string,
	synthesizeSentence: (sentence: string, index: number, speed: number) => Promise<void>,
	control: SentenceReadControl
): Promise<void> {
	const sentences = splitSentences(text);
	for (let index = 0; index < sentences.length; index++) {
		if (control.isCancelled()) {
			return;
		}
		const sentence = sentences[index];
		if (sentence) {
			await synthesizeSentence(sentence, index, control.getSpeed());
		}
	}
}
