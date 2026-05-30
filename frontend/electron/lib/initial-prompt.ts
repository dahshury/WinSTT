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
 * Per-utterance hard cap on the dynamic context tail — the sanitised text
 * immediately before the user's caret (captured via UIA when
 * `general.contextAwareness` is on). It's the highest-signal slice (Whisper
 * was trained to condition on prior text), but length is a double constraint:
 *
 *   1. Whisper's prompt is hard-capped BY THE MODEL at 224 tokens
 *      (= n_text_ctx//2 - 1; n_text_ctx=448) ≈ ~150 words / ~900 chars of
 *      English. Anything past that is silently dropped from the HEAD — so
 *      feeding "the whole email" can't even reach the decoder, only its last
 *      ~224 tokens would. The whole document is the LLM's job, not Whisper's:
 *      Whisper never "reads" it, it only biases token probabilities toward the
 *      prior text's spelling/casing/style.
 *   2. A long, topical prompt tips the SMALL models (we ship whisper-tiny-q4
 *      as the offline base) into regurgitating the prompt verbatim on short /
 *      quiet audio (see memory/project_context_prompt_poisons_whisper.md).
 *
 * 500 chars (~125 tokens, ~90 words) is the sweet spot: ~half the model
 * ceiling, ~80% of {@link MAX_PROMPT_CHARS}, enough to prime the proper nouns
 * / terms the user is about to dictate (the reply draft + the closing of the
 * quoted email) without handing tiny Whisper a long block to parrot. The slice
 * is denoised + descrollbacked upstream, so the old NOISE-poisoning risk is
 * already gone — this cap governs LENGTH only. Bumped 250→500 (2026-05-30)
 * once the tail was reliably clean. It must still NOT crowd out the static
 * prefix + glossary, so composeInitialPrompt clips the tail's FRONT to fit
 * {@link MAX_PROMPT_CHARS} when those are present.
 */
const MAX_CONTEXT_TAIL_CHARS = 500;

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
	if (lastComma === -1) {
		// No comma in the first MAX_PROMPT_CHARS chars — a single dictionary
		// term is itself oversized. Hard-cut at the cap and terminate the
		// sentence so the prompt stays well-formed (matches the comma branch's
		// trailing period) and never exceeds the budget.
		return `${tail.slice(0, MAX_PROMPT_CHARS - 1)}.`;
	}
	return `${tail.slice(0, lastComma)}.`;
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

/**
 * Characters that only ever appear as terminal/TUI/web-app decorative
 * chrome. They carry no prior-text signal and, fed to Whisper in bulk,
 * tip the smaller models into repetition / charset-drift hallucination
 * — a captured terminal of box-drawing rules made whisper-tiny emit
 * "✿✿✿…"/"ñoñoño…", and a YouTube search full of `￼` made it emit a
 * literal "￼" (both reproduced offline by feeding real app captures as
 * prompts against a known clip on whisper-tiny; see
 * memory/project_context_prompt_poisons_whisper.md).
 *
 * Filtered by Unicode CATEGORY, NOT "non-ASCII": real scripts (Arabic,
 * Chinese, Hindi, …) are letters (\p{L}) and survive, so non-English
 * dictation keeps its prior-text bias. Removed:
 *   - \p{C}            control / format / surrogate / private-use
 *   - \p{So}           "other symbols" — the whole decorative-glyph
 *                      class in one shot: box-drawing, block elements,
 *                      geometric shapes, dingbats, arrows, most emoji,
 *                      AND U+FFFC ￼ (object-replacement, the dominant
 *                      web-app noise: every image/icon/avatar) + U+FFFD.
 *   - U+2022/2023/2043 bullet punctuation (•, ‣, ⁃ — category Po, so
 *                      not covered by \p{So}; leaked "•" into output).
 *   - U+1F000–U+1FAFF  emoji incl. skin-tone modifiers (\p{Sk}, not So).
 * KEPT on purpose: \p{Sm} math ops ( + = < > | ~ ), \p{Sc} currency,
 * \p{Sk} ( ^ ` ), and all punctuation (— … ' " ` · / @ # %) — they carry
 * real signal when dictating into a code editor / prose field, which is
 * the feature's primary use case.
 */
const CONTEXT_NOISE_RE = /[\p{C}\p{So}•‣⁃\u{1F000}-\u{1FAFF}]/gu;

/**
 * Drop decorative/control noise (see {@link CONTEXT_NOISE_RE}), collapse
 * newlines/runs of whitespace into single spaces, and clip to
 * {@link MAX_CONTEXT_TAIL_CHARS}, keeping the LAST n chars (the slice
 * closest to the caret is the most relevant prior-text signal). Noise is
 * replaced with a space (not elided) so stripping a glyph between two
 * words can't fuse them into one token. When the cap bites we also drop a
 * leading PARTIAL word so the prompt starts on a clean token boundary
 * ("…e of me afford" → "of me afford") — Whisper conditions better on whole
 * tokens. Guarded against a single oversized word (no internal space), where
 * snapping would gut the tail.
 */
export function sanitiseContextTail(rawTail: string): string {
	const denoised = rawTail.replace(CONTEXT_NOISE_RE, " ");
	const collapsed = denoised.replace(/\s+/g, " ").trim();
	if (collapsed.length <= MAX_CONTEXT_TAIL_CHARS) {
		return collapsed;
	}
	const tail = collapsed.slice(collapsed.length - MAX_CONTEXT_TAIL_CHARS);
	const firstSpace = tail.indexOf(" ");
	return firstSpace > 0 && firstSpace < tail.length - 1 ? tail.slice(firstSpace + 1) : tail;
}

function joinContextWithBody(contextTail: string, body: string): string {
	if (contextTail.length === 0) {
		return body;
	}
	if (body.length === 0) {
		return contextTail;
	}
	return `${contextTail}\n\n${body}`;
}

function composeBody(prefix: string, dictTerms: readonly string[]): string {
	if (dictTerms.length === 0) {
		return clipPrefixOnly(prefix);
	}
	const glossary = `Glossary: ${dictTerms.join(", ")}.`;
	const composed = joinPrefixWithGlossary(prefix, glossary);
	return fitComposedWithinCap(prefix, glossary, composed);
}

/**
 * Compose the final Whisper prompt from the three input tiers:
 *
 *   1. `contextTail` — per-utterance prior-text snippet from the UIA
 *      capture (highest signal; Whisper conditions on it as prior speech).
 *      Capped at {@link MAX_CONTEXT_TAIL_CHARS} *before* concat so it
 *      can never drown out the glossary.
 *   2. `userPrefix`  — static user-typed prefix from settings.
 *   3. `dictTerms`   — user dictionary vocab, rendered as a glossary.
 *
 * Layout (each tier separated by a blank line, missing tiers elided):
 *
 *   <context>
 *
 *   <prefix>
 *
 *   Glossary: t1, t2, t3.
 *
 * Empty when all three are empty.
 */
export function composeInitialPrompt(
	userPrefix: string,
	dictTerms: readonly string[],
	contextTail = ""
): string {
	const prefix = userPrefix.trim();
	const tail = sanitiseContextTail(contextTail);
	const body = composeBody(prefix, dictTerms);
	const composed = joinContextWithBody(tail, body);
	// Last-resort cap: if (context + body) blew the budget, prefer
	// keeping the body intact (it holds the user-curated glossary) and
	// clip the context tail from its front. Body alone is already known
	// to fit because composeBody enforces MAX_PROMPT_CHARS.
	if (composed.length <= MAX_PROMPT_CHARS) {
		return composed;
	}
	// Past the fast-path guard, body is necessarily non-empty: an empty body
	// makes `composed === tail`, and `tail` is hard-capped at
	// MAX_CONTEXT_TAIL_CHARS (500) < MAX_PROMPT_CHARS, so it would have already
	// returned above. (The former `body.length === 0` branch here was dead.)
	const roomForTail = MAX_PROMPT_CHARS - body.length - 2; // "\n\n"
	if (roomForTail <= 0) {
		return body;
	}
	return `${tail.slice(tail.length - roomForTail)}\n\n${body}`;
}

/**
 * Build the composed pair given the three inputs. The realtime variant
 * uses its own user-prefix slot but the SAME dictionary terms — the
 * live preview benefits from the bias too, otherwise users see "oh
 * llama" in the floating pill before the cleanup LLM rewrites it to
 * "Ollama".
 *
 * `contextTail` is a transient per-utterance hint (UIA prior-text). When
 * empty the composer falls back to the legacy two-tier shape, so callers
 * that don't opt into context-awareness see byte-identical output.
 */
export function buildInitialPromptPair(input: {
	contextTail?: string;
	dictionary: readonly RawDictEntry[] | undefined;
	mainPrefix: string;
	realtimePrefix: string;
}): { main: string; realtime: string } {
	const dictTerms = collectDictionaryTerms(input.dictionary);
	const tail = input.contextTail ?? "";
	return {
		main: composeInitialPrompt(input.mainPrefix, dictTerms, tail),
		realtime: composeInitialPrompt(input.realtimePrefix, dictTerms, tail),
	};
}
