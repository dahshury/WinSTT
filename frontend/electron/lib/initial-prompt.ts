/**
 * Pure helpers for composing Whisper's `initial_prompt` from the user's
 * static prefix setting and their dictionary vocab. Deliberately kept
 * separate from `initial-prompt-sync.ts` (which touches electron-store)
 * so this module can be imported directly by bun:test without
 * triggering the electron-mock harness — same pattern as the
 * context-snapshot / context-reader split.
 */

export interface RawDictEntry {
	replacement?: string;
	term?: string;
}

/**
 * Per-prompt cap so a runaway dictionary can't blow past Whisper's
 * decoder context window. Whisper's prompt context window is 224 tokens
 * (half the 448 max_length), or roughly 700–900 chars of English. We
 * cap at 600 to leave room for the user's prefix and for the model's
 * end-of-prompt special token.
 */
const MAX_PROMPT_CHARS = 600;

/**
 * Max number of distinct dictionary vocab terms to fold into the prompt.
 * Wispr Flow's documented ceiling is 200 per session; we pick 100 because
 * Whisper's prompt is decoder context, not an ASR boost list, so excess
 * terms eat into the actual reasoning window. 100 covers every realistic
 * personal-dictionary size while keeping the prompt under
 * {@link MAX_PROMPT_CHARS}.
 */
const MAX_VOCAB_TERMS = 100;

/**
 * Collect the vocab terms from a dictionary array. Filters to non-empty,
 * de-duplicates case-insensitively (preserving the first occurrence's
 * casing), and includes BOTH plain vocab entries and the LHS `term`
 * of replacement pairs — both kinds are mis-transcription targets so
 * priming Whisper with them is equally useful.
 */
interface VocabAccumulator {
	out: string[];
	seen: Set<string>;
}

function trimmedTerm(entry: RawDictEntry): string {
	return typeof entry.term === "string" ? entry.term.trim() : "";
}

function tryAddTerm(entry: RawDictEntry, acc: VocabAccumulator): boolean {
	const term = trimmedTerm(entry);
	if (term.length === 0) {
		return false;
	}
	const key = term.toLowerCase();
	if (acc.seen.has(key)) {
		return false;
	}
	acc.seen.add(key);
	acc.out.push(term);
	return acc.out.length >= MAX_VOCAB_TERMS;
}

function dictionaryIsEmpty(dictionary: readonly RawDictEntry[] | undefined): boolean {
	return !dictionary || dictionary.length === 0;
}

function fillVocab(dictionary: readonly RawDictEntry[], acc: VocabAccumulator): void {
	for (const entry of dictionary) {
		if (tryAddTerm(entry, acc)) {
			return;
		}
	}
}

export function collectDictionaryTerms(dictionary: readonly RawDictEntry[] | undefined): string[] {
	if (dictionaryIsEmpty(dictionary)) {
		return [];
	}
	const acc: VocabAccumulator = { seen: new Set<string>(), out: [] };
	fillVocab(dictionary as readonly RawDictEntry[], acc);
	return acc.out;
}

/**
 * Compose an effective Whisper `initial_prompt` from a user-typed prefix
 * (the legacy ``model.initialPrompt`` setting) and a list of dictionary
 * vocab terms. The shape is what gets passed to Whisper's decoder as
 * prior context — a natural-language hint reading like real text rather
 * than a structured list.
 *
 * Format:
 *   - User prefix on its own line (verbatim, no transformation).
 *   - Followed by "Glossary: t1, t2, t3." when any vocab terms are
 *     present. Plain English sentence shape is what Whisper's training
 *     mix saw most of; a JSON / YAML / bullet list would degrade the
 *     decoder context unnecessarily.
 *   - Empty when neither side has content. Callers MUST treat an empty
 *     string as "do not pass `--initial_prompt`" — server arg builders
 *     do this already via {@link isEmptyStoreValue}.
 *
 * Truncated to {@link MAX_PROMPT_CHARS} bytes from the end so the
 * dictionary glossary survives even when a chatty user prefix would
 * otherwise crowd it out — the vocab is more load-bearing for ASR
 * quality than the freeform prefix.
 */
function clipPrefixOnly(prefix: string): string {
	return prefix.length > MAX_PROMPT_CHARS ? prefix.slice(0, MAX_PROMPT_CHARS) : prefix;
}

function joinPrefixWithGlossary(prefix: string, glossary: string): string {
	return prefix.length === 0 ? glossary : `${prefix}\n\n${glossary}`;
}

function clipOversizedGlossary(glossary: string): string {
	const tail = glossary.slice(0, MAX_PROMPT_CHARS);
	const lastComma = tail.lastIndexOf(",");
	return lastComma === -1 ? tail : `${tail.slice(0, lastComma)}.`;
}

function clipPrefixToFitGlossary(prefix: string, glossary: string): string {
	const room = MAX_PROMPT_CHARS - glossary.length - 2; // "\n\n"
	return `${prefix.slice(0, room)}\n\n${glossary}`;
}

function fitComposedWithinCap(prefix: string, glossary: string, composed: string): string {
	if (composed.length <= MAX_PROMPT_CHARS) {
		return composed;
	}
	// Truncate from the start of the prefix (keep the glossary intact —
	// it's the higher-signal piece). When the glossary itself exceeds the
	// cap, fall back to clipping the glossary's TAIL so we always end on
	// a complete term.
	if (glossary.length > MAX_PROMPT_CHARS) {
		return clipOversizedGlossary(glossary);
	}
	return clipPrefixToFitGlossary(prefix, glossary);
}

export function composeInitialPrompt(userPrefix: string, dictTerms: readonly string[]): string {
	const prefix = userPrefix.trim();
	if (dictTerms.length === 0) {
		return clipPrefixOnly(prefix);
	}
	const glossary = `Glossary: ${dictTerms.join(", ")}.`;
	const composed = joinPrefixWithGlossary(prefix, glossary);
	return fitComposedWithinCap(prefix, glossary, composed);
}

/**
 * Build the composed pair given the three inputs. The realtime variant
 * uses its own user-prefix slot but the SAME dictionary terms — the
 * live preview benefits from the bias too, otherwise users see "oh
 * llama" in the floating pill before the cleanup LLM rewrites it to
 * "Ollama".
 */
export function buildInitialPromptPair(input: {
	dictionary: readonly RawDictEntry[] | undefined;
	mainPrefix: string;
	realtimePrefix: string;
}): { main: string; realtime: string } {
	const dictTerms = collectDictionaryTerms(input.dictionary);
	return {
		main: composeInitialPrompt(input.mainPrefix, dictTerms),
		realtime: composeInitialPrompt(input.realtimePrefix, dictTerms),
	};
}
