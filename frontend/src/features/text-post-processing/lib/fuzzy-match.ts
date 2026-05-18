import { doubleMetaphone } from "double-metaphone";

// Words are letters/digits/apostrophes. Punctuation is intentionally excluded
// so it stays in the surrounding text when a fuzzy match replaces a span —
// e.g. "address." stays as match("address") + literal ".".
const WORD_RE = /[\p{L}\p{N}']+/gu;

// Standard Jaro similarity. Returns 0..1.
function jaro(a: string, b: string): number {
	if (a === b) {
		return 1;
	}
	if (a.length === 0 || b.length === 0) {
		return 0;
	}
	const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
	const aMatches: boolean[] = new Array(a.length).fill(false);
	const bMatches: boolean[] = new Array(b.length).fill(false);
	let matches = 0;
	for (let i = 0; i < a.length; i++) {
		const start = Math.max(0, i - matchWindow);
		const end = Math.min(b.length, i + matchWindow + 1);
		for (let j = start; j < end; j++) {
			if (bMatches[j] || a[i] !== b[j]) {
				continue;
			}
			aMatches[i] = true;
			bMatches[j] = true;
			matches++;
			break;
		}
	}
	if (matches === 0) {
		return 0;
	}
	let k = 0;
	let transpositions = 0;
	for (let i = 0; i < a.length; i++) {
		if (!aMatches[i]) {
			continue;
		}
		while (!bMatches[k]) {
			k++;
		}
		if (a[i] !== b[k]) {
			transpositions++;
		}
		k++;
	}
	transpositions /= 2;
	return (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;
}

// Jaro-Winkler with the standard 0.1 prefix scale on up-to-4-char shared prefix.
// Boost only kicks in above the 0.7 Jaro floor — below that the strings are too
// dissimilar for a prefix match to be meaningful.
export function jaroWinkler(a: string, b: string): number {
	const j = jaro(a, b);
	if (j < 0.7) {
		return j;
	}
	let prefix = 0;
	const maxPrefix = Math.min(4, a.length, b.length);
	for (let i = 0; i < maxPrefix; i++) {
		if (a[i] !== b[i]) {
			break;
		}
		prefix++;
	}
	return j + prefix * 0.1 * (1 - j);
}

export interface PhoneticTerm {
	canonical: string;
	lower: string;
	mp: readonly [string, string];
}

export function buildPhoneticTerm(term: string): PhoneticTerm {
	const lower = term.toLowerCase();
	const [mp1, mp2] = doubleMetaphone(lower);
	return { canonical: term, lower, mp: [mp1, mp2] };
}

function phoneticOverlap(a: readonly [string, string], b: readonly [string, string]): boolean {
	return Boolean(
		(a[0] && (a[0] === b[0] || a[0] === b[1])) || (a[1] && (a[1] === b[0] || a[1] === b[1]))
	);
}

export const DICTIONARY_JW_THRESHOLD = 0.88;
export const DICTIONARY_PHONETIC_JW_THRESHOLD = 0.8;
export const SNIPPET_JW_THRESHOLD = 0.92;

/**
 * Find the best dictionary term for a single transcribed word, or null if no
 * candidate clears the threshold. An exact (case-insensitive) match short-
 * circuits — we still return the canonical entry so casing snaps to the
 * user's preferred form. Otherwise: a JW above 0.88 wins outright; a JW
 * above 0.80 paired with a phonetic overlap wins by phonetic confirmation.
 */
export function bestDictionaryMatch(word: string, terms: readonly PhoneticTerm[]): string | null {
	if (terms.length === 0 || word.length === 0) {
		return null;
	}
	const lower = word.toLowerCase();
	const exact = terms.find((t) => t.lower === lower);
	if (exact) {
		return exact.canonical;
	}
	const [mp1, mp2] = doubleMetaphone(lower);
	const wordMp: readonly [string, string] = [mp1, mp2];
	let bestScore = 0;
	let best: string | null = null;
	for (const t of terms) {
		const jw = jaroWinkler(lower, t.lower);
		const phon = phoneticOverlap(wordMp, t.mp);
		const passes =
			jw >= DICTIONARY_JW_THRESHOLD || (phon && jw >= DICTIONARY_PHONETIC_JW_THRESHOLD);
		if (passes && jw > bestScore) {
			bestScore = jw;
			best = t.canonical;
		}
	}
	return best;
}

export interface SnippetMatch {
	end: number;
	expansion: string;
	start: number;
}

/**
 * Tokenize a trigger string into lowercase words. Used to fix the sliding-
 * window size when scanning a transcript for fuzzy occurrences. Punctuation
 * is dropped — by design, since Whisper rarely inserts punctuation inside a
 * phrase but the user may type the trigger naturally.
 */
function triggerWords(trigger: string): string[] {
	const matches = trigger.toLowerCase().match(WORD_RE);
	return matches ? Array.from(matches) : [];
}

/**
 * Find the non-overlapping fuzzy occurrences of a snippet trigger in `text`,
 * returned in order. Each match's [start, end) span covers exactly the words
 * that matched — any punctuation immediately before/after stays outside, so
 * the caller can splice the expansion in without disturbing surrounding
 * punctuation (matches the "preserve surrounding punctuation" requirement).
 */
export function findSnippetMatches(
	text: string,
	trigger: string,
	expansion: string
): readonly SnippetMatch[] {
	const tWords = triggerWords(trigger);
	if (tWords.length === 0) {
		return [];
	}
	const triggerJoined = tWords.join(" ");
	const triggerMpJoined = doubleMetaphone(tWords.join("")) as [string, string];

	const wordMatches = Array.from(text.matchAll(WORD_RE));
	if (wordMatches.length < tWords.length) {
		return [];
	}

	const results: SnippetMatch[] = [];
	let cursor = 0;
	for (let i = 0; i <= wordMatches.length - tWords.length; i++) {
		const first = wordMatches[i];
		if ((first?.index ?? -1) < cursor) {
			continue;
		}
		const windowMatches = wordMatches.slice(i, i + tWords.length);
		const windowWords = windowMatches.map((m) => m[0].toLowerCase());
		const windowJoined = windowWords.join(" ");
		const jw = jaroWinkler(windowJoined, triggerJoined);
		if (jw < SNIPPET_JW_THRESHOLD) {
			continue;
		}
		const windowMp = doubleMetaphone(windowWords.join("")) as [string, string];
		if (!phoneticOverlap(windowMp, triggerMpJoined)) {
			continue;
		}
		const last = windowMatches.at(-1);
		const firstIdx = first?.index;
		const lastIdx = last?.index;
		if (firstIdx === undefined || last === undefined || lastIdx === undefined) {
			continue;
		}
		const start = firstIdx;
		const end = lastIdx + last[0].length;
		results.push({ start, end, expansion });
		cursor = end;
	}
	return results;
}

/**
 * Replace each fuzzy-matched word in `text` with the canonical dictionary
 * term, leaving surrounding whitespace and punctuation intact. Operates word-
 * by-word; multi-word terms are out of scope for the single-column model.
 */
export function replaceWithDictionary(text: string, terms: readonly PhoneticTerm[]): string {
	if (terms.length === 0) {
		return text;
	}
	return text.replace(WORD_RE, (word) => bestDictionaryMatch(word, terms) ?? word);
}

/**
 * Apply every snippet's fuzzy trigger in order, splicing the expansion in
 * place of each matched word-span. Surrounding punctuation stays put because
 * matches end at word boundaries.
 */
export function replaceWithSnippets(
	text: string,
	snippets: readonly { trigger: string; expansion: string }[]
): string {
	let result = text;
	for (const snip of snippets) {
		const matches = findSnippetMatches(result, snip.trigger, snip.expansion);
		if (matches.length === 0) {
			continue;
		}
		// Apply right-to-left so earlier indices stay valid after splicing.
		for (let i = matches.length - 1; i >= 0; i--) {
			const m = matches[i];
			if (!m) {
				continue;
			}
			result = result.slice(0, m.start) + m.expansion + result.slice(m.end);
		}
	}
	return result;
}
