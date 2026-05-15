import type { store as StoreType } from "./store";
import { getStoreValue } from "./store";

const SENTENCE_END_RE = /[.!?]$/;
const REGEX_ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

// ── Cached post-processing patterns ──────────────────────────────────
// Re-compiled only when the underlying store data changes (via onDidChange).

interface CompiledDictEntry {
	regex: RegExp;
	replace: string;
}

// Stryker disable next-line ArrayDeclaration: equivalent — module-level initial value is always replaced by initPostProcessing() before applyPostProcessing() is observable.
let cachedDictPatterns: CompiledDictEntry[] = [];
// Stryker disable next-line ArrayDeclaration: equivalent — same as cachedDictPatterns above.
let cachedSnippets: Array<{ trigger: string; expansion: string }> = [];

/** Reference to the electron-store instance, set by initPostProcessing(). */
let _store: typeof StoreType;
let disposeWatchers: (() => void) | null = null;

function buildDictPattern(escaped: string, wholeWord?: boolean): string {
	return wholeWord ? `\\b${escaped}\\b` : escaped;
}

function dictRegexFlags(caseSensitive?: boolean): string {
	return caseSensitive ? "g" : "gi";
}

function compileDictEntry(entry: {
	find: string;
	replace: string;
	caseSensitive?: boolean;
	wholeWord?: boolean;
}): CompiledDictEntry | null {
	if (!entry.find) {
		return null;
	}
	const escaped = entry.find.replace(REGEX_ESCAPE_RE, "\\$&");
	const pattern = buildDictPattern(escaped, entry.wholeWord);
	const flags = dictRegexFlags(entry.caseSensitive);
	// react-doctor-disable-next-line js-hoist-regexp
	return { regex: new RegExp(pattern, flags), replace: entry.replace };
}

function rebuildDictPatterns() {
	const dictionary = _store.get("dictionary") as
		| Array<{ find: string; replace: string; caseSensitive?: boolean; wholeWord?: boolean }>
		| undefined;
	// Note: dictionary/snippets are arrays with complex shapes — validated at
	// the settings-save boundary. The `as` cast here is acceptable because
	// the store defaults guarantee the correct shape.
	if (!dictionary?.length) {
		cachedDictPatterns = [];
		return;
	}
	const compiled: Array<CompiledDictEntry | null> = dictionary.map(compileDictEntry);
	cachedDictPatterns = compiled.filter((e): e is CompiledDictEntry => e !== null);
}

function rebuildSnippets() {
	const snippets = _store.get("snippets") as
		| Array<{ trigger: string; expansion: string }>
		| undefined;
	// Stryker disable next-line ArrayDeclaration: equivalent — when no snippets, fallback shape is empty; mutating to ["Stryker was here"] yields entries with no `.trigger` so applyPostProcessing's loop is observably a no-op either way.
	cachedSnippets = snippets?.filter((e) => e.trigger) ?? [];
}

/**
 * Initialize post-processing: build caches and register store change listeners.
 * Must be called once at startup before applyPostProcessing() is used.
 */
export function initPostProcessing(storeInstance: typeof StoreType): void {
	// Clean up any previous watchers (e.g. if called again after window recreation)
	disposeWatchers?.();

	_store = storeInstance;

	// Build on startup
	rebuildDictPatterns();
	rebuildSnippets();

	// Rebuild when store changes — capture dispose functions for cleanup
	const disposeDictWatcher = _store.onDidChange("dictionary", rebuildDictPatterns);
	const disposeSnippetWatcher = _store.onDidChange("snippets", rebuildSnippets);

	disposeWatchers = () => {
		disposeDictWatcher();
		disposeSnippetWatcher();
	};
}

/**
 * Clean up store watchers registered by initPostProcessing.
 */
export function cleanupPostProcessing(): void {
	disposeWatchers?.();
	disposeWatchers = null;
	cachedDictPatterns = [];
	// Stryker disable next-line ArrayDeclaration: equivalent — same reasoning as the rebuildSnippets fallback above; ["Stryker was here"] entries have no `.trigger` so applyPostProcessing's loop is a no-op.
	cachedSnippets = [];
}

/** Returns true when `text` is non-empty and lacks a trailing `.`, `!`, or `?`. */
function needsTerminalPeriod(text: string): boolean {
	return text.length > 0 && !SENTENCE_END_RE.test(text.trimEnd());
}

/** Ensure text ends with a period if the setting is enabled and punctuation is missing. */
function maybePunctuate(text: string): string {
	const addPeriod = getStoreValue("quality.ensureSentenceEndsWithPeriod");
	if (addPeriod && needsTerminalPeriod(text)) {
		return `${text.trimEnd()}.`;
	}
	return text;
}

/** Apply dictionary replacements and snippet expansions to text. */
export function applyPostProcessing(text: string): string {
	let result = maybePunctuate(text);

	// Dictionary replacements (pre-compiled regexes)
	for (const entry of cachedDictPatterns) {
		entry.regex.lastIndex = 0;
		result = result.replace(entry.regex, entry.replace);
	}

	// Snippet expansions
	for (const entry of cachedSnippets) {
		result = result.replaceAll(entry.trigger, entry.expansion);
	}

	return result;
}
