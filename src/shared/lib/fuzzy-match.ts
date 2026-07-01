import { doubleMetaphone } from "double-metaphone";

// Words are letters/digits/apostrophes. Punctuation is intentionally excluded
// so it stays in the surrounding text when a fuzzy match replaces a span —
// e.g. "address." stays as match("address") + literal ".".
const WORD_RE = /[\p{L}\p{N}']+/gu;

// Jaro inner state: per-character match flags and the running match count.
// Kept as a single object so the per-character match helper can mutate it
// without leaking the flag arrays back into the parent scope.
interface JaroMatchState {
	aMatches: boolean[];
	bMatches: boolean[];
	matches: number;
}

function createJaroMatchState(aLen: number, bLen: number): JaroMatchState {
	return {
		aMatches: new Array(aLen).fill(false),
		bMatches: new Array(bLen).fill(false),
		matches: 0,
	};
}

// Either string is empty → Jaro is 0 by definition. Predicate-only helper so
// the early-out chain in `jaro` stays flat.
function eitherEmpty(a: string, b: string): boolean {
	return a.length === 0 || b.length === 0;
}

// Symmetric match-window radius from the Jaro paper:
// `floor(max(|a|, |b|) / 2) - 1`, clamped to ≥ 0.
function jaroMatchWindow(a: string, b: string): number {
	return Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
}

// True iff `b[j]` is still available AND its character matches `a[i]`. Lifted
// out of the inner loop so the loop body is a plain "if hit then record".
function isUnmatchedEquivalent(
	a: string,
	b: string,
	i: number,
	j: number,
	state: JaroMatchState,
) {
	return !state.bMatches[j] && a[i] === b[j];
}

function recordMatch(state: JaroMatchState, i: number, j: number): void {
	state.aMatches[i] = true;
	state.bMatches[j] = true;
}

// Try to match `a[i]` to any unmatched `b[j]` inside the symmetric window
// `[i - matchWindow, i + matchWindow]`. Returns true on a hit, in which case
// `state` has been mutated to record the pair.
function tryMatchAtIndex(
	a: string,
	b: string,
	i: number,
	matchWindow: number,
	state: JaroMatchState,
): boolean {
	const start = Math.max(0, i - matchWindow);
	const end = Math.min(b.length, i + matchWindow + 1);
	for (let j = start; j < end; j++) {
		if (isUnmatchedEquivalent(a, b, i, j, state)) {
			recordMatch(state, i, j);
			return true;
		}
	}
	return false;
}

// Phase 1 of Jaro: count matched characters within the match window.
function countJaroMatches(
	a: string,
	b: string,
	matchWindow: number,
): JaroMatchState {
	const state = createJaroMatchState(a.length, b.length);
	for (let i = 0; i < a.length; i++) {
		if (tryMatchAtIndex(a, b, i, matchWindow, state)) {
			state.matches++;
		}
	}
	return state;
}

// Walk `bMatches` forward from `k` until we land on a matched index. Used by
// `countJaroTranspositions` to step through `b`'s matched positions in lockstep
// with `a`'s matched positions.
function advanceToNextMatchedB(
	bMatches: readonly boolean[],
	k: number,
): number {
	let cursor = k;
	while (!bMatches[cursor]) {
		cursor++;
	}
	return cursor;
}

// Single transposition tick: returns 1 if the matched a-character at `i`
// disagrees with the next matched b-character, 0 otherwise. Extracted so the
// loop body in `countJaroTranspositions` is just sum-and-step.
function transpositionDelta(
	a: string,
	b: string,
	i: number,
	k: number,
): number {
	return a[i] === b[k] ? 0 : 1;
}

// Phase 2 of Jaro: count half-transpositions between the matched characters
// (walked in order on both strings). The Jaro formula divides this by two.
function countJaroTranspositions(
	a: string,
	b: string,
	state: JaroMatchState,
): number {
	let k = 0;
	let transpositions = 0;
	for (let i = 0; i < a.length; i++) {
		if (!state.aMatches[i]) {
			continue;
		}
		k = advanceToNextMatchedB(state.bMatches, k);
		transpositions += transpositionDelta(a, b, i, k);
		k++;
	}
	return transpositions / 2;
}

// Combine the Jaro counters into the final 0..1 similarity score per the
// canonical formula `(m/|a| + m/|b| + (m - t)/m) / 3`.
function jaroFormula(
	aLen: number,
	bLen: number,
	matches: number,
	transpositions: number,
): number {
	return (
		(matches / aLen + matches / bLen + (matches - transpositions) / matches) / 3
	);
}

// Trivial Jaro values that don't require the two-phase match/transposition
// scan. Returns the answer when one applies, otherwise `null` to signal "run
// the full algorithm".
function trivialJaro(a: string, b: string): number | null {
	if (a === b) {
		return 1;
	}
	if (eitherEmpty(a, b)) {
		return 0;
	}
	return null;
}

// Standard Jaro similarity. Returns 0..1.
function jaro(a: string, b: string): number {
	const trivial = trivialJaro(a, b);
	if (trivial !== null) {
		return trivial;
	}
	const state = countJaroMatches(a, b, jaroMatchWindow(a, b));
	if (state.matches === 0) {
		return 0;
	}
	const transpositions = countJaroTranspositions(a, b, state);
	return jaroFormula(a.length, b.length, state.matches, transpositions);
}

// Length of the shared character prefix, capped at 4 per the Jaro-Winkler
// definition. Extracted so `jaroWinkler` stays at a clean "guard + score" CC.
function sharedPrefixLength(a: string, b: string): number {
	const maxPrefix = Math.min(4, a.length, b.length);
	for (let i = 0; i < maxPrefix; i++) {
		if (a[i] !== b[i]) {
			return i;
		}
	}
	return maxPrefix;
}

// Jaro-Winkler with the standard 0.1 prefix scale on up-to-4-char shared prefix.
// Boost only kicks in above the 0.7 Jaro floor — below that the strings are too
// dissimilar for a prefix match to be meaningful.
export function jaroWinkler(a: string, b: string): number {
	const j = jaro(a, b);
	if (j < 0.7) {
		return j;
	}
	const prefix = sharedPrefixLength(a, b);
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

// True iff non-empty `key` equals either slot of the candidate pair `b`. Empty
// keys never overlap (double-metaphone returns "" for unmappable input).
function keyMatchesPair(key: string, b: readonly [string, string]): boolean {
	if (!key) {
		return false;
	}
	return key === b[0] || key === b[1];
}

function phoneticOverlap(
	a: readonly [string, string],
	b: readonly [string, string],
): boolean {
	return keyMatchesPair(a[0], b) || keyMatchesPair(a[1], b);
}

export const DICTIONARY_JW_THRESHOLD = 0.88;
export const DICTIONARY_PHONETIC_JW_THRESHOLD = 0.8;
export const SNIPPET_JW_THRESHOLD = 0.92;

// Whether a `jw` score (with optional phonetic confirmation) clears the
// dictionary acceptance bar. Split out so `bestDictionaryMatch`'s loop body
// reads as "score → does it pass → keep if better".
function passesDictionaryThreshold(jw: number, phoneticHit: boolean): boolean {
	if (jw >= DICTIONARY_JW_THRESHOLD) {
		return true;
	}
	return phoneticHit && jw >= DICTIONARY_PHONETIC_JW_THRESHOLD;
}

// Mutable running winner. A tiny struct avoids two parallel `let` variables in
// the outer reducer (one of the CC sources in the original implementation).
interface DictionaryCandidate {
	canonical: string | null;
	score: number;
}

// Score a single candidate term against the query word and either keep or
// discard it. Returns the (possibly updated) running winner.
function considerDictionaryTerm(
	lower: string,
	wordMp: readonly [string, string],
	term: PhoneticTerm,
	current: DictionaryCandidate,
): DictionaryCandidate {
	const jw = jaroWinkler(lower, term.lower);
	if (jw <= current.score) {
		return current;
	}
	if (!passesDictionaryThreshold(jw, phoneticOverlap(wordMp, term.mp))) {
		return current;
	}
	return { canonical: term.canonical, score: jw };
}

// Scan every term and keep the best one that passes the threshold gate.
function reduceDictionaryBest(
	lower: string,
	wordMp: readonly [string, string],
	terms: readonly PhoneticTerm[],
): string | null {
	let current: DictionaryCandidate = { canonical: null, score: 0 };
	for (const t of terms) {
		current = considerDictionaryTerm(lower, wordMp, t, current);
	}
	return current.canonical;
}

// First pass: case-insensitive exact match — canonical form wins so casing
// snaps to the user's preferred spelling. Returns null when no entry matches.
function exactDictionaryMatch(
	lower: string,
	terms: readonly PhoneticTerm[],
): string | null {
	const exact = terms.find((t) => t.lower === lower);
	return exact ? exact.canonical : null;
}

// Inputs that cannot possibly yield a match: empty term list or empty word.
// Pulled out so `bestDictionaryMatch` skips its own guard branch.
function hasNoMatchableInput(
	word: string,
	terms: readonly PhoneticTerm[],
): boolean {
	return terms.length === 0 || word.length === 0;
}

/**
 * Find the best dictionary term for a single transcribed word, or null if no
 * candidate clears the threshold. An exact (case-insensitive) match short-
 * circuits — we still return the canonical entry so casing snaps to the
 * user's preferred form. Otherwise: a JW above 0.88 wins outright; a JW
 * above 0.80 paired with a phonetic overlap wins by phonetic confirmation.
 */
export function bestDictionaryMatch(
	word: string,
	terms: readonly PhoneticTerm[],
): string | null {
	if (hasNoMatchableInput(word, terms)) {
		return null;
	}
	const lower = word.toLowerCase();
	const exact = exactDictionaryMatch(lower, terms);
	if (exact !== null) {
		return exact;
	}
	const [mp1, mp2] = doubleMetaphone(lower);
	return reduceDictionaryBest(lower, [mp1, mp2], terms);
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

// Pre-computed trigger context shared across every window evaluated by
// `findSnippetMatches`. Building it once avoids re-tokenizing/re-hashing the
// trigger inside the sliding-window loop.
interface TriggerContext {
	joined: string;
	mp: readonly [string, string];
	words: readonly string[];
}

function buildTriggerContext(tWords: readonly string[]): TriggerContext {
	return {
		joined: tWords.join(" "),
		mp: doubleMetaphone(tWords.join("")) as [string, string],
		words: tWords,
	};
}

// A candidate sliding window distilled to the inputs the fuzzy gates need.
// Computing the joined text and lowercase words once per window keeps the
// per-window evaluator simple.
interface SnippetWindow {
	joined: string;
	matches: readonly RegExpMatchArray[];
	mp: readonly [string, string];
}

function buildSnippetWindow(
	matches: readonly RegExpMatchArray[],
): SnippetWindow {
	const words = matches.map((m) => m[0].toLowerCase());
	return {
		joined: words.join(" "),
		matches,
		mp: doubleMetaphone(words.join("")) as [string, string],
	};
}

// True iff the window passes both fuzzy gates against the trigger context:
// the JW threshold AND a phonetic overlap. Either gate alone is too noisy
// (JW alone matches "cool" → "cold"; metaphone alone matches "see" → "sea").
function windowMatchesTrigger(
	window: SnippetWindow,
	trigger: TriggerContext,
): boolean {
	if (jaroWinkler(window.joined, trigger.joined) < SNIPPET_JW_THRESHOLD) {
		return false;
	}
	return phoneticOverlap(window.mp, trigger.mp);
}

// Compute the [start, end) span for a fuzzy-matched window, or null when the
// underlying RegExpMatchArray entries are missing index info (defensive — the
// global `u` flag guarantees `.index`, but the optional typing requires the
// guard).
function snippetSpan(
	matches: readonly RegExpMatchArray[],
): { end: number; start: number } | null {
	const first = matches[0];
	const last = matches.at(-1);
	if (first?.index === undefined || last?.index === undefined) {
		return null;
	}
	return { start: first.index, end: last.index + last[0].length };
}

// Index where the window starting at `i` begins inside `text`. Returns -1 if
// the first match is missing (defensive). Equivalent to the original
// `(first?.index ?? -1)` expression.
function windowStartIndex(
	wordMatches: readonly RegExpMatchArray[],
	i: number,
): number {
	return wordMatches[i]?.index ?? -1;
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
	expansion: string,
): readonly SnippetMatch[] {
	const tWords = triggerWords(trigger);
	const wordMatches = Array.from(text.matchAll(WORD_RE));
	if (tWords.length === 0 || wordMatches.length < tWords.length) {
		return [];
	}
	return collectSnippetMatches(
		buildTriggerContext(tWords),
		wordMatches,
		expansion,
	);
}

// Slide a fixed-width window across `wordMatches`, emit non-overlapping spans
// that pass the fuzzy + phonetic gates.
function collectSnippetMatches(
	trigger: TriggerContext,
	wordMatches: readonly RegExpMatchArray[],
	expansion: string,
): SnippetMatch[] {
	const results: SnippetMatch[] = [];
	const span = wordMatches.length - trigger.words.length;
	let cursor = 0;
	for (let i = 0; i <= span; i++) {
		const next = tryMatchAtWindow(i, trigger, wordMatches, expansion, cursor);
		if (next === null) {
			continue;
		}
		results.push(next);
		cursor = next.end;
	}
	return results;
}

// Per-iteration handler for `collectSnippetMatches`. Skips the window if it
// overlaps the previous accepted match (preserves left-to-right non-overlap)
// or fails the fuzzy gates; otherwise returns the new SnippetMatch.
function tryMatchAtWindow(
	i: number,
	trigger: TriggerContext,
	wordMatches: readonly RegExpMatchArray[],
	expansion: string,
	cursor: number,
): SnippetMatch | null {
	if (windowStartIndex(wordMatches, i) < cursor) {
		return null;
	}
	const slice = wordMatches.slice(i, i + trigger.words.length);
	return nextSnippetMatch(slice, trigger, expansion);
}

// Evaluate a single sliding window: returns the SnippetMatch if it passes the
// gates, otherwise null. Wraps the window-build + gate-check + span-extract
// sequence so `collectSnippetMatches` is one for-loop body deep.
function nextSnippetMatch(
	matches: readonly RegExpMatchArray[],
	trigger: TriggerContext,
	expansion: string,
): SnippetMatch | null {
	const window = buildSnippetWindow(matches);
	if (!windowMatchesTrigger(window, trigger)) {
		return null;
	}
	const span = snippetSpan(matches);
	return span ? { start: span.start, end: span.end, expansion } : null;
}

/**
 * Replace each fuzzy-matched word in `text` with the canonical dictionary
 * term, leaving surrounding whitespace and punctuation intact. Operates word-
 * by-word; multi-word terms are out of scope for the single-column model.
 */
export function replaceWithDictionary(
	text: string,
	terms: readonly PhoneticTerm[],
): string {
	if (terms.length === 0) {
		return text;
	}
	return text.replace(
		WORD_RE,
		(word) => bestDictionaryMatch(word, terms) ?? word,
	);
}

// Splice the matches into `text` right-to-left so earlier indices remain
// valid as later spans are replaced. Defensive `!m` guard preserves behavior
// for the (impossible) sparse-array case.
function applySnippetMatchesReverse(
	text: string,
	matches: readonly SnippetMatch[],
): string {
	let result = text;
	for (let i = matches.length - 1; i >= 0; i--) {
		const m = matches[i];
		if (!m) {
			continue;
		}
		result = result.slice(0, m.start) + m.expansion + result.slice(m.end);
	}
	return result;
}

// Apply one snippet's matches to `text`, returning the (possibly unchanged)
// result. No-op when the trigger has zero matches.
function applySnippet(
	text: string,
	snip: { trigger: string; expansion: string },
): string {
	const matches = findSnippetMatches(text, snip.trigger, snip.expansion);
	return matches.length === 0
		? text
		: applySnippetMatchesReverse(text, matches);
}

/**
 * Apply every snippet's fuzzy trigger in order, splicing the expansion in
 * place of each matched word-span. Surrounding punctuation stays put because
 * matches end at word boundaries.
 */
export function replaceWithSnippets(
	text: string,
	snippets: readonly { trigger: string; expansion: string }[],
): string {
	let result = text;
	for (const snip of snippets) {
		result = applySnippet(result, snip);
	}
	return result;
}
