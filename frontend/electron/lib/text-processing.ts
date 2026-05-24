import {
	buildPhoneticTerm,
	type PhoneticTerm,
	replaceWithDictionary,
	replaceWithSnippets,
} from "../../src/shared/lib/fuzzy-match";
import type { store as StoreType } from "./store";
import { getStoreValue } from "./store";

const SENTENCE_END_RE = /[.!?]$/;

interface RawDictEntry {
	replacement?: string;
	term?: string;
}
interface RawSnippetEntry {
	expansion?: string;
	trigger?: string;
}

/** A replacement pair derived from a dictionary entry whose `replacement`
 *  field is set. Mirrors Wispr Flow's misspelling→correction shape. */
export interface ReplacementPair {
	replacement: string;
	term: string;
}

// Phonetic codes are precomputed once per dictionary change so each
// transcription call doesn't re-hash every term. Same caching strategy for
// snippets (whose triggers are tokenized + metaphone'd per match). The
// replacement-pair cache mirrors the dictionary cache and is rebuilt by
// the same store-change listener — entries with `replacement` set move to
// `cachedReplacementPairs` and never appear in `cachedDictTerms` (so the
// fuzzy matcher never tries to canonicalize an intentional misspelling).
let cachedDictTerms: PhoneticTerm[] = [];
let cachedReplacementPairs: ReplacementPair[] = [];
let cachedSnippets: Array<{ trigger: string; expansion: string }> = [];

let _store: typeof StoreType;
let disposeWatchers: (() => void) | null = null;

function rebuildDictTerms() {
	const dictionary = _store.get("dictionary") as RawDictEntry[] | undefined;
	if (!dictionary?.length) {
		cachedDictTerms = [];
		cachedReplacementPairs = [];
		return;
	}
	const vocab: PhoneticTerm[] = [];
	const pairs: ReplacementPair[] = [];
	for (const e of dictionary) {
		const term = typeof e.term === "string" ? e.term.trim() : "";
		if (term.length === 0) {
			continue;
		}
		const replacement = typeof e.replacement === "string" ? e.replacement.trim() : "";
		if (replacement.length > 0) {
			pairs.push({ term, replacement });
		} else {
			vocab.push(buildPhoneticTerm(term));
		}
	}
	cachedDictTerms = vocab;
	cachedReplacementPairs = pairs;
}

function rebuildSnippets() {
	const snippets = _store.get("snippets") as RawSnippetEntry[] | undefined;
	cachedSnippets =
		snippets?.filter((e): e is { trigger: string; expansion: string } =>
			Boolean(e.trigger && e.expansion)
		) ?? [];
}

/**
 * Initialize post-processing: build caches and register store change listeners.
 * Must be called once at startup before applyPostProcessing() is used.
 */
export function initPostProcessing(storeInstance: typeof StoreType): void {
	disposeWatchers?.();

	_store = storeInstance;

	rebuildDictTerms();
	rebuildSnippets();

	const disposeDictWatcher = _store.onDidChange("dictionary", rebuildDictTerms);
	const disposeSnippetWatcher = _store.onDidChange("snippets", rebuildSnippets);

	disposeWatchers = () => {
		disposeDictWatcher();
		disposeSnippetWatcher();
	};
}

/** Clean up store watchers registered by initPostProcessing. */
export function cleanupPostProcessing(): void {
	disposeWatchers?.();
	disposeWatchers = null;
	cachedDictTerms = [];
	cachedReplacementPairs = [];
	cachedSnippets = [];
}

function needsTerminalPeriod(text: string): boolean {
	return text.length > 0 && !SENTENCE_END_RE.test(text.trimEnd());
}

function maybePunctuate(text: string): string {
	const addPeriod = getStoreValue("quality.ensureSentenceEndsWithPeriod");
	if (addPeriod && needsTerminalPeriod(text)) {
		return `${text.trimEnd()}.`;
	}
	return text;
}

/**
 * Escape every regex metachar in a string so it can be embedded as a
 * literal inside a RegExp. We hand-craft the pattern (vs. e.g. lodash's
 * `escapeRegExp`) to keep the dependency footprint of this hot path zero.
 */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Apply user-managed replacement pairs to the cleaned transcription as a
 * case-insensitive whole-word string replace. `term` is the mis-transcription
 * to find; `replacement` is the literal replacement string (case is preserved
 * verbatim from `replacement`, NOT inferred from the matched text). Wispr
 * Flow uses the same semantics — see project memory's reference to its
 * dictionary "replacement pair" mode.
 *
 * Whole-word matching uses `\b` boundaries so `"git"` → `"Git"` doesn't
 * touch `"github"` or `"digital"`. Entries are applied in user-defined
 * order so a later pair can override an earlier one if the user wants
 * cascading rules.
 *
 * Exported so the LLM cleanup path (electron/ipc/llm.ts) can apply the
 * pairs AFTER the model returns — the deterministic safety net Wispr Flow
 * relies on to guarantee the corrections fire regardless of what the LLM
 * actually produced.
 */
export function applyReplacementPairs(
	text: string,
	pairs: readonly ReplacementPair[] = cachedReplacementPairs
): string {
	if (!text || pairs.length === 0) {
		return text;
	}
	let out = text;
	for (const { term, replacement } of pairs) {
		const escaped = escapeRegExp(term);
		// `\b` anchors avoid touching identifiers / substrings; the `gi`
		// flags make it case-insensitive global (one find replaces every
		// matching occurrence regardless of the user's chosen casing).
		const re = new RegExp(`\\b${escaped}\\b`, "gi");
		out = out.replace(re, replacement);
	}
	return out;
}

/**
 * Apply fuzzy dictionary corrections, fuzzy snippet expansions, the
 * user's replacement pairs, and the optional terminal-period rule to a
 * transcription. Order matters:
 *
 *   1. Punctuate (terminal period rule).
 *   2. Fuzzy dictionary — canonicalises near-miss spellings to the
 *      user's vocab list.
 *   3. Replacement pairs — deterministic find-and-replace, runs on the
 *      already-canonicalised text so a vocab fix can chain into a
 *      replacement.
 *   4. Fuzzy snippets — phrase-level expansions, which need step 3 to
 *      have run first so a trigger like `"my email"` matches even if
 *      the user dictated `"my e-mail"` and a replacement pair handled
 *      the dash.
 */
export function applyPostProcessing(text: string): string {
	let result = maybePunctuate(text);
	result = replaceWithDictionary(result, cachedDictTerms);
	result = applyReplacementPairs(result, cachedReplacementPairs);
	result = replaceWithSnippets(result, cachedSnippets);
	return result;
}

/**
 * Expose the current caches for the LLM-prompt builder: when the dictation
 * LLM is configured we fold these into the system prompt instead of running
 * the algorithmic pass, so the LLM can apply them context-aware. The LLM
 * cleanup also calls `applyReplacementPairs` on its output as a safety net
 * — see processText in electron/ipc/llm.ts.
 */
export function getPostProcessingVocab(): {
	dictionary: readonly string[];
	replacementPairs: readonly ReplacementPair[];
	snippets: readonly { trigger: string; expansion: string }[];
} {
	return {
		dictionary: cachedDictTerms.map((t) => t.canonical),
		replacementPairs: cachedReplacementPairs,
		snippets: cachedSnippets,
	};
}
