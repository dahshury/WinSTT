import { buildTranscriptDiff } from "@/shared/lib/transcript-diff";
import type { TranscriptionHistoryEntry } from "../model/history-store";

/**
 * Lowercase word tokens across scripts. Keeps intra-word apostrophes/hyphens
 * (so "don't"/"voice-to-text" stay whole) but strips surrounding punctuation.
 * Unicode-aware so it works for non-Latin transcripts too.
 */
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

export function tokenizeWords(text: string): string[] {
	return text.toLowerCase().match(WORD_RE) ?? [];
}

/**
 * Common English function words excluded from the "catchphrase" so it surfaces
 * a distinctive word ("should") rather than the unavoidable top filler ("the").
 * The plain "most used word" tile keeps these in.
 */
const STOPWORDS = new Set([
	"a",
	"about",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"but",
	"by",
	"can",
	"did",
	"do",
	"for",
	"from",
	"had",
	"has",
	"have",
	"he",
	"her",
	"his",
	"i",
	"if",
	"in",
	"is",
	"it",
	"its",
	"just",
	"like",
	"me",
	"my",
	"no",
	"not",
	"of",
	"off",
	"ok",
	"okay",
	"on",
	"or",
	"our",
	"out",
	"so",
	"that",
	"the",
	"their",
	"them",
	"then",
	"they",
	"this",
	"to",
	"uh",
	"um",
	"up",
	"was",
	"we",
	"were",
	"what",
	"when",
	"will",
	"with",
	"would",
	"yeah",
	"yes",
	"you",
	"your",
]);

export interface WordCount {
	count: number;
	word: string;
}

export interface PeakTime {
	count: number;
	dayOfWeek: number;
	hour: number;
}

export interface VoiceProfileStats {
	catchphrase: WordCount | null;
	mostCorrectedWord: WordCount | null;
	mostUsedWord: WordCount | null;
	peakTime: PeakTime | null;
}

/**
 * Highest-count entry of a frequency map. Ties resolve to the first word that
 * reached the count (Map iteration is insertion order) — deterministic for a
 * given input. `skip` drops words from consideration (used for stopwords).
 */
function topWord(
	counts: Map<string, number>,
	skip?: ReadonlySet<string>,
): WordCount | null {
	let best: WordCount | null = null;
	for (const [word, count] of counts) {
		if (skip?.has(word)) {
			continue;
		}
		if (best === null || count > best.count) {
			best = { count, word };
		}
	}
	return best;
}

function bump(counts: Map<string, number>, key: string): void {
	counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * One-pass voice profile over the (already date-filtered) history:
 *   - mostUsedWord / catchphrase — word frequencies across the final text.
 *   - mostCorrectedWord — words the AI rewrote, tallied from the raw→final diff
 *     (the `before` side of every replace/delete hunk). Only AI-touched entries
 *     run the diff, so this stays cheap.
 *   - peakTime — the busiest (weekday, hour) bucket by local time.
 * Every field is `null` when there's no signal, so the UI can show a dash.
 */
export function computeVoiceProfile(
	entries: TranscriptionHistoryEntry[],
): VoiceProfileStats {
	const wordCounts = new Map<string, number>();
	const correctedCounts = new Map<string, number>();
	const timeCounts = new Map<string, PeakTime>();

	for (const entry of entries) {
		for (const word of tokenizeWords(entry.text)) {
			bump(wordCounts, word);
		}

		if (
			typeof entry.originalText === "string" &&
			entry.originalText.length > 0
		) {
			const diff = buildTranscriptDiff(entry.originalText, entry.text);
			if (diff !== null) {
				for (const change of diff.changes) {
					// `before` is the word the user actually said/ASR produced that the
					// AI had to fix; empty on a pure insert, which we skip.
					for (const word of tokenizeWords(change.before)) {
						bump(correctedCounts, word);
					}
				}
			}
		}

		const date = new Date(entry.timestamp);
		const dayOfWeek = date.getDay();
		const hour = date.getHours();
		const key = `${dayOfWeek}-${hour}`;
		const current = timeCounts.get(key);
		if (current === undefined) {
			timeCounts.set(key, { count: 1, dayOfWeek, hour });
		} else {
			current.count += 1;
		}
	}

	let peakTime: PeakTime | null = null;
	for (const bucket of timeCounts.values()) {
		if (peakTime === null || bucket.count > peakTime.count) {
			peakTime = bucket;
		}
	}

	return {
		catchphrase: topWord(wordCounts, STOPWORDS),
		mostCorrectedWord: topWord(correctedCounts),
		mostUsedWord: topWord(wordCounts),
		peakTime,
	};
}
