import {
	buildPhoneticTerm,
	type PhoneticTerm,
	replaceWithDictionary,
	replaceWithSnippets,
} from "../../src/features/text-post-processing/lib/fuzzy-match";
import type { store as StoreType } from "./store";
import { getStoreValue } from "./store";

const SENTENCE_END_RE = /[.!?]$/;

interface RawDictEntry {
	term?: string;
}
interface RawSnippetEntry {
	expansion?: string;
	trigger?: string;
}

// Phonetic codes are precomputed once per dictionary change so each
// transcription call doesn't re-hash every term. Same caching strategy for
// snippets (whose triggers are tokenized + metaphone'd per match).
let cachedDictTerms: PhoneticTerm[] = [];
let cachedSnippets: Array<{ trigger: string; expansion: string }> = [];

let _store: typeof StoreType;
let disposeWatchers: (() => void) | null = null;

function rebuildDictTerms() {
	const dictionary = _store.get("dictionary") as RawDictEntry[] | undefined;
	if (!dictionary?.length) {
		cachedDictTerms = [];
		return;
	}
	cachedDictTerms = dictionary
		.map((e) =>
			typeof e.term === "string" && e.term.length > 0 ? buildPhoneticTerm(e.term) : null
		)
		.filter((e): e is PhoneticTerm => e !== null);
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
 * Apply fuzzy dictionary corrections, fuzzy snippet expansions, and the
 * optional terminal-period rule to a transcription. Dictionary runs first
 * so its canonical-cased outputs feed into the snippet trigger matcher.
 */
export function applyPostProcessing(text: string): string {
	let result = maybePunctuate(text);
	result = replaceWithDictionary(result, cachedDictTerms);
	result = replaceWithSnippets(result, cachedSnippets);
	return result;
}

/**
 * Expose the current caches for the LLM-prompt builder: when the dictation
 * LLM is configured we fold these into the system prompt instead of running
 * the algorithmic pass, so the LLM can apply them context-aware.
 */
export function getPostProcessingVocab(): {
	dictionary: readonly string[];
	snippets: readonly { trigger: string; expansion: string }[];
} {
	return {
		dictionary: cachedDictTerms.map((t) => t.canonical),
		snippets: cachedSnippets,
	};
}
