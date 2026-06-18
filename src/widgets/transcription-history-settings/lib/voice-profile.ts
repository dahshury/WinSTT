import type { TranscriptionHistoryEntry } from "../model/history-store";
import { getEntryTranscriptDiff } from "./transcript-diff-cache";

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
 * Common English function words ("the", "and", "you", …) excluded from every
 * word tile. Without this filter the "most used" and "most corrected" tiles
 * just surface the unavoidable top filler ("the"), which tells the user
 * nothing — so all three word tiles skip these and report a distinctive word.
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

const voiceProfileCache = new WeakMap<
	TranscriptionHistoryEntry[],
	VoiceProfileStats
>();

/**
 * The `limit` highest-count entries of a frequency map, descending. `skip`
 * drops words from consideration (stopwords). Ties resolve to the word that
 * reached the count first: `Array.prototype.sort` is stable and the map
 * iterates in insertion order, so the result is deterministic for a given
 * input. Returns fewer than `limit` entries when there aren't enough words.
 */
function topWords(
	counts: Map<string, number>,
	limit: number,
	skip?: ReadonlySet<string>,
): WordCount[] {
	const candidates: WordCount[] = [];
	for (const [word, count] of counts) {
		if (skip?.has(word)) {
			continue;
		}
		candidates.push({ count, word });
	}
	candidates.sort((a, b) => b.count - a.count);
	return candidates.slice(0, limit);
}

function bump(counts: Map<string, number>, key: string): void {
	counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * One-pass voice profile over the (already date-filtered) history:
 *   - mostUsedWord / catchphrase — the top two distinctive words across the
 *     final text (stopwords filtered, so "the" never wins). The catchphrase is
 *     the runner-up, keeping the two tiles from showing the same word.
 *   - mostCorrectedWord — the word the AI rewrote most, tallied from the
 *     raw→final diff (the `before` side of every replace/delete hunk), again
 *     skipping stopwords. Only AI-touched entries run the diff, so this stays
 *     cheap.
 *   - peakTime — the busiest (weekday, hour) bucket by local time.
 * Every field is `null` when there's no signal, so the UI can show a dash.
 */
export function computeVoiceProfile(
	entries: TranscriptionHistoryEntry[],
): VoiceProfileStats {
	const cached = voiceProfileCache.get(entries);
	if (cached) {
		return cached;
	}

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
			const diff = getEntryTranscriptDiff(entry);
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

	// Top two distinctive words: [0] is "most used", [1] is the "catchphrase"
	// runner-up — so the two tiles never collapse onto the same word.
	const [mostUsedWord = null, catchphrase = null] = topWords(
		wordCounts,
		2,
		STOPWORDS,
	);
	const [mostCorrectedWord = null] = topWords(correctedCounts, 1, STOPWORDS);

	const stats = {
		catchphrase,
		mostCorrectedWord,
		mostUsedWord,
		peakTime,
	};
	voiceProfileCache.set(entries, stats);
	return stats;
}
