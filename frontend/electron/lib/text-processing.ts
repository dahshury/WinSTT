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

let cachedDictPatterns: CompiledDictEntry[] = [];
let cachedSnippets: Array<{ trigger: string; expansion: string }> = [];

/** Reference to the electron-store instance, set by initPostProcessing(). */
let _store: typeof StoreType;
let disposeWatchers: (() => void) | null = null;

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
	const next: CompiledDictEntry[] = [];
	for (const entry of dictionary) {
		if (!entry.find) {
			continue;
		}
		const escaped = entry.find.replace(REGEX_ESCAPE_RE, "\\$&");
		const pattern = entry.wholeWord ? `\\b${escaped}\\b` : escaped;
		const flags = entry.caseSensitive ? "g" : "gi";
		next.push({ regex: new RegExp(pattern, flags), replace: entry.replace });
	}
	cachedDictPatterns = next;
}

function rebuildSnippets() {
	const snippets = _store.get("snippets") as
		| Array<{ trigger: string; expansion: string }>
		| undefined;
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
	cachedSnippets = [];
}

/** Apply dictionary replacements and snippet expansions to text. */
export function applyPostProcessing(text: string): string {
	let result = text;

	// Ensure sentence ends with period (if enabled and not already punctuated)
	const addPeriod = getStoreValue("quality.ensureSentenceEndsWithPeriod");
	if (addPeriod && result.length > 0 && !SENTENCE_END_RE.test(result.trimEnd())) {
		result = `${result.trimEnd()}.`;
	}

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
