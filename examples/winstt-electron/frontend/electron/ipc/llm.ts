import { execFile, spawn } from "node:child_process";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateObject } from "ai";
import { BrowserWindow, ipcMain } from "electron";
import { z } from "zod";
import { IPC } from "../../src/shared/api/ipc-channels";
import {
	ConnectionError,
	getErrorMessage,
	TimeoutError,
	ValidationError,
} from "../../src/shared/lib/errors";
import { buildOllamaApiUrl, normalizeOllamaEndpoint } from "../../src/shared/lib/ollama-endpoint";
import { parseModelSelection } from "../../src/shared/lib/openrouter-model-selection";
import {
	buildSystemPrompt,
	type CustomModifier,
	type CustomModifierEntry,
	isCustomEntry,
	mergePresetsWithCustomModifiers,
	type PresetEntry,
} from "../../src/shared/lib/preset-prompts";
import { dbg } from "../lib/debug-log";
import { getStoreValue, store } from "../lib/store";
import {
	applyReplacementPairs,
	getPostProcessingVocab,
	type ReplacementPair,
} from "../lib/text-processing";
import { AppleIntelligenceError, callAppleIntelligenceCli } from "./apple-intelligence";

const execFileAsync = promisify(execFile);
const NEWLINE_RE = /\r?\n/;

// ── Ollama API response schemas ───────────────────────────────────────

// Ollama returns `details` on `/api/tags` items. Each subfield is optional
// (older Ollama versions may omit them) and `.nullish()` so any one model
// with `null` somewhere doesn't reject the whole catalog.
const ollamaDetailsSchema = z
	.object({
		format: z.string().nullish(),
		family: z.string().nullish(),
		families: z.array(z.string()).nullish(),
		parameter_size: z.string().nullish(),
		quantization_level: z.string().nullish(),
	})
	.partial();

const ollamaTagsModelSchema = z.object({
	name: z.string(),
	size: z.number(),
	modified_at: z.string().optional(),
	modifiedAt: z.string().optional(),
	details: ollamaDetailsSchema.nullish(),
});

const ollamaTagsResponseSchema = z.object({
	models: z.array(ollamaTagsModelSchema).optional(),
});

// `/api/show` returns a verbose model dump; we only care about the
// capabilities array (`["completion", "tools", "thinking", …]`). Every
// other field is opaque to us so we keep the schema permissive.
const ollamaShowResponseSchema = z.object({
	capabilities: z.array(z.string()).optional(),
});

// Streaming /api/chat emits one JSON object per chunk. `message.thinking`
// is present only for reasoning models that have been started with
// `think: true` (Qwen3, deepseek-r1, …); `message.content` carries the
// final answer. Either may be empty in any given chunk — Ollama splits
// reasoning and answer across separate chunks but does not guarantee
// which one arrives first. The terminal chunk has `done: true`.
const ollamaChatStreamChunkSchema = z.object({
	model: z.string().optional(),
	created_at: z.string().optional(),
	message: z
		.object({
			role: z.string().optional(),
			content: z.string().optional(),
			thinking: z.string().optional(),
		})
		.optional(),
	done: z.boolean().optional(),
	done_reason: z.string().optional(),
	error: z.string().optional(),
});

interface OllamaModelDetails {
	families?: string[];
	family?: string;
	format?: string;
	parameterSize?: string;
	quantizationLevel?: string;
}

interface OllamaModel {
	/**
	 * Capabilities reported by `/api/show` for this model. Mirrors
	 * Ollama's own capability strings (`thinking`, `tools`, `completion`,
	 * `vision`, `insert`). Undefined when the catalog wasn't enriched
	 * (older Ollama, the `/api/show` request failed, or the renderer is
	 * working with a stale cached list).
	 */
	capabilities?: readonly string[];
	details?: OllamaModelDetails;
	modifiedAt: string;
	name: string;
	size: number;
}

interface OllamaScanResult {
	error?: string;
	models: OllamaModel[];
	reachable: boolean;
}

interface OllamaChatMessage {
	content: string;
	role: "system" | "user" | "assistant";
}

// ── OpenRouter /api/v1/models schemas ─────────────────────────────────

const KNOWN_VARIANTS = [
	"free",
	"extended",
	"exacto",
	"nitro",
	"floor",
	"thinking",
	"online",
] as const;
type KnownVariant = (typeof KNOWN_VARIANTS)[number];

const openRouterPricingSchema = z
	// Stryker disable next-line ObjectLiteral: equivalent — every field is
	// `.optional()` and `.partial()` makes the entire object optional. Emptying
	// the literal still produces a schema that accepts every test payload (fields
	// are optional so missing fields parse fine; extra fields are dropped).
	.object({
		prompt: z.string().optional(),
		completion: z.string().optional(),
		request: z.string().optional(),
		image: z.string().optional(),
		web_search: z.string().optional(),
		internal_reasoning: z.string().optional(),
		input_cache_read: z.string().optional(),
		input_cache_write: z.string().optional(),
	})
	.partial();

// Architecture surface — modalities drive the picker's per-row modality chips.
// OpenRouter returns these fields as either strings, arrays, OR `null` (commonly
// `instruct_type: null` for chat-only models); `.nullish()` accepts both null
// and undefined so the scan doesn't reject ~half the catalog on `null` values.
const openRouterArchitectureSchema = z
	.object({
		modality: z.string().nullish(),
		tokenizer: z.string().nullish(),
		instruct_type: z.string().nullish(),
		input_modalities: z.array(z.string()).nullish(),
		output_modalities: z.array(z.string()).nullish(),
	})
	.partial();

const openRouterModelSchema = z.object({
	id: z.string(),
	name: z.string(),
	// OpenRouter returns `null` (not absent) for missing descriptions and
	// context_length on some models; `.nullish()` accepts both so the scan
	// doesn't reject the whole catalog over a few sparse rows.
	description: z.string().nullish(),
	context_length: z.number().int().nullish(),
	pricing: openRouterPricingSchema.nullish(),
	supported_parameters: z.array(z.string()).nullish(),
	architecture: openRouterArchitectureSchema.nullish(),
});

const openRouterModelsResponseSchema = z.object({
	data: z.array(openRouterModelSchema).optional(),
});

// Stryker disable next-line ObjectLiteral: equivalent — emptying the schema
// definition leaves an "anything-goes" zod object that accepts every test
// fixture's endpoint payload identically. The fixture endpoints already have
// the required keys; the suite never inspects whether the schema rejects
// missing keys for these endpoint records (only for the model-level schema).
const openRouterEndpointSchema = z.object({
	name: z.string(),
	model_name: z.string(),
	context_length: z.number().int(),
	pricing: openRouterPricingSchema,
	provider_name: z.string(),
	tag: z.string(),
	max_completion_tokens: z.number().int().nullable().optional(),
	supported_parameters: z.array(z.string()).optional(),
	quantization: z.string().nullable().optional(),
	status: z.number().nullable().optional(),
	uptime_last_30m: z.number().nullable().optional(),
});

interface OpenRouterScanModel {
	architecture?: z.infer<typeof openRouterArchitectureSchema>;
	context_length?: number;
	description?: string;
	endpoints?: z.infer<typeof openRouterEndpointSchema>[];
	id: string;
	maker?: string;
	model_name?: string;
	name: string;
	pricing?: z.infer<typeof openRouterPricingSchema>;
	provider?: string;
	supported_parameters?: string[];
	variant?: KnownVariant;
}

// `/api/v1/models/{author}/{slug}/endpoints` returns the per-model detail
// payload: full (un-truncated) description + the array of infrastructure
// providers hosting the model. This is the data that powers the provider
// rail expansion, the per-provider pricing/features/quantization chips, and
// the structured-output / tool-use icons in the picker rows.
const openRouterEndpointsDetailSchema = z.object({
	description: z.string().optional(),
	endpoints: z.array(openRouterEndpointSchema).optional(),
});

const openRouterEndpointsResponseSchema = z.object({
	data: openRouterEndpointsDetailSchema.optional(),
});

interface OpenRouterScanResult {
	error?: string;
	models: OpenRouterScanModel[];
	reachable: boolean;
}

// Stryker disable next-line StringLiteral: equivalent — STRUCTURED_OUTPUT_DESCRIPTION
// is a prompt-engineering hint embedded only in the LLM request body. Tests
// don't assert on its content; mutating to "" still produces a valid request
// that the OpenAI/Ollama mock handlers accept identically.
const STRUCTURED_OUTPUT_DESCRIPTION =
	"Return a JSON object with `text` (the transformed text, no commentary) and optionally `learned_proper_nouns` (an array of proper nouns / technical identifiers that appear in the dictation and are worth remembering across future dictations — see schema for the criteria).";

const LEARNED_PROPER_NOUNS_DESCRIPTION =
	'Optional. Up to 5 proper nouns or technical identifiers that appear in the user\'s dictation AND would be useful for the user to remember for future dictations. Include: people\'s names (first or full), product names, technical jargon, distinctive acronyms, unusual place names. EXCLUDE: common English words, generic terms ("app", "file", "dog"), anything already in the existing vocabulary list above, and anything from the visible CONTEXT that wasn\'t actually spoken. Leave empty when nothing qualifies. Pick conservatively — false positives are worse than misses.';

/**
 * Compose-vs-Generate rule. Applied UNCONDITIONALLY (independent of
 * whether context-awareness captured anything) because the rule is
 * about how to interpret the dictation itself: instructions like
 * "reply professionally" / "translate to Spanish" / "make this concise"
 * should be followed (compose), but instructions like "write a todo
 * app" / "explain quantum physics" should NOT (generate from nothing).
 *
 * The line is "is the output materially derived from (a) the spoken
 * dictation or (b) the visible context?" — if yes, allowed; if no,
 * treat the dictation as literal text to clean up.
 */
function withComposeRules(systemPrompt: string): string {
	const preamble = [
		"How to interpret the dictation:",
		"You are cleaning up a spoken dictation. Most dictations are plain text",
		"the user wants pasted verbatim (with filler removed and punctuation",
		"fixed). Some dictations are short META-INSTRUCTIONS telling you how to",
		"transform the rest of the dictation or how to use what's visible on the",
		"user's screen.",
		"",
		"COMPOSE rule — these meta-instructions ARE allowed when their output",
		"is materially derived from the dictation or the visible CONTEXT:",
		'  - "make this professional / casual / concise / shorter" with a',
		"    visible draft → rewrite the draft in that register.",
		'  - "reply yes I can do Friday" / "respond saying ..." with an email or',
		"    chat thread visible → compose a reply derived from that thread.",
		'  - "translate this to Spanish" / "translate to French" → translate',
		"    the dictation (or the selected visible text).",
		'  - "summarise this" / "shorten" with a visible passage → summarise it.',
		"  Follow the user's stated intent.",
		"",
		"GENERATE rule — these requests are NOT allowed; treat them as literal",
		"text to clean up:",
		'  - "write a todo app in React", "build a website for me", "explain',
		'    quantum physics", "draft an essay about ..."',
		"  - Any request for substantial new content with no anchor in either",
		"    the dictation or the visible CONTEXT.",
		"  For these, output the dictation verbatim (cleaned of filler and",
		"  punctuation only) — DO NOT fulfill the request.",
		"",
		"When the dictation is plain text (no meta-instruction), just clean it",
		"up — fix punctuation, capitalisation, fillers, and obvious",
		"misrecognitions, and output the result. Never invent content that",
		"wasn't spoken or visible.",
		"",
	].join("\n");
	return `${preamble}${systemPrompt}`;
}

/**
 * Prepend a context block to the system prompt when context-awareness is
 * enabled and the UIA reader captured something. Two jobs:
 *   1. Spelling/jargon disambiguation — framed as a reference so the
 *      LLM uses names from context only to fix mis-recognised spellings
 *      of words actually spoken, not to insert new content.
 *   2. Caret continuation — only when the `--split` read produced the
 *      before/after-caret sections. The clause is inert when those
 *      labels are absent.
 *
 * The compose-vs-generate rule lives in `withComposeRules` (outside
 * this preamble) because it applies even without context. Here we only
 * describe how to USE the context the helper captured.
 */
function withContextPrefix(systemPrompt: string, context: string): string {
	if (!context) {
		return systemPrompt;
	}
	const preamble = [
		"The CONTEXT block below is a JSON object describing what's currently on",
		"the user's screen (keys may include app, window, url, field, beforeCaret,",
		"afterCaret, selection, screen, clipboard; empty ones are omitted). Use it for:",
		"  (a) Spelling proper nouns, names, and technical terms that appear",
		"      in the dictation. If the dictation phonetically matches a name",
		"      that appears in the context (e.g. an email recipient), prefer",
		"      the context's spelling.",
		"  (b) Composing or replying when the dictation explicitly asks for it",
		'      (per the COMPOSE rule above: "reply to this", "respond yes",',
		'      "summarise this", "translate ...").',
		"  (c) Code identifier recognition. When the CONTEXT contains code —",
		'      either because the context shows "ide": true, or',
		"      because the axHtml shows code-shaped tokens (camelCase like",
		"      `useState`, PascalCase classes, snake_case functions, file",
		"      paths with extensions like `auth.ts`, CLI flags like `--fix`) —",
		"      AND the dictation phonetically matches one of those tokens,",
		"      output the identifier verbatim wrapped in backticks. Examples:",
		'        "use state hook" with `useState` visible → "`useState` hook"',
		'        "get user by id"  with `getUserById` visible → "`getUserById`"',
		'        "run with fix flag" with `--fix` visible → "run with `--fix`"',
		"      Apply only when the match is phonetically clear; never invent",
		"      identifiers the context doesn't actually show.",
		"Do not reproduce, summarise, or echo the context unless a COMPOSE",
		"instruction asked for it. Treat it as reference, not as content to",
		"include.",
		"The context may be a MULTI-SPEAKER thread: a line or segment prefixed",
		'with a name (e.g. "Alice:", "@handle", "by Bob:") denotes that',
		'speaker, and "You:" is the user. When composing a reply, attribute',
		"prior turns to the right speaker and write as the user.",
		"",
		'When the context has a "beforeCaret" field, the dictation is being',
		"inserted at that caret — decide from how that text ends:",
		"- If it ends mid-sentence (no terminal . ! ? : and not on a blank/new line),",
		"  the dictation continues it: do not capitalize the first word (unless it is",
		'  "I" or a proper noun) and add only the minimal joining space or punctuation',
		"  needed to read on naturally.",
		'- If it ends a sentence, ends with a newline, or there is no "beforeCaret",',
		"  start the dictation normally with a capital letter.",
		'Never reproduce the surrounding text. When the context has an "afterCaret"',
		"field, do not repeat words it already contains.",
		"Output only the cleaned dictation, adjusted at its boundaries so it",
		"stitches into place.",
		"",
		"<context>",
		context,
		"</context>",
		"",
	].join("\n");
	return `${preamble}${systemPrompt}`;
}

/**
 * Prepend the user's dictionary terms, replacement pairs, and snippet
 * shortcuts to the system prompt. Three lists folded in:
 *   - `dictionary`     — vocab words; spelling reference (fuzzy near-miss).
 *   - `replacementPairs` — deterministic misspelling→correction pairs;
 *                          model is told to apply them, AND a safety-net
 *                          string-replace runs on the output afterwards.
 *   - `snippets`       — voice-trigger phrase expansions.
 *
 * Folded in when the dictation LLM is enabled, replacing the algorithmic
 * post-processor — see relay.ts handleFullSentence flow.
 */
function buildDictionaryBlock(dictionary: readonly string[]): string {
	return [
		"The list below is ONLY a spelling reference. Use it solely to fix a",
		"word the speaker actually said but that was mis-transcribed: replace",
		"a dictated word with a listed term ONLY when that word is an",
		"unmistakable near-miss of it — essentially the same sounds and",
		"length, differing only by a homophone or a few dropped, added, or",
		'swapped letters (e.g. "oh llama" → "ollama", "base you eye" →',
		'"baseui").',
		"Hard limits — violating these is worse than missing a correction:",
		"- NEVER insert a listed term that has no clearly corresponding",
		"  similar-sounding word in the speech. If nothing in the dictation",
		"  closely matches, output it unchanged.",
		"- NEVER replace a common function word (it, is, the, will, this,",
		"  that, a, to, and, pronouns, …) with a listed term.",
		"- NEVER add a term as new content, and never rephrase or pad the",
		"  sentence so a term fits. Only the words actually spoken may appear.",
		'  (e.g. "Will it transcribe the text cleanly?" stays exactly that —',
		'  it does NOT become "Will Ollama BaseUI transcribe …".)',
		"- When in doubt, leave the original word as dictated.",
		"",
		"<preferred-terms>",
		...dictionary.map((t) => `- ${t}`),
		"</preferred-terms>",
		"",
	].join("\n");
}

function buildReplacementPairsBlock(replacementPairs: readonly ReplacementPair[]): string {
	return [
		"The pairs below are DETERMINISTIC find-and-replace rules. When the",
		"dictation contains a whole-word match of the FIND side (case-",
		'insensitive, e.g. dictating "github" or "GitHub" or "GITHUB"),',
		"replace it verbatim with the REPLACE side preserving the exact",
		"casing shown. This is mechanical — apply without judgement, do not",
		"second-guess the user's casing or punctuation choice.",
		"",
		"<replacement-pairs>",
		...replacementPairs.map(
			(p) => `- find "${p.term}" -> "${p.replacement.replaceAll("\n", "\\n")}"`
		),
		"</replacement-pairs>",
		"",
	].join("\n");
}

function buildSnippetsBlock(snippets: readonly { trigger: string; expansion: string }[]): string {
	return [
		"The user has the following snippet shortcuts. When the dictated text",
		"contains a phrase that matches a trigger (allow minor phonetic /",
		"spelling variation — e.g. a missing letter, a homophone), replace the",
		"ENTIRE matched phrase with the corresponding expansion verbatim.",
		"Preserve any punctuation that immediately surrounds the matched phrase.",
		"",
		"<snippets>",
		...snippets.map((s) => `- "${s.trigger}" -> ${s.expansion.replaceAll("\n", "\\n")}`),
		"</snippets>",
		"",
	].join("\n");
}

function pushBlockIfNonEmpty<T>(
	blocks: string[],
	items: readonly T[],
	builder: (items: readonly T[]) => string
): void {
	if (items.length > 0) {
		blocks.push(builder(items));
	}
}

function withVocabPrefix(
	systemPrompt: string,
	vocab: {
		dictionary: readonly string[];
		replacementPairs: readonly ReplacementPair[];
		snippets: readonly { trigger: string; expansion: string }[];
	}
): string {
	const blocks: string[] = [];
	pushBlockIfNonEmpty(blocks, vocab.dictionary, buildDictionaryBlock);
	pushBlockIfNonEmpty(blocks, vocab.replacementPairs, buildReplacementPairsBlock);
	pushBlockIfNonEmpty(blocks, vocab.snippets, buildSnippetsBlock);
	if (blocks.length === 0) {
		return systemPrompt;
	}
	return `${blocks.join("\n")}${systemPrompt}`;
}

/**
 * Build the dictation system prompt with context + vocab folded in. The
 * vocab is read from the runtime post-processor cache so settings changes
 * are picked up live without re-plumbing the call chain.
 *
 * Layering (outermost → innermost):
 *   1. vocab prefix    — user's spelling reference list
 *   2. compose rules   — COMPOSE-vs-GENERATE rule for all dictations
 *   3. context prefix  — how to use the visible UIA snapshot, caret rules
 *   4. preset prompt   — chosen style (formal/friendly/concise/...)
 */
function buildDictationSystemPrompt(presets: readonly PresetEntry[], context: string): string {
	const vocab = getPostProcessingVocab();
	return withVocabPrefix(
		withComposeRules(withContextPrefix(buildSystemPrompt(presets), context)),
		vocab
	);
}

// Stryker disable next-line ObjectLiteral,StringLiteral: equivalent — emptying
// the schema definition or the `.describe()` annotation has no effect on parse
// behaviour for the test fixtures (the `text` field is always present and a
// string), and `.describe()` is metadata used only by tooling.
//
// `learned_proper_nouns` is the single-call dictionary-learning channel: the
// cleanup model emits 0–5 proper nouns from the dictation that would be
// useful to remember across future dictations. This replaces the parallel
// `/llm/extract_asr_words` call Wispr Flow makes on the server — for local
// LLMs a second call would double latency, so we piggyback the extraction on
// the existing cleanup call's structured output.
const transformedTextSchema = z.object({
	text: z.string().describe("The transformed text, with no commentary or explanations."),
	learned_proper_nouns: z.array(z.string()).optional().describe(LEARNED_PROPER_NOUNS_DESCRIPTION),
});

// Stryker disable next-line Regex: equivalent — the regex variants Stryker
// generates (dropping `^` anchor, removing optional `?`, swapping `\s*` to
// `\s` or `\S*`) all match the synthetic markdown fences in the test fixtures
// the same way: every fixture starts with ```json\n or ```\n at the very
// beginning, so the anchor matches, and there's at least one whitespace char,
// so all the variant patterns also match. The replacement output is identical.
const MARKDOWN_FENCE_OPEN_RE = /^```(?:json)?\s*/i;
const MARKDOWN_FENCE_CLOSE_RE = /\s*```$/i;
const SURROUNDING_QUOTES_RE = /^["']|["']$/g;

// ── Pure helpers (extracted to keep CC ≤ 3 in callers) ────────────────

function assertNonEmptyString(
	value: unknown,
	message: string,
	field: string
): asserts value is string {
	if (typeof value !== "string") {
		throw new ValidationError(message, field);
	}
	if (!value) {
		throw new ValidationError(message, field);
	}
}

function assertValidEndpoint(endpoint: string): string {
	const normalized = normalizeOllamaEndpoint(endpoint);
	if (!normalized) {
		throw new ValidationError("LLM endpoint is required", "endpoint");
	}
	return normalized;
}

function describeCustomPreset(p: CustomModifierEntry): string {
	return p.level ? `custom:${p.id}:${p.level}` : `custom:${p.id}`;
}

function describeTranslatePreset(p: PresetEntry): string {
	const lang = (p as { targetLang?: string }).targetLang ?? "English";
	return `translate:${lang}`;
}

function describeBuiltinPreset(p: PresetEntry): string {
	return p.level ? `${p.key}:${p.level}` : p.key;
}

function describePreset(p: PresetEntry): string {
	if (isCustomEntry(p)) {
		return describeCustomPreset(p);
	}
	if (p.key === "translate") {
		return describeTranslatePreset(p);
	}
	return describeBuiltinPreset(p);
}

function describePresets(presets: readonly PresetEntry[]): string {
	return presets.map(describePreset).join(",");
}

async function safeFetch(
	url: string,
	init: RequestInit,
	contextLabel: string
): Promise<Response | { error: string }> {
	try {
		return await fetch(url, init);
	} catch (err) {
		const message = getErrorMessage(err);
		dbg("llm", `${contextLabel} unreachable:`, message);
		return { error: message };
	}
}

function isFetchError(value: Response | { error: string }): value is { error: string } {
	return "error" in value;
}

async function readErrorText(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return "Unknown error";
	}
}

function mapOllamaTagsModels(
	parsedModels: readonly z.infer<typeof ollamaTagsModelSchema>[]
): OllamaModel[] {
	return parsedModels.map(toOllamaModel);
}

function resolveOllamaModifiedAt(item: z.infer<typeof ollamaTagsModelSchema>): string {
	return item.modifiedAt ?? item.modified_at ?? "";
}

function nullishToUndefined<T>(value: T | null | undefined): T | undefined {
	return value ?? undefined;
}

function buildOllamaDetailsFromRaw(
	d: NonNullable<z.infer<typeof ollamaTagsModelSchema>["details"]>
): OllamaModelDetails {
	return llmOmitUndefined({
		format: nullishToUndefined(d.format),
		family: nullishToUndefined(d.family),
		families: nullishToUndefined(d.families),
		parameterSize: nullishToUndefined(d.parameter_size),
		quantizationLevel: nullishToUndefined(d.quantization_level),
	});
}

function extractOllamaDetails(
	d: z.infer<typeof ollamaTagsModelSchema>["details"]
): OllamaModelDetails | undefined {
	if (!d) {
		return;
	}
	return buildOllamaDetailsFromRaw(d);
}

function hasAnyDetailField(details: OllamaModelDetails | undefined): boolean {
	if (!details) {
		return false;
	}
	return Object.values(details).some(isDefined);
}

function isDefined<T>(v: T | undefined): v is T {
	return v !== undefined;
}

function toOllamaModel(item: z.infer<typeof ollamaTagsModelSchema>): OllamaModel {
	const modifiedAt = resolveOllamaModifiedAt(item);
	const details = extractOllamaDetails(item.details);
	const base = { name: item.name, size: item.size, modifiedAt };
	if (hasAnyDetailField(details) && details) {
		return { ...base, details };
	}
	return base;
}

function llmOmitUndefined<T extends Record<string, unknown>>(
	obj: T
): { [K in keyof T]?: Exclude<T[K], undefined> } {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined) {
			out[k] = v;
		}
	}
	return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}

function parseOllamaTagsOrFail(json: unknown): OllamaScanResult {
	const parsed = ollamaTagsResponseSchema.safeParse(json);
	if (!parsed.success) {
		dbg("llm", "Ollama /api/tags response did not match expected schema:", parsed.error.message);
		return { models: [], reachable: true, error: "Unexpected response shape from Ollama" };
	}
	return { models: mapOllamaTagsModels(parsed.data.models ?? []), reachable: true };
}

// ── /api/chat streaming + reasoning broadcast ────────────────────────
//
// Reasoning-capable models (Qwen3, deepseek-r1, gpt-oss, …) split their
// output into `message.thinking` (chain-of-thought) and `message.content`
// (final answer). Older Ollama versions left `<think>…</think>` inline in
// `content`; newer versions route it to the dedicated `thinking` field
// only when the request opts in via `think: true` (see buildOllamaChatBody).
// We support both shapes here so the same code path works whether the
// installed Ollama is recent or stale.

const THINK_TAG_RE = /<think>[\s\S]*?<\/think>/gi;
const THINKING_TAG_RE = /<thinking>[\s\S]*?<\/thinking>/gi;
const OPEN_THINK_TAG_RE = /<\/?think(?:ing)?>/gi;
// Partial-JSON extractor for the structured-output `text` field. Matches
// `"text": "..."` up to the first unescaped closing quote or the end of
// input (whichever comes first). Used to stream natural-prose chunks to
// the pill while the model is still emitting JSON characters.
const PARTIAL_STRUCTURED_TEXT_RE = /"text"\s*:\s*"((?:[^"\\]|\\.)*)/;
// Salvage-path scaffold peelers (see salvageStructuredText). Hoisted to
// module scope — they run on every finalize for the malformed-envelope path.
const TRAILING_BACKSLASH_RE = /\\+$/;
const TRAILING_BRACE_RE = /\s*\}\s*$/;
const TRAILING_QUOTE_RE = /\s*["”“]\s*$/u;
// Match a balanced `\boxed{…}` allowing one level of nested braces (covers
// the math-output convention used by Qwen-Math / DeepSeek-Math when the
// model leaks chain-of-thought into `content` instead of `thinking`. The
// non-greedy character class handles the common one-pair-of-braces case;
// the optional nested group covers `\boxed{\frac{a}{b}}` and similar. We
// don't try to fully recursively match nested braces — TypeScript regex
// can't, and a two-level match covers every real-world case we've seen.
const BOXED_RE = /\\boxed\{((?:[^{}]|\{[^{}]*\})*)\}/g;
// Harmony channel markers — gpt-oss family emits these inline when the
// runtime doesn't strip them server-side. Only the text under the `final`
// channel is the intended answer; everything in `analysis` is reasoning.
const HARMONY_FINAL_RE =
	/<\|channel\|>\s*final\s*<\|message\|>([\s\S]*?)(?:<\|end\|>|<\|return\|>|<\|start\|>|$)/i;
const HARMONY_ANALYSIS_RE =
	/<\|channel\|>\s*analysis\s*<\|message\|>([\s\S]*?)(?:<\|end\|>|<\|start\|>|<\|channel\|>)/gi;

interface OllamaChatStreamState {
	buffer: { value: string };
	content: string;
	/**
	 * Cursor into the structured-output `text` field — characters at or
	 * before this index have already been broadcast to the pill via
	 * `LLM_REASONING_DELTA`. Used by `applyChatStreamChunk` to compute
	 * the new portion to broadcast on every chunk, so the pill streams
	 * natural prose instead of raw JSON characters.
	 */
	contentStreamCursor: number;
	done: boolean;
	doneReason?: string;
	error?: string;
	thinking: string;
}

function isLiveBrowserWindowForChat(bw: BrowserWindow): boolean {
	return !bw.isDestroyed();
}

// ── Active chat AbortControllers ──────────────────────────────────────
//
// `processWithOllama` and `processWithOllamaCustom` register their
// AbortController here for the duration of the call. When the user
// switches Ollama models (detected by the warmup store-listener) we
// abort every active chat so Ollama's per-model serializer releases
// immediately instead of forcing the new warmup to queue behind a
// previous (possibly slow / hung) reasoning stream. Without this,
// switching from a Qwen3 reasoning model that's still emitting tokens
// will block the next model's warmup until the original stream drains.
const activeChatControllers = new Set<AbortController>();

function registerChatController(controller: AbortController): void {
	activeChatControllers.add(controller);
}

function unregisterChatController(controller: AbortController): void {
	activeChatControllers.delete(controller);
}

function tryAbortController(controller: AbortController, reason: string): void {
	try {
		controller.abort(reason);
	} catch (err) {
		dbg("llm", "AbortController abort failed:", getErrorMessage(err));
	}
}

export function abortActiveOllamaChats(reason: string): void {
	if (activeChatControllers.size === 0) {
		return;
	}
	dbg("llm", `Aborting ${activeChatControllers.size} active Ollama chat(s): ${reason}`);
	for (const controller of activeChatControllers) {
		tryAbortController(controller, reason);
	}
	activeChatControllers.clear();
}

function broadcastReasoningDelta(delta: string): void {
	if (!delta) {
		return;
	}
	const live = BrowserWindow.getAllWindows().filter(isLiveBrowserWindowForChat);
	for (const bw of live) {
		bw.webContents.send(IPC.LLM_REASONING_DELTA, { delta });
	}
}

/**
 * Broadcast a learned-proper-nouns batch to every renderer. The
 * dictionary auto-add UI listens on this channel and folds each entry
 * into its "Accept / Decline" queue. Empty arrays are dropped to keep
 * the channel quiet on dictations where nothing qualifies — the listener
 * doesn't need to debounce away no-ops.
 */
function broadcastLearnedProperNouns(nouns: readonly string[]): void {
	if (nouns.length === 0) {
		return;
	}
	const live = BrowserWindow.getAllWindows().filter(isLiveBrowserWindowForChat);
	for (const bw of live) {
		bw.webContents.send(IPC.LLM_LEARNED_PROPER_NOUNS, { nouns });
	}
}

function parseChatStreamLine(line: string): z.infer<typeof ollamaChatStreamChunkSchema> | null {
	try {
		const json = JSON.parse(line) as unknown;
		const parsed = ollamaChatStreamChunkSchema.safeParse(json);
		if (!parsed.success) {
			dbg("llm", "Ollama /api/chat stream chunk did not match schema:", parsed.error.message);
			return null;
		}
		return parsed.data;
	} catch (err) {
		dbg("llm", "Ollama /api/chat stream line was not JSON:", getErrorMessage(err));
		return null;
	}
}

/**
 * Best-effort progressive decode of the structured-output `text` field
 * from a (possibly incomplete) JSON content buffer. Returns the
 * characters that have arrived so far inside the `text` value, with
 * common JSON escape sequences resolved. When the buffer doesn't yet
 * contain a recognisable `"text": "...` opening we return null and the
 * caller treats this chunk's content as raw (no streaming to the pill
 * until the field opens). Once the field opens we can stream char-by-
 * char even though the JSON isn't terminated.
 */
function extractPartialStructuredText(content: string): string | null {
	const match = content.match(PARTIAL_STRUCTURED_TEXT_RE);
	if (!match) {
		return null;
	}
	// Resolve the minimum set of escapes a model will emit through Ollama's
	// schema-guided JSON output (newline, tab, quote, backslash, unicode).
	// Anything more exotic falls through to JSON.parse at finalize time.
	return (match[1] ?? "")
		.replace(/\\n/g, "\n")
		.replace(/\\t/g, "\t")
		.replace(/\\r/g, "\r")
		.replace(/\\"/g, '"')
		.replace(/\\\\/g, "\\");
}

function applyThinkingChunk(state: OllamaChatStreamState, thinking: string | undefined): void {
	if (!thinking) {
		return;
	}
	state.thinking += thinking;
	broadcastReasoningDelta(thinking);
}

function resolveVisibleContent(content: string): string | null {
	// Two content shapes:
	//
	//  - Structured output (Ollama honored `format`): content is a JSON
	//    envelope `{"text":"…"}`. ONLY the inner `text` value is human
	//    output. Stream it via the partial extractor; until the field
	//    opens, `partial` is null and we stream nothing — that's by
	//    design and is what keeps the `{"text": "` scaffold (which the
	//    user otherwise saw as a literal `text:{…}` prefix) out of the
	//    visible reasoning band.
	//  - Raw passthrough (older Ollama, or a model that ignored
	//    `format` and emitted prose directly): stream the content as-is.
	//
	// The envelope is detected by a leading `{` on the trimmed buffer —
	// the first non-whitespace char never changes as content grows, so
	// this stays stable for the whole stream and a partial-extract miss
	// no longer falls back to leaking the raw JSON.
	const isStructuredEnvelope = content.trimStart().startsWith("{");
	if (isStructuredEnvelope) {
		return extractPartialStructuredText(content);
	}
	return content;
}

function broadcastContentDelta(state: OllamaChatStreamState): void {
	const visible = resolveVisibleContent(state.content);
	if (visible === null) {
		return;
	}
	if (visible.length <= state.contentStreamCursor) {
		return;
	}
	const delta = visible.slice(state.contentStreamCursor);
	state.contentStreamCursor = visible.length;
	broadcastReasoningDelta(delta);
}

function applyContentChunk(state: OllamaChatStreamState, content: string | undefined): void {
	if (!content) {
		return;
	}
	state.content += content;
	// Stream the natural-prose answer to the pill — never the JSON
	// scaffolding.
	broadcastContentDelta(state);
}

function applyDoneFlag(
	state: OllamaChatStreamState,
	done: boolean | undefined,
	doneReason: string | undefined
): void {
	if (!done) {
		return;
	}
	state.done = true;
	if (doneReason) {
		state.doneReason = doneReason;
	}
}

function applyChatStreamChunk(
	state: OllamaChatStreamState,
	chunk: z.infer<typeof ollamaChatStreamChunkSchema>
): void {
	applyThinkingChunk(state, chunk.message?.thinking);
	applyContentChunk(state, chunk.message?.content);
	if (chunk.error) {
		state.error = chunk.error;
	}
	applyDoneFlag(state, chunk.done, chunk.done_reason);
}

function consumeChatStreamLines(state: OllamaChatStreamState): void {
	for (const line of iterateNdjsonChunks(state.buffer)) {
		const chunk = parseChatStreamLine(line);
		if (chunk) {
			applyChatStreamChunk(state, chunk);
		}
	}
}

async function drainChatReaderInto(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	decoder: TextDecoder,
	state: OllamaChatStreamState
): Promise<void> {
	while (true) {
		// react-doctor-disable-next-line async-await-in-loop
		const { value, done } = await reader.read();
		if (done) {
			return;
		}
		state.buffer.value += decoder.decode(value, { stream: true });
		consumeChatStreamLines(state);
	}
}

function flushChatStreamBuffer(state: OllamaChatStreamState, decoder: TextDecoder): void {
	state.buffer.value += decoder.decode();
	if (state.buffer.value.trim()) {
		consumeChatStreamLines(state);
	}
}

async function readOllamaChatStream(
	body: ReadableStream<Uint8Array>
): Promise<OllamaChatStreamState> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state: OllamaChatStreamState = {
		buffer: { value: "" },
		content: "",
		contentStreamCursor: 0,
		thinking: "",
		done: false,
	};
	try {
		await drainChatReaderInto(reader, decoder, state);
		flushChatStreamBuffer(state, decoder);
	} finally {
		reader.releaseLock();
	}
	return state;
}

/**
 * Split inline `<think>…</think>` from an Ollama chat content string,
 * broadcasting any reasoning found inside the tags. This is the legacy
 * shape — newer Ollama puts the same text into `message.thinking` instead
 * and never emits the tags inline. We still scan for them so the feature
 * works on older Ollama installs without forcing an upgrade.
 */
function splitInlineThinking(content: string): { thinking: string; answer: string } {
	let thinking = "";
	let answer = content.replace(THINK_TAG_RE, (match) => {
		thinking += match.replace(OPEN_THINK_TAG_RE, "");
		return "";
	});
	answer = answer.replace(THINKING_TAG_RE, (match) => {
		thinking += match.replace(OPEN_THINK_TAG_RE, "");
		return "";
	});
	return { thinking, answer: answer.trim() };
}

/**
 * Pull the LAST `\boxed{…}` payload out of a chain-of-thought-leakage
 * content string. Returns `null` when no boxed answer is found.
 *
 * Why: math-reasoning Qwen variants (Qwen-Math, DeepSeek-Math, some
 * Qwen3 thinking checkpoints) emit their entire chain-of-thought into
 * `message.content` and mark the final answer with `\boxed{…}`. Ollama
 * has no parser for that convention, so we do it here. Everything
 * preceding the boxed answer is treated as reasoning — the user has
 * already seen most of it in the pill via `message.thinking`, but
 * surfacing the rest as a reasoning delta closes the gap.
 */
function isUsableMatch(match: RegExpMatchArray | undefined): match is RegExpMatchArray {
	return match !== undefined && match.index !== undefined;
}

function pickLastIndexedMatch(matches: readonly RegExpMatchArray[]): RegExpMatchArray | null {
	const last = matches.at(-1);
	return isUsableMatch(last) ? last : null;
}

function buildBoxedThinking(content: string, last: RegExpMatchArray): string {
	const index = last.index as number;
	const before = content.slice(0, index).trim();
	const after = content.slice(index + last[0].length).trim();
	// Anything after the boxed answer (typical Qwen-Math epilogue:
	// "This has N words…") is also chain-of-thought — fold it into the
	// reasoning trace rather than emitting it as part of the answer.
	return [before, after].filter(Boolean).join("\n\n");
}

function readMatchGroupTrimmed(match: RegExpMatchArray, group: number): string {
	const raw = match[group];
	return raw ? raw.trim() : "";
}

function buildBoxedResultIfAnswerable(
	content: string,
	last: RegExpMatchArray
): { thinking: string; answer: string } | null {
	const answer = readMatchGroupTrimmed(last, 1);
	return answer ? { thinking: buildBoxedThinking(content, last), answer } : null;
}

function extractBoxedAnswer(content: string): { thinking: string; answer: string } | null {
	const matches = Array.from(content.matchAll(BOXED_RE));
	const last = pickLastIndexedMatch(matches);
	return last ? buildBoxedResultIfAnswerable(content, last) : null;
}

/**
 * Pull the `final` channel out of an OpenAI-harmony stream that leaked
 * into `message.content`. Same situation as `\boxed{}` — when Ollama
 * doesn't recognize a gpt-oss-family model it falls through to raw
 * passthrough and we get `<|channel|>analysis<|message|>…<|channel|>
 * final<|message|>…<|end|>` in `content`. Returns `null` when no
 * harmony delimiters are present.
 */
function isNonEmptyString(s: string): s is string {
	return s.length > 0;
}

function collectHarmonyAnalysisChunks(content: string): string[] {
	return Array.from(content.matchAll(HARMONY_ANALYSIS_RE))
		.map((m) => readMatchGroupTrimmed(m, 1))
		.filter(isNonEmptyString);
}

function buildHarmonyResult(content: string, answer: string): { thinking: string; answer: string } {
	return {
		thinking: collectHarmonyAnalysisChunks(content).join("\n\n"),
		answer,
	};
}

function buildHarmonyResultIfAnswerable(
	content: string,
	finalMatch: RegExpMatchArray
): { thinking: string; answer: string } | null {
	const answer = readMatchGroupTrimmed(finalMatch, 1);
	return answer ? buildHarmonyResult(content, answer) : null;
}

function extractHarmonyAnswer(content: string): { thinking: string; answer: string } | null {
	const finalMatch = content.match(HARMONY_FINAL_RE);
	return finalMatch ? buildHarmonyResultIfAnswerable(content, finalMatch) : null;
}

/** Resolve the JSON string escapes a model emits through Ollama's
 *  schema-guided output. Unicode first, structural backslash last (so a
 *  `\\n` literal isn't turned into a newline). Best-effort: exotic escapes
 *  a dictation-cleanup model never emits are left as-is. */
function unescapeJsonStringBody(s: string): string {
	return s
		.replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16)))
		.replace(/\\n/g, "\n")
		.replace(/\\r/g, "\r")
		.replace(/\\t/g, "\t")
		.replace(/\\b/g, "\b")
		.replace(/\\f/g, "\f")
		.replace(/\\\//g, "/")
		.replace(/\\"/g, '"')
		.replace(/\\\\/g, "\\");
}

/** Salvage the `text` value from a near-miss envelope: the model closed the
 *  JSON string with a smart/curly quote instead of `"`, dropped the closing
 *  brace, or ran out of tokens mid-string. Without this the raw
 *  `{ "text": "…\n…"}` (escapes and all) leaks straight into the paste —
 *  exactly the failure users hit when a model substitutes “ for ". */
function peelSalvageScaffold(rawBody: string): string {
	return (
		rawBody
			// A truncated tail can end on a lone escape backslash — drop it so
			// the unescape pass below doesn't eat the next real character.
			.replace(TRAILING_BACKSLASH_RE, "")
			// Peel the trailing scaffold the broken JSON left behind: an
			// optional closing brace and/or one closing quote (straight OR the
			// smart quote that broke `JSON.parse` in the first place).
			.replace(TRAILING_BRACE_RE, "")
			.replace(TRAILING_QUOTE_RE, "")
	);
}

function salvageFromMatch(m: RegExpMatchArray): string | null {
	const body = peelSalvageScaffold(m[1] ?? "");
	const out = unescapeJsonStringBody(body).trim();
	return out.length > 0 ? out : null;
}

function salvageStructuredText(content: string): string | null {
	const m = content.match(PARTIAL_STRUCTURED_TEXT_RE);
	return m ? salvageFromMatch(m) : null;
}

/**
 * Best-effort extraction of `learned_proper_nouns` from the structured
 * envelope. Returns an empty array when the field is missing or the
 * payload couldn't be parsed (the field is `optional` in the schema so
 * a model that skips it isn't an error). Filters to non-empty strings
 * and caps at 10 entries — the schema says ≤5 but a leaky model
 * occasionally over-emits; we don't want a single bad cleanup turning
 * into a dictionary spam attack.
 */
function stripMarkdownFences(content: string): string {
	return content
		.trim()
		.replace(MARKDOWN_FENCE_OPEN_RE, "")
		.replace(MARKDOWN_FENCE_CLOSE_RE, "")
		.trim();
}

function tryParseJson(input: string): unknown {
	try {
		return JSON.parse(input);
	} catch {
		return null;
	}
}

function isParsedObjectWithNouns(parsed: unknown): parsed is { learned_proper_nouns: unknown } {
	return (
		Boolean(parsed) && typeof parsed === "object" && "learned_proper_nouns" in (parsed as object)
	);
}

function readRawNounsArray(parsed: unknown): unknown[] | null {
	if (!isParsedObjectWithNouns(parsed)) {
		return null;
	}
	const raw = parsed.learned_proper_nouns;
	return Array.isArray(raw) ? raw : null;
}

function isAcceptableNounString(item: unknown): item is string {
	if (typeof item !== "string") {
		return false;
	}
	const value = item.trim();
	if (value.length === 0) {
		return false;
	}
	return value.length <= 60;
}

const MAX_LEARNED_NOUNS = 10;

function appendCleanedNoun(cleaned: string[], item: unknown): boolean {
	if (!isAcceptableNounString(item)) {
		return false;
	}
	cleaned.push(item.trim());
	return cleaned.length >= MAX_LEARNED_NOUNS;
}

function cleanupRawNouns(raw: readonly unknown[]): string[] {
	const cleaned: string[] = [];
	for (const item of raw) {
		if (appendCleanedNoun(cleaned, item)) {
			break;
		}
	}
	return cleaned;
}

function extractLearnedProperNouns(content: string): readonly string[] {
	const trimmed = stripMarkdownFences(content);
	if (!trimmed.startsWith("{")) {
		return [];
	}
	const parsed = tryParseJson(trimmed);
	const raw = readRawNounsArray(parsed);
	if (!raw) {
		return [];
	}
	return cleanupRawNouns(raw);
}

/**
 * Try to parse the chat content as the structured-output JSON envelope
 * `{ "text": "..." }`. Returns the inner text on success, `null` when
 * the content isn't an envelope at all (model didn't honor `format`) — in
 * which case we fall through to the legacy extractors below. Strict
 * `JSON.parse` is the happy path; a malformed-but-recognisable envelope
 * (smart-quote close, missing brace, truncation) is salvaged rather than
 * leaked verbatim.
 */
function isParsedObjectWithText(parsed: unknown): parsed is { text: unknown } {
	return Boolean(parsed) && typeof parsed === "object" && "text" in (parsed as object);
}

function readEnvelopeText(parsed: unknown): string | null {
	if (!isParsedObjectWithText(parsed)) {
		return null;
	}
	const candidate = parsed.text;
	return typeof candidate === "string" ? candidate : null;
}

function extractStructuredFinalText(content: string): string | null {
	const trimmed = stripMarkdownFences(content);
	if (!trimmed.startsWith("{")) {
		return null;
	}
	const parsed = tryParseJson(trimmed);
	const envelopeText = readEnvelopeText(parsed);
	if (envelopeText !== null) {
		// Surface the proper nouns as a side effect — the cleanup
		// call's return type stays a single string (compatible with
		// every existing caller) but Phase 3b's dictionary auto-add
		// pipeline reads from the broadcast channel.
		broadcastLearnedProperNouns(extractLearnedProperNouns(trimmed));
		return envelopeText;
	}
	return salvageStructuredText(trimmed);
}

function tryStructuredAnswer(content: string): string | null {
	const structured = extractStructuredFinalText(content);
	if (structured === null) {
		return null;
	}
	const trimmedStructured = structured.trim();
	return trimmedStructured || null;
}

function broadcastIfPresent(value: string): void {
	if (value) {
		broadcastReasoningDelta(value);
	}
}

function tryLeakageAnswerVia(
	answer: string,
	extractor: (s: string) => { thinking: string; answer: string } | null
): string | null {
	const extracted = extractor(answer);
	if (!extracted) {
		return null;
	}
	broadcastIfPresent(extracted.thinking);
	return extracted.answer;
}

function logTruncationIfNonStop(doneReason: string | undefined): void {
	if (doneReason && doneReason !== "stop") {
		dbg("llm", `Ollama chat answer ok but done_reason=${doneReason} (possible truncation)`);
	}
}

function logEmptyContentReason(state: OllamaChatStreamState): void {
	if (state.doneReason === "length") {
		dbg(
			"llm",
			`Ollama chat exhausted num_predict before producing content (thinking=${state.thinking.length} chars). Raise the num_predict floor.`
		);
		return;
	}
	dbg(
		"llm",
		`Empty content from Ollama chat stream (done_reason=${state.doneReason ?? "unknown"}), using original text`
	);
}

// Chain-of-thought leakage extractors, tried in priority order. Each returns
// the answer when its convention matched, or null to fall through.
const LEAKAGE_EXTRACTORS: ReadonlyArray<
	(s: string) => { thinking: string; answer: string } | null
> = [extractHarmonyAnswer, extractBoxedAnswer];

function tryAnyLeakageAnswer(answer: string): string | null {
	for (const extractor of LEAKAGE_EXTRACTORS) {
		const result = tryLeakageAnswerVia(answer, extractor);
		if (result !== null) {
			return result;
		}
	}
	return null;
}

function finalizeAnswerOrFallback(
	answer: string,
	state: OllamaChatStreamState,
	fallback: string
): string {
	if (answer) {
		logTruncationIfNonStop(state.doneReason);
		return answer;
	}
	logEmptyContentReason(state);
	return fallback;
}

function finalizeChatAnswer(state: OllamaChatStreamState, fallback: string): string {
	// Preferred path: Ollama's structured-outputs guidance forced the model
	// to emit `{ "text": "..." }`. Parsing the envelope is the cheapest,
	// most reliable extraction — no regex, no heuristics, no per-model
	// special-casing required.
	const structured = tryStructuredAnswer(state.content);
	if (structured !== null) {
		return structured;
	}
	const { thinking: inlineThinking, answer } = splitInlineThinking(state.content);
	broadcastIfPresent(inlineThinking);
	// Chain-of-thought leakage paths: Ollama recognizes the model as
	// supporting thinking and we set `think: true`, but the runtime parser
	// for this specific checkpoint doesn't strip the reasoning — it all
	// lands in `content`. Apply known final-answer conventions here so
	// Qwen-Math / DeepSeek-Math / unrecognized gpt-oss outputs paste the
	// final answer instead of the whole reasoning trace.
	const leakageAnswer = tryAnyLeakageAnswer(answer);
	if (leakageAnswer !== null) {
		return leakageAnswer;
	}
	return finalizeAnswerOrFallback(answer, state, fallback);
}

async function assertOllamaResponseOk(
	response: Response,
	ctx: { endpoint: string; model: string; presets: string }
): Promise<void> {
	if (response.ok) {
		return;
	}
	const errorText = await readErrorText(response);
	throw new ConnectionError(
		`LLM API request failed: HTTP ${response.status} - ${errorText}`,
		ctx.endpoint,
		false,
		{ model: ctx.model, presets: ctx.presets, statusCode: response.status }
	);
}

// Ollama unloads idle models after 5 min by default. Asking for 30 min on
// every request lets a warm model stay hot between dictations and survives
// the periodic warmup interval below (which re-hits the model well within
// this window). The warmup loop is the *only* thing keeping the model alive
// across long pauses; the chat-body keep_alive just makes sure each
// successful call resets the timer.
const OLLAMA_KEEP_ALIVE = "30m";

/**
 * Effort level for thinking-capable Ollama models. Maps directly onto
 * Ollama's `ThinkValue` (boolean or string). `"off"` disables thinking
 * entirely (`think: false`); the three string levels are passed through
 * verbatim and respected by reasoning models that honor them. Older
 * thinking models without an effort knob treat any truthy `think` as
 * "on" and ignore the level.
 */
export type ThinkingEffort = "off" | "low" | "medium" | "high";

function thinkingFlagFor(effort: ThinkingEffort, supportsThinking: boolean): unknown {
	if (!supportsThinking || effort === "off") {
		return false;
	}
	// Ollama accepts a plain boolean for "default effort" or a string
	// for explicit budget level. Sending the string for "high" lets
	// reasoning models like gpt-oss honor the requested depth.
	return effort;
}

/**
 * Structured-output schema enforced via Ollama's `format` field. The model
 * is guided AT THE TOKEN LEVEL to emit `{"text": "<answer>"}` JSON — no
 * reasoning prose, no preambles, no `\boxed{}` math-mode artifacts. This
 * is the same constraint we already apply to OpenRouter via Vercel AI
 * SDK's `generateObject`, ported to Ollama's native structured-outputs
 * API (Ollama ≥ 0.5; the field is a JSON Schema object per their docs).
 *
 * Even for reasoning models, the schema only constrains `message.content` —
 * `message.thinking` remains free-form, so the model can still reason
 * before committing to its answer. The schema just prevents the final
 * content channel from leaking that reasoning.
 */
const OLLAMA_STRUCTURED_OUTPUT_SCHEMA = {
	type: "object",
	properties: {
		text: {
			type: "string",
			description:
				"The transformed text only. No reasoning, no steps, no preambles, no commentary.",
		},
		learned_proper_nouns: {
			type: "array",
			items: { type: "string" },
			description: LEARNED_PROPER_NOUNS_DESCRIPTION,
		},
	},
	required: ["text"],
	additionalProperties: false,
} as const;

function buildOllamaChatBody(
	model: string,
	messages: OllamaChatMessage[],
	textLength: number,
	options?: { supportsThinking?: boolean; effort?: ThinkingEffort }
): string {
	const supportsThinking = options?.supportsThinking ?? true;
	const effort = options?.effort ?? "medium";
	return JSON.stringify({
		model,
		messages,
		// Stream so reasoning models (Qwen3, deepseek-r1, gpt-oss, …) can
		// surface `message.thinking` chunks to the pill as they're produced.
		// Non-reasoning models stream their `message.content` the same way;
		// the consumer reassembles it server-side before returning to relay.
		stream: true,
		// Opt into separated thinking content per the per-model capability
		// reported by `/api/show`. Sending `think: true` to a model that
		// doesn't advertise the capability is an HTTP 400 in modern Ollama,
		// so we gate this carefully. The `effort` string is honored by
		// reasoning models that support tiered budgets; older thinking
		// models treat any truthy value as a plain "on".
		think: thinkingFlagFor(effort, supportsThinking),
		// Structured outputs — the JSON schema is enforced at the token
		// generation level, so the model literally cannot emit anything
		// outside the schema. This replaces the prompt-engineering arms
		// race for "stop emitting chain-of-thought into content."
		format: OLLAMA_STRUCTURED_OUTPUT_SCHEMA,
		keep_alive: OLLAMA_KEEP_ALIVE,
		options: {
			temperature: 0.3,
			top_p: 0.9,
			// Headroom for thinking models: Qwen3 / deepseek-r1 / gpt-oss
			// regularly burn 2-4k tokens on the reasoning trace before
			// emitting a single `content` token. A 512-token floor lets
			// thinking exhaust the budget (`done_reason: "length"`) before
			// the final answer is produced — observable as "the pill shows
			// streaming reasoning then pastes the input verbatim." An 8k
			// floor covers every reasoning model we've tested; non-reasoning
			// models stop emitting at their natural endpoint long before
			// the cap so the larger budget is free.
			num_predict: Math.max(textLength * 4, 8192),
		},
	});
}

function buildAuthHeaders(apiKey: string): Record<string, string> {
	const base: Record<string, string> = { "Content-Type": "application/json" };
	if (apiKey) {
		base.Authorization = `Bearer ${apiKey}`;
	}
	return base;
}

function stripTildePrefix(value: string): string {
	if (value.startsWith("~")) {
		return value.slice(1);
	}
	return value;
}

function repairOpenRouterText(raw: string): string {
	const stripped = raw
		.trim()
		.replace(MARKDOWN_FENCE_OPEN_RE, "")
		.replace(MARKDOWN_FENCE_CLOSE_RE, "")
		.trim();
	try {
		JSON.parse(stripped);
		return stripped;
	} catch {
		const inner = stripped.replace(SURROUNDING_QUOTES_RE, "");
		return JSON.stringify({ text: inner });
	}
}

function buildModelOptions(providerSlug: string | undefined): Record<string, unknown> {
	if (!providerSlug) {
		return {};
	}
	return {
		extraBody: { provider: { order: [providerSlug], allow_fallbacks: false } },
	};
}

function resolveOpenRouterModelId(modelId: string): string {
	if (modelId) {
		return modelId;
	}
	return "openrouter/auto";
}

function returnTextIfEmpty(generated: string, fallback: string): string {
	if (generated) {
		return generated;
	}
	dbg("llm", "Empty output from OpenRouter, using original text");
	return fallback;
}

function enrichOpenRouterModel(m: z.infer<typeof openRouterModelSchema>): OpenRouterScanModel {
	const { maker, model_name, variant } = parseMakerAndName(m.id);
	// Normalize `null` → `undefined` so the public shape (and the openapi-typed
	// frontend) doesn't have to thread null-handling through every downstream
	// renderer. OpenRouter is inconsistent about this — some endpoints return
	// `null`, others omit the field entirely; we collapse both to "absent".
	return llmOmitUndefined({
		id: m.id,
		name: m.name,
		description: nullishToUndefined(m.description),
		context_length: nullishToUndefined(m.context_length),
		pricing: nullishToUndefined(m.pricing),
		provider: "openrouter",
		maker,
		model_name,
		variant,
		supported_parameters: nullishToUndefined(m.supported_parameters),
		architecture: nullishToUndefined(m.architecture),
	}) as OpenRouterScanModel;
}

/**
 * The `/models` listing returns a marketing blurb already truncated by
 * OpenRouter (often ending with `...` or `…`). The per-model `/endpoints`
 * detail returns the full description. Prefer the longer one — and if both
 * look truncated, prefer the one without a trailing ellipsis.
 */
function endsWithEllipsis(value: string): boolean {
	return value.endsWith("...") || value.endsWith("…");
}

type EllipsisPair = "both" | "neither" | "a-only" | "b-only";

const ELLIPSIS_PAIR_LOOKUP: Record<string, EllipsisPair> = {
	"false,false": "neither",
	"true,false": "a-only",
	"false,true": "b-only",
	"true,true": "both",
};

function classifyEllipsisPair(a: string, b: string): EllipsisPair {
	const key = `${endsWithEllipsis(a)},${endsWithEllipsis(b)}`;
	return ELLIPSIS_PAIR_LOOKUP[key] as EllipsisPair;
}

function pickLongerOfTwo(a: string, b: string, listing: string, detail: string): string {
	return b.length > a.length ? detail : listing;
}

function pickByEllipsisOrLength(
	pair: EllipsisPair,
	a: string,
	b: string,
	listing: string,
	detail: string
): string {
	const lookup: Record<EllipsisPair, () => string> = {
		"a-only": () => detail,
		"b-only": () => listing,
		both: () => pickLongerOfTwo(a, b, listing, detail),
		neither: () => pickLongerOfTwo(a, b, listing, detail),
	};
	return lookup[pair]();
}

function pickWhenBothPresent(listing: string, detail: string): string {
	const a = listing.trimEnd();
	const b = detail.trimEnd();
	return pickByEllipsisOrLength(classifyEllipsisPair(a, b), a, b, listing, detail);
}

function pickLongerDescription(
	listing: string | undefined,
	detail: string | undefined
): string | undefined {
	if (!listing) {
		return detail;
	}
	if (!detail) {
		return listing;
	}
	return pickWhenBothPresent(listing, detail);
}

/**
 * Split a model id (`author/slug` or `author/slug:variant`) into the parts
 * needed to build the `/models/{author}/{slug}/endpoints` URL. Returns null
 * when the id doesn't carry both an author and a slug — those models
 * (synthetic `openrouter/auto`, malformed ids) simply have no detail page.
 */
function splitAuthorSlug(modelId: string): string | null {
	const [authorSlug] = modelId.split(":");
	return authorSlug || null;
}

function isValidAuthorSlugTuple(author: string | undefined, slugParts: string[]): author is string {
	return Boolean(author) && slugParts.length > 0;
}

function splitAuthorAndSlugParts(
	authorSlug: string
): { author: string; slugParts: string[] } | null {
	const parts = authorSlug.split("/");
	if (parts.length < 2) {
		return null;
	}
	const [author, ...slugParts] = parts;
	return isValidAuthorSlugTuple(author, slugParts) ? { author, slugParts } : null;
}

function parseModelIdForDetail(modelId: string): { author: string; slug: string } | null {
	const authorSlug = splitAuthorSlug(modelId);
	if (!authorSlug) {
		return null;
	}
	const parts = splitAuthorAndSlugParts(authorSlug);
	if (!parts) {
		return null;
	}
	return { author: parts.author, slug: parts.slugParts.join("/") };
}

/**
 * Fetch the per-model detail (`description` + `endpoints[]`) from
 * `/api/v1/models/{author}/{slug}/endpoints`. Returns null when the request
 * fails or the payload doesn't match the schema — callers fall back to the
 * un-enriched model in that case so a single failure doesn't poison the list.
 */
async function tryReadJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

function isResponseUsable(response: Response | { error: string }): response is Response {
	if (isFetchError(response)) {
		return false;
	}
	return response.ok;
}

function parseEndpointsPayload(
	json: unknown
): z.infer<typeof openRouterEndpointsDetailSchema> | null {
	const parsedJson = openRouterEndpointsResponseSchema.safeParse(json);
	if (!parsedJson.success) {
		return null;
	}
	return parsedJson.data.data ?? null;
}

function buildEndpointsResult(data: z.infer<typeof openRouterEndpointsDetailSchema>): {
	description?: string;
	endpoints: z.infer<typeof openRouterEndpointSchema>[];
} {
	const endpoints = data.endpoints ?? [];
	if (data.description === undefined) {
		return { endpoints };
	}
	return { description: data.description, endpoints };
}

async function fetchModelEndpointsResponse(
	modelId: string,
	parsed: { author: string; slug: string },
	apiKey: string
): Promise<Response | null> {
	const url = `https://openrouter.ai/api/v1/models/${parsed.author}/${parsed.slug}/endpoints`;
	const response = await safeFetch(
		url,
		{
			method: "GET",
			headers: buildAuthHeaders(apiKey),
			signal: AbortSignal.timeout(10_000),
		},
		`OpenRouter /endpoints for ${modelId}`
	);
	if (!isResponseUsable(response)) {
		return null;
	}
	return response;
}

async function fetchAndParseEndpointsData(
	response: Response
): Promise<z.infer<typeof openRouterEndpointsDetailSchema> | null> {
	const json = await tryReadJson(response);
	return json === null ? null : parseEndpointsPayload(json);
}

async function fetchModelEndpointsResolved(
	modelId: string,
	parsed: { author: string; slug: string },
	apiKey: string
): Promise<{ description?: string; endpoints: z.infer<typeof openRouterEndpointSchema>[] } | null> {
	const response = await fetchModelEndpointsResponse(modelId, parsed, apiKey);
	if (!response) {
		return null;
	}
	const data = await fetchAndParseEndpointsData(response);
	return data ? buildEndpointsResult(data) : null;
}

async function fetchModelEndpoints(
	modelId: string,
	apiKey: string
): Promise<{ description?: string; endpoints: z.infer<typeof openRouterEndpointSchema>[] } | null> {
	const parsed = parseModelIdForDetail(modelId);
	return parsed ? await fetchModelEndpointsResolved(modelId, parsed, apiKey) : null;
}

/**
 * Tiny inline concurrency limiter — avoids pulling in the `p-limit` dependency
 * for a one-call-site need. Caps the number of in-flight promises returned by
 * `task()` at `limit`. Each input is passed through `task` and the resolved
 * results are returned in input order.
 */
async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	task: (item: T) => Promise<R>
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let cursor = 0;
	const workerCount = Math.min(limit, items.length);
	const runWorker = async () => {
		while (cursor < items.length) {
			const myIndex = cursor++;
			results[myIndex] = await task(items[myIndex] as T);
		}
	};
	await Promise.all(Array.from({ length: workerCount }, runWorker));
	return results;
}

/**
 * Enrich the top-level model list with per-model endpoint detail, in
 * parallel, with a fixed concurrency cap. After this runs, every model
 * carries the array of infrastructure providers hosting it (plus their
 * pricing, quantization, max_completion_tokens, supported_parameters, etc.),
 * which is what the picker's provider rail / feature chips / quantization
 * chips actually need to render.
 *
 * Failures on individual models are swallowed and the model is returned
 * with its un-enriched (endpoint-less) shape — a single 429 on a niche model
 * shouldn't blank out the whole catalog.
 */
const OPENROUTER_ENRICHMENT_CONCURRENCY = 10;

function applyEndpointDetailToModel(
	model: OpenRouterScanModel,
	detail: { description?: string; endpoints: z.infer<typeof openRouterEndpointSchema>[] }
): OpenRouterScanModel {
	const description = pickLongerDescription(model.description, detail.description);
	const { description: _omitted, ...rest } = model;
	if (description === undefined) {
		return { ...rest, endpoints: detail.endpoints };
	}
	return { ...rest, endpoints: detail.endpoints, description };
}

async function enrichSingleOpenRouterModel(
	model: OpenRouterScanModel,
	apiKey: string
): Promise<OpenRouterScanModel> {
	try {
		const detail = await fetchModelEndpoints(model.id, apiKey);
		if (!detail) {
			return model;
		}
		return applyEndpointDetailToModel(model, detail);
	} catch (err) {
		dbg("llm", `Failed to enrich ${model.id}:`, getErrorMessage(err));
		return model;
	}
}

function enrichOpenRouterModelsWithEndpoints(
	models: readonly OpenRouterScanModel[],
	apiKey: string
): Promise<OpenRouterScanModel[]> {
	return mapWithConcurrency(models, OPENROUTER_ENRICHMENT_CONCURRENCY, (model) =>
		enrichSingleOpenRouterModel(model, apiKey)
	);
}

function parseOpenRouterModelsOrFail(json: unknown): OpenRouterScanResult {
	const parsed = openRouterModelsResponseSchema.safeParse(json);
	if (!parsed.success) {
		dbg("llm", "OpenRouter /models response did not match expected schema:", parsed.error.message);
		return { models: [], reachable: true, error: "Unexpected response shape from OpenRouter" };
	}
	return {
		models: (parsed.data.data ?? []).map(enrichOpenRouterModel),
		reachable: true,
	};
}

// ── Ollama: /api/show capability fetcher ──────────────────────────────
//
// Ollama's `/api/show` reports a `capabilities` array per model:
//   ["completion", "tools", "thinking", "vision", "insert"]
// We use it for two things:
//   1. Conditionally setting `think: true` on chat bodies — sending it
//      to a model Ollama doesn't recognize as thinking-capable triggers
//      an HTTP 400 ("thinking is not supported by this model").
//   2. Surfacing the `thinking` flag to the renderer's model picker so
//      the user gets a "reasoning" badge next to qualifying models.
//
// The endpoint is per-model so we cache aggressively — capabilities only
// change when the user pulls a different blob for the same tag, which
// is rare. A 5-minute soft TTL is plenty.

interface CachedCapabilities {
	at: number;
	caps: readonly string[];
}

const CAPABILITIES_TTL_MS = 5 * 60 * 1000;
const capabilitiesCache = new Map<string, CachedCapabilities>();

function capabilitiesCacheKey(endpoint: string, model: string): string {
	return `${endpoint}::${model}`;
}

function getCachedCapabilities(endpoint: string, model: string): readonly string[] | null {
	const cached = capabilitiesCache.get(capabilitiesCacheKey(endpoint, model));
	if (!cached) {
		return null;
	}
	if (Date.now() - cached.at > CAPABILITIES_TTL_MS) {
		return null;
	}
	return cached.caps;
}

async function requestOllamaShow(
	normalizedEndpoint: string,
	model: string
): Promise<Response | null> {
	const response = await fetch(buildOllamaApiUrl(normalizedEndpoint, "/api/show"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model }),
		signal: AbortSignal.timeout(5000),
	});
	if (!response.ok) {
		dbg("llm", `Ollama /api/show ${model} → HTTP ${response.status}`);
		return null;
	}
	return response;
}

function parseShowResponseCaps(json: unknown, model: string): readonly string[] | null {
	const parsed = ollamaShowResponseSchema.safeParse(json);
	if (!parsed.success) {
		dbg("llm", `Ollama /api/show ${model} schema mismatch`);
		return null;
	}
	return Object.freeze(parsed.data.capabilities ?? []);
}

function cacheCapabilities(endpoint: string, model: string, caps: readonly string[]): void {
	capabilitiesCache.set(capabilitiesCacheKey(endpoint, model), {
		at: Date.now(),
		caps,
	});
}

async function tryLoadOllamaCapabilitiesOrEmpty(
	normalizedEndpoint: string,
	endpoint: string,
	model: string
): Promise<readonly string[]> {
	const response = await requestOllamaShow(normalizedEndpoint, model);
	if (!response) {
		return [];
	}
	const json: unknown = await response.json();
	const caps = parseShowResponseCaps(json, model);
	if (!caps) {
		return [];
	}
	cacheCapabilities(endpoint, model, caps);
	return caps;
}

async function loadOllamaCapabilities(
	normalizedEndpoint: string,
	endpoint: string,
	model: string
): Promise<readonly string[]> {
	try {
		return await tryLoadOllamaCapabilitiesOrEmpty(normalizedEndpoint, endpoint, model);
	} catch (err) {
		dbg("llm", `Ollama /api/show ${model} failed:`, getErrorMessage(err));
		return [];
	}
}

async function fetchOllamaCapabilities(
	endpoint: string,
	model: string
): Promise<readonly string[]> {
	const cached = getCachedCapabilities(endpoint, model);
	if (cached) {
		return cached;
	}
	const normalizedEndpoint = normalizeOllamaEndpoint(endpoint);
	if (!normalizedEndpoint) {
		return [];
	}
	return await loadOllamaCapabilities(normalizedEndpoint, endpoint, model);
}

async function modelSupportsThinking(endpoint: string, model: string): Promise<boolean> {
	const caps = await fetchOllamaCapabilities(endpoint, model);
	return caps.includes("thinking");
}

// ── Ollama: scan + process ────────────────────────────────────────────

export async function scanOllamaModels(endpoint: string): Promise<OllamaScanResult> {
	assertNonEmptyString(endpoint, "LLM endpoint is required", "endpoint");
	const normalizedEndpoint = assertValidEndpoint(endpoint);

	const response = await safeFetch(
		buildOllamaApiUrl(normalizedEndpoint, "/api/tags"),
		{
			method: "GET",
			headers: { "Content-Type": "application/json" },
			signal: AbortSignal.timeout(5000),
		},
		`Ollama at ${normalizedEndpoint}`
	);
	if (isFetchError(response)) {
		return { models: [], reachable: false, error: response.error };
	}
	if (!response.ok) {
		const message = `Ollama /api/tags returned HTTP ${response.status}`;
		dbg("llm", `${message} at ${normalizedEndpoint}`);
		return { models: [], reachable: true, error: message };
	}

	const json: unknown = await response.json();
	const result = parseOllamaTagsOrFail(json);
	// Enrich each model with its `/api/show` capability set so the renderer
	// can render reasoning badges and the chat-body builder can suppress
	// `think: true` for non-thinking models. Concurrent — each /api/show
	// is a small, fast call that the local Ollama answers from its
	// metadata cache. Failures fall back to undefined capabilities.
	const enriched = await Promise.all(
		result.models.map(async (m) => {
			const caps = await fetchOllamaCapabilities(normalizedEndpoint, m.name);
			return caps.length > 0 ? { ...m, capabilities: caps } : m;
		})
	);
	return { ...result, models: enriched };
}

function buildOllamaDictationMessages(systemPrompt: string, text: string): OllamaChatMessage[] {
	const userPrompt = `Transform the following text according to the style guide above. Return ONLY the transformed text with no additional commentary, explanations, or JSON formatting. Just the plain transformed text.\n\nText to transform:\n${text}`;
	return [
		{ role: "system", content: systemPrompt },
		{ role: "user", content: userPrompt },
	];
}

async function processWithOllama(
	text: string,
	model: string,
	presets: readonly PresetEntry[],
	endpoint: string,
	_timeout: number,
	context: string,
	thinkingEffort: ThinkingEffort
): Promise<string> {
	assertNonEmptyString(model, "Ollama model is required", "model");
	const normalizedEndpoint = assertValidEndpoint(endpoint);

	const systemPrompt = buildDictationSystemPrompt(presets, context);
	const messages = buildOllamaDictationMessages(systemPrompt, text);

	// Client-side timeout DISABLED — local LLMs (Ollama) routinely exceed
	// 30s on cold start, and a silent abort + original-text paste is
	// misleading. The pill stays visible until the model completes. The
	// `_timeout` parameter is preserved for wiring/settings compatibility
	// but ignored at the network layer. Cancellation IS supported via
	// `abortActiveOllamaChats()` so a model swap can release Ollama's
	// per-model serializer instead of queueing behind a slow stream.
	const controller = new AbortController();
	registerChatController(controller);
	const supportsThinking = await modelSupportsThinking(normalizedEndpoint, model);
	try {
		return await executeOllamaChatRequest(
			normalizedEndpoint,
			model,
			messages,
			text,
			{ supportsThinking, effort: thinkingEffort },
			describePresets(presets),
			controller
		);
	} catch (err) {
		return handleOllamaChatAbort(err, controller, "Ollama chat", text);
	} finally {
		unregisterChatController(controller);
	}
}

// ── OpenRouter: scan + process via AI SDK ─────────────────────────────

function parseModelVariant(modelId: string): {
	baseModelId: string;
	variant: KnownVariant | undefined;
} {
	for (const variant of KNOWN_VARIANTS) {
		const suffix = `:${variant}`;
		if (modelId.endsWith(suffix)) {
			return { baseModelId: modelId.slice(0, -suffix.length), variant };
		}
	}
	return { baseModelId: modelId, variant: undefined };
}

function buildMakerName(
	parts: string[],
	variant: KnownVariant | undefined
): {
	maker: string | undefined;
	model_name: string | undefined;
	variant: KnownVariant | undefined;
} {
	const rawMaker = parts[0];
	const maker = rawMaker ? stripTildePrefix(rawMaker) : undefined;
	return { maker, model_name: parts.slice(1).join("/"), variant };
}

function parseMakerAndName(modelId: string): {
	maker: string | undefined;
	model_name: string | undefined;
	variant: KnownVariant | undefined;
} {
	const { baseModelId, variant } = parseModelVariant(modelId);
	const parts = baseModelId.split("/").filter(Boolean);
	if (parts.length === 0) {
		return { maker: undefined, model_name: undefined, variant };
	}
	if (parts.length === 1) {
		return { maker: undefined, model_name: parts[0], variant };
	}
	return buildMakerName(parts, variant);
}

function openRouterModelsFetchErrorToResult(
	response: Response | { error: string }
): OpenRouterScanResult | null {
	if (isFetchError(response)) {
		return { models: [], reachable: false, error: response.error };
	}
	if (!response.ok) {
		const message = `OpenRouter /models returned HTTP ${response.status}`;
		dbg("llm", message);
		return { models: [], reachable: true, error: message };
	}
	return null;
}

function isOpenRouterResultEnrichable(baseResult: OpenRouterScanResult): boolean {
	if (baseResult.error) {
		return false;
	}
	return baseResult.models.length > 0;
}

async function safeEnrichOpenRouterResult(
	baseResult: OpenRouterScanResult,
	apiKey: string
): Promise<OpenRouterScanResult> {
	try {
		const enriched = await enrichOpenRouterModelsWithEndpoints(baseResult.models, apiKey);
		return { ...baseResult, models: enriched };
	} catch (err) {
		// Enrichment failure is non-fatal — fall back to the un-enriched list
		// so the picker at least shows the model names. Individual per-model
		// failures are already swallowed inside the enrichment loop.
		dbg("llm", "OpenRouter endpoint enrichment failed:", getErrorMessage(err));
		return baseResult;
	}
}

async function tryEnrichOpenRouterResult(
	baseResult: OpenRouterScanResult,
	apiKey: string
): Promise<OpenRouterScanResult> {
	if (!isOpenRouterResultEnrichable(baseResult)) {
		return baseResult;
	}
	return await safeEnrichOpenRouterResult(baseResult, apiKey);
}

export async function scanOpenRouterModels(apiKey: string): Promise<OpenRouterScanResult> {
	const response = await safeFetch(
		"https://openrouter.ai/api/v1/models",
		{
			method: "GET",
			headers: buildAuthHeaders(apiKey),
			signal: AbortSignal.timeout(15_000),
		},
		"OpenRouter /models"
	);
	const errorResult = openRouterModelsFetchErrorToResult(response);
	if (errorResult) {
		return errorResult;
	}
	const json: unknown = await (response as Response).json();
	const baseResult = parseOpenRouterModelsOrFail(json);
	// Fan out per-model `/endpoints` fetches in parallel (concurrency capped)
	// to enrich each model with its infrastructure providers. The provider
	// rail, per-provider pricing, quantization chips, tool/structured-output
	// icons, and reasoning chips all read off this enriched data.
	return await tryEnrichOpenRouterResult(baseResult, apiKey);
}

function assertOpenRouterApiKey(apiKey: string): void {
	if (!apiKey) {
		throw new ValidationError("OpenRouter API key is required", "apiKey");
	}
}

function buildOpenRouterClient(apiKey: string) {
	return createOpenRouter({
		apiKey,
		headers: {
			"HTTP-Referer": "https://github.com/winstt/winstt",
			"X-Title": "WinSTT",
		},
	});
}

function isAcceptableUniqueNoun(value: string, seen: Set<string>): boolean {
	if (value.length === 0) {
		return false;
	}
	if (value.length > 60) {
		return false;
	}
	return !seen.has(value);
}

function normalizeNounCandidate(raw: unknown): string {
	if (typeof raw !== "string") {
		return "";
	}
	return raw.trim();
}

function appendUniqueOpenRouterNoun(
	cleanedNouns: string[],
	seen: Set<string>,
	raw: unknown
): boolean {
	const value = normalizeNounCandidate(raw);
	if (!isAcceptableUniqueNoun(value, seen)) {
		return false;
	}
	seen.add(value);
	cleanedNouns.push(value);
	return cleanedNouns.length >= MAX_LEARNED_NOUNS;
}

function cleanOpenRouterNouns(rawNouns: readonly unknown[]): string[] {
	const seen = new Set<string>();
	const cleanedNouns: string[] = [];
	for (const raw of rawNouns) {
		if (appendUniqueOpenRouterNoun(cleanedNouns, seen, raw)) {
			break;
		}
	}
	return cleanedNouns;
}

const OPENROUTER_DICTATION_PROVIDER_OPTIONS = {
	openrouter: {
		plugins: [{ id: "response-healing" }],
	},
};

async function runOpenRouterGenerate(
	model: ReturnType<ReturnType<typeof createOpenRouter>["chat"]>,
	systemPrompt: string,
	userPrompt: string
) {
	return await generateObject({
		model,
		system: systemPrompt,
		prompt: userPrompt,
		schemaName: "TransformedText",
		schemaDescription: "The transformed text only.",
		schema: transformedTextSchema,
		// Some providers (notably Anthropic via OpenRouter) return JSON wrapped
		// in markdown fences or with leading commentary. The OpenRouter
		// `response-healing` plugin handles this server-side; this fallback
		// repairs anything that still slips through.
		experimental_repairText: ({ text: raw }) => Promise.resolve(repairOpenRouterText(raw)),
		providerOptions: OPENROUTER_DICTATION_PROVIDER_OPTIONS,
	});
}

async function processWithOpenRouter(
	text: string,
	apiKey: string,
	modelSelection: string,
	presets: readonly PresetEntry[],
	_timeout: number,
	context: string
): Promise<string> {
	assertOpenRouterApiKey(apiKey);
	const { modelId, providerSlug } = parseModelSelection(modelSelection);
	const effectiveModelId = resolveOpenRouterModelId(modelId);

	const systemPrompt = buildDictationSystemPrompt(presets, context);
	const userPrompt = `Transform the following text according to the style guide above. ${STRUCTURED_OUTPUT_DESCRIPTION}\n\nText to transform:\n${text}`;

	const openrouter = buildOpenRouterClient(apiKey);
	const model = openrouter.chat(effectiveModelId, buildModelOptions(providerSlug));

	// Client-side timeout DISABLED — `_timeout` is wired through for
	// settings compatibility but the model runs to completion.
	const result = await runOpenRouterGenerate(model, systemPrompt, userPrompt);

	// Surface any proper nouns the model identified — same channel the
	// Ollama path uses, so the dictionary auto-add UI doesn't care which
	// provider answered. Filter / cap defensively even though the schema
	// already constrains `learned_proper_nouns`: provider quirks (extra
	// whitespace, occasional dupes) are cheaper to handle here than in
	// every consumer.
	const rawNouns = result.object.learned_proper_nouns ?? [];
	broadcastLearnedProperNouns(cleanOpenRouterNouns(rawNouns));

	return returnTextIfEmpty(result.object.text.trim(), text);
}

// ── processText: dispatch + error mapping ─────────────────────────────

interface ProcessTextCtx {
	presets: readonly PresetEntry[];
	provider: string;
	timeout: number;
}

function isPassThroughError(err: unknown): boolean {
	if (err instanceof ConnectionError) {
		return true;
	}
	if (err instanceof TimeoutError) {
		return true;
	}
	return err instanceof ValidationError;
}

function isAbortLikeTimeoutError(err: unknown): err is Error {
	if (!(err instanceof Error)) {
		return false;
	}
	return err.name === "TimeoutError";
}

function toTimeoutErrorOrNull(
	err: unknown,
	ctx: ProcessTextCtx,
	textLength: number
): TimeoutError | null {
	if (!isAbortLikeTimeoutError(err)) {
		return null;
	}
	return new TimeoutError(ctx.timeout, "LLM text processing", {
		provider: ctx.provider,
		textLength,
		originalError: err,
	});
}

function mapAndThrowOrReturn(err: unknown, ctx: ProcessTextCtx, text: string): string {
	dbg("llm", `LLM processing failed (provider=${ctx.provider}):`, getErrorMessage(err));
	if (isPassThroughError(err)) {
		throw err;
	}
	const timeoutErr = toTimeoutErrorOrNull(err, ctx, text.length);
	if (timeoutErr) {
		throw timeoutErr;
	}
	console.error("[llm] Unexpected error during processing, returning original text:", err);
	return text;
}

function rethrowOrFallbackEligible(err: unknown, fallback: string): boolean {
	if (err instanceof ValidationError) {
		throw err;
	}
	if (!fallback) {
		throw err;
	}
	return true;
}

async function runOpenRouterWithFallback(
	text: string,
	apiKey: string,
	primary: string,
	fallback: string,
	presets: readonly PresetEntry[],
	timeout: number,
	context: string
): Promise<string> {
	try {
		return await processWithOpenRouter(text, apiKey, primary, presets, timeout, context);
	} catch (primaryErr) {
		rethrowOrFallbackEligible(primaryErr, fallback);
		dbg(
			"llm",
			`OpenRouter primary failed (${getErrorMessage(primaryErr)}); trying fallback ${fallback}`
		);
		return await processWithOpenRouter(text, apiKey, fallback, presets, timeout, context);
	}
}

// Per-feature LLM config. dictation and transforms each carry their own
// provider/model/openrouter selection, custom modifiers, and thinking effort.
type LlmFeature = "dictation" | "transforms";

/**
 * The full per-feature LLM config the pipeline runs on. Normally read from the
 * store for the active feature ({@link readFeatureLlmConfig}), but the
 * Playground passes an explicit instance so the user can test an arbitrary
 * tone/modifier/provider/model combination without touching saved settings.
 * Shared connection values (Ollama endpoint, OpenRouter API key) are NOT part
 * of this shape — they're always read from the store.
 */
export interface FeatureLlmConfig {
	customModifiers: readonly CustomModifier[];
	model: string;
	openrouterFallbackModel: string;
	openrouterModel: string;
	presets: readonly PresetEntry[];
	provider: string;
	thinkingEffort: ThinkingEffort;
}

function readFeatureLlmConfigFor(feature: LlmFeature): FeatureLlmConfig {
	const providerKey = `llm.${feature}.provider` as const;
	const modelKey = `llm.${feature}.model` as const;
	const openrouterModelKey = `llm.${feature}.openrouterModel` as const;
	const openrouterFallbackKey = `llm.${feature}.openrouterFallbackModel` as const;
	const thinkingEffortKey = `llm.${feature}.thinkingEffort` as const;
	const presetsKey = `llm.${feature}.presets` as const;
	const customModifiersKey = `llm.${feature}.customModifiers` as const;
	return {
		provider: getStoreValue(providerKey),
		model: getStoreValue(modelKey),
		openrouterModel: getStoreValue(openrouterModelKey),
		openrouterFallbackModel: getStoreValue(openrouterFallbackKey),
		thinkingEffort: (getStoreValue(thinkingEffortKey) as ThinkingEffort | undefined) ?? "medium",
		presets: getStoreValue(presetsKey) as readonly PresetEntry[],
		customModifiers: getStoreValue(customModifiersKey) as readonly CustomModifier[],
	};
}

function readFeatureLlmConfig(feature: LlmFeature): FeatureLlmConfig {
	return readFeatureLlmConfigFor(feature);
}

function runOpenRouterPath(
	text: string,
	presets: readonly PresetEntry[],
	timeout: number,
	context: string,
	cfg: FeatureLlmConfig
): Promise<string> {
	const apiKey = getStoreValue("llm.openrouterApiKey");
	return runOpenRouterWithFallback(
		text,
		apiKey,
		cfg.openrouterModel,
		cfg.openrouterFallbackModel,
		presets,
		timeout,
		context
	);
}

function runOllamaPath(
	text: string,
	presets: readonly PresetEntry[],
	timeout: number,
	context: string,
	cfg: FeatureLlmConfig
): Promise<string> {
	const endpoint = getStoreValue("llm.endpoint");
	return processWithOllama(
		text,
		cfg.model,
		presets,
		endpoint,
		timeout,
		context,
		cfg.thinkingEffort
	);
}

/**
 * Build the dictation prompt for Apple Intelligence. Reuses the same
 * vocab/context/compose-rules layering as the Ollama path so the Apple
 * Intelligence output is consistent with the other providers — only the
 * delivery channel differs.
 */
function buildAppleIntelligenceUserPrompt(text: string): string {
	return `Transform the following text according to the style guide above. Return ONLY the transformed text with no additional commentary, explanations, or JSON formatting. Just the plain transformed text.\n\nText to transform:\n${text}`;
}

async function runAppleIntelligencePath(
	text: string,
	presets: readonly PresetEntry[],
	context: string
): Promise<string> {
	const systemPrompt = buildDictationSystemPrompt(presets, context);
	const userPrompt = buildAppleIntelligenceUserPrompt(text);
	try {
		const cleaned = await callAppleIntelligenceCli({
			system: systemPrompt,
			user: userPrompt,
		});
		return cleaned.trim() || text;
	} catch (err) {
		// Apple Intelligence is a soft-fail provider — when the CLI isn't
		// available (Windows build, missing binary, model still loading on
		// first call), we paste the original text rather than blocking the
		// dictation pipeline. The error is logged so users see why.
		if (err instanceof AppleIntelligenceError) {
			dbg("llm", `Apple Intelligence ${err.reason}: ${err.message}`);
			return text;
		}
		throw err;
	}
}

function runProcessText(
	text: string,
	presets: readonly PresetEntry[],
	timeout: number,
	context: string,
	cfg: FeatureLlmConfig
): Promise<string> {
	if (cfg.provider === "apple-intelligence") {
		return runAppleIntelligencePath(text, presets, context);
	}
	if (cfg.provider === "openrouter") {
		return runOpenRouterPath(text, presets, timeout, context, cfg);
	}
	return runOllamaPath(text, presets, timeout, context, cfg);
}

/**
 * Process text using either Ollama or OpenRouter, based on stored settings.
 * Reads the dictation-feature provider/model config so dictation post-
 * processing can run on a different provider than the transforms feature.
 * OpenRouter goes through the Vercel AI SDK with a strict Zod-validated
 * structured output (`{ text }`), so the result is guaranteed to be plain
 * transformed text with no surrounding commentary.
 *
 * Optional `context` is a free-form prompt-fragment captured by the
 * Windows UIA reader when context-awareness is enabled. Empty string ⇒
 * behaves identically to the no-context path.
 */
export async function processText(
	text: string,
	context = "",
	feature: LlmFeature = "dictation",
	overrideConfig?: FeatureLlmConfig
): Promise<string> {
	assertNonEmptyString(text, "Text is required for LLM processing", "text");

	// The Playground supplies an explicit config to test arbitrary
	// tone/modifier/provider/model combinations; everything else reads the
	// active feature's saved config. Connection values (endpoint, API key)
	// stay store-sourced either way (see runOllamaPath / runOpenRouterPath).
	const cfg = overrideConfig ?? readFeatureLlmConfig(feature);
	// Enabled custom modifiers are folded into the preset list here so the
	// whole downstream chain (compose, logging, both provider paths) keeps
	// operating on the single `presets` array — no extra param threading.
	const presets = mergePresetsWithCustomModifiers(cfg.presets, cfg.customModifiers);
	// `llm.timeout` is read so settings/wiring stay live (settings UI, persisted
	// value, tests asserting `storeKeyAccesses`), but the value is currently
	// ignored at the network layer — see processWithOllama/processWithOpenRouter.
	const timeout = getStoreValue("llm.timeout");

	try {
		const cleaned = await runProcessText(text, presets, timeout, context, cfg);
		// Deterministic safety net: even when the LLM was supposed to apply
		// the user's replacement pairs from the system prompt, models
		// occasionally miss one or invent their own casing. The same
		// string-replace pass runs on the algorithmic path; running it here
		// too means a replacement pair is GUARANTEED to fire regardless of
		// which provider answered (or whether it misbehaved).
		const vocab = getPostProcessingVocab();
		return applyReplacementPairs(cleaned, vocab.replacementPairs);
	} catch (err) {
		return mapAndThrowOrReturn(err, { provider: cfg.provider, presets, timeout }, text);
	}
}

// ── Custom-prompt variants for the Transforms feature ─────────────────
//
// Transforms differ from cleanup presets in two ways:
//   1. The user authors the full system prompt; there's no preset catalog.
//   2. The output is destined to *replace* a selection in another app, so
//      "Return ONLY the transformed text" is non-negotiable.
//
// We funnel both providers through the same shape as the preset path so
// error mapping and structured output (OpenRouter) behave identically.
// Neither path imposes a client-side timeout — the LLM runs to completion.

function buildOllamaCustomMessages(systemPrompt: string, text: string): OllamaChatMessage[] {
	const userPrompt = `Apply the system instructions above to the following text. Return ONLY the transformed text with no commentary, explanations, or JSON formatting.\n\nText:\n${text}`;
	return [
		{ role: "system", content: systemPrompt },
		{ role: "user", content: userPrompt },
	];
}

function readTransformsThinkingEffort(): ThinkingEffort {
	return (getStoreValue("llm.transforms.thinkingEffort") as ThinkingEffort | undefined) ?? "medium";
}

async function executeOllamaChatRequest(
	normalizedEndpoint: string,
	model: string,
	messages: OllamaChatMessage[],
	text: string,
	options: { supportsThinking: boolean; effort: ThinkingEffort },
	presetsLabel: string,
	controller: AbortController
): Promise<string> {
	const response = await fetch(buildOllamaApiUrl(normalizedEndpoint, "/api/chat"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: buildOllamaChatBody(model, messages, text.length, options),
		signal: controller.signal,
	});

	await assertOllamaResponseOk(response, {
		endpoint: normalizedEndpoint,
		model,
		presets: presetsLabel,
	});

	if (!response.body) {
		dbg("llm", "Ollama custom chat response had no body; falling back to original text");
		return text;
	}
	const state = await readOllamaChatStream(response.body);
	return finalizeChatAnswer(state, text);
}

function handleOllamaChatAbort(
	err: unknown,
	controller: AbortController,
	label: string,
	fallbackText: string
): string {
	if (controller.signal.aborted) {
		dbg("llm", `${label} aborted: ${String(controller.signal.reason ?? "")}`);
		return fallbackText;
	}
	throw err;
}

async function processWithOllamaCustom(
	text: string,
	model: string,
	systemPrompt: string,
	endpoint: string,
	_timeout: number
): Promise<string> {
	assertNonEmptyString(model, "Ollama model is required", "model");
	const normalizedEndpoint = assertValidEndpoint(endpoint);

	const messages = buildOllamaCustomMessages(systemPrompt, text);

	// Client-side timeout DISABLED (see processWithOllama for rationale).
	// `_timeout` is wired through for settings/test compatibility.
	// Cancellation IS supported — see processWithOllama for context.
	const controller = new AbortController();
	registerChatController(controller);
	const supportsThinking = await modelSupportsThinking(normalizedEndpoint, model);
	const effort = readTransformsThinkingEffort();
	try {
		return await executeOllamaChatRequest(
			normalizedEndpoint,
			model,
			messages,
			text,
			{ supportsThinking, effort },
			"custom",
			controller
		);
	} catch (err) {
		return handleOllamaChatAbort(err, controller, "Ollama custom chat", text);
	} finally {
		unregisterChatController(controller);
	}
}

async function processWithOpenRouterCustom(
	text: string,
	apiKey: string,
	modelSelection: string,
	systemPrompt: string,
	_timeout: number
): Promise<string> {
	if (!apiKey) {
		throw new ValidationError("OpenRouter API key is required", "apiKey");
	}
	const { modelId, providerSlug } = parseModelSelection(modelSelection);
	const effectiveModelId = resolveOpenRouterModelId(modelId);

	const userPrompt = `Apply the system instructions above to the following text. ${STRUCTURED_OUTPUT_DESCRIPTION}\n\nText:\n${text}`;

	const openrouter = createOpenRouter({
		apiKey,
		headers: {
			"HTTP-Referer": "https://github.com/winstt/winstt",
			"X-Title": "WinSTT",
		},
	});

	const model = openrouter.chat(effectiveModelId, buildModelOptions(providerSlug));

	const result = await generateObject({
		model,
		system: systemPrompt,
		prompt: userPrompt,
		schemaName: "TransformedText",
		schemaDescription: "The transformed text only.",
		schema: transformedTextSchema,
		experimental_repairText: ({ text: raw }) => Promise.resolve(repairOpenRouterText(raw)),
		providerOptions: {
			openrouter: { plugins: [{ id: "response-healing" }] },
		},
	});

	return returnTextIfEmpty(result.object.text.trim(), text);
}

async function runOpenRouterCustomWithFallback(
	text: string,
	apiKey: string,
	primary: string,
	fallback: string,
	systemPrompt: string,
	timeout: number
): Promise<string> {
	try {
		return await processWithOpenRouterCustom(text, apiKey, primary, systemPrompt, timeout);
	} catch (primaryErr) {
		rethrowOrFallbackEligible(primaryErr, fallback);
		dbg(
			"llm",
			`OpenRouter primary failed (${getErrorMessage(primaryErr)}); trying fallback ${fallback}`
		);
		return await processWithOpenRouterCustom(text, apiKey, fallback, systemPrompt, timeout);
	}
}

async function runAppleIntelligenceCustomPath(text: string, systemPrompt: string): Promise<string> {
	const userPrompt = `Apply the system instructions above to the following text. Return ONLY the transformed text with no commentary, explanations, or JSON formatting.\n\nText:\n${text}`;
	try {
		const cleaned = await callAppleIntelligenceCli({
			system: systemPrompt,
			user: userPrompt,
		});
		return cleaned.trim() || text;
	} catch (err) {
		if (err instanceof AppleIntelligenceError) {
			dbg("llm", `Apple Intelligence (transforms) ${err.reason}: ${err.message}`);
			return text;
		}
		throw err;
	}
}

function runCustomPromptPath(
	text: string,
	systemPrompt: string,
	provider: string,
	timeout: number
): Promise<string> {
	if (provider === "apple-intelligence") {
		return runAppleIntelligenceCustomPath(text, systemPrompt);
	}
	if (provider === "openrouter") {
		const apiKey = getStoreValue("llm.openrouterApiKey");
		const primary = getStoreValue("llm.transforms.openrouterModel");
		const fallback = getStoreValue("llm.transforms.openrouterFallbackModel");
		return runOpenRouterCustomWithFallback(text, apiKey, primary, fallback, systemPrompt, timeout);
	}
	const endpoint = getStoreValue("llm.endpoint");
	const model = getStoreValue("llm.transforms.model");
	return processWithOllamaCustom(text, model, systemPrompt, endpoint, timeout);
}

/**
 * Apply a free-form system prompt to `text` and return the transformed
 * result. Used by the Transforms feature: each transform supplies its
 * own `systemPrompt`, independent from the cleanup preset catalog.
 *
 * Reads the transforms-feature provider/model config so transforms can
 * run on a different provider than dictation cleanup.
 *
 * Optional `context` is fed through the same UIA-context prefix as
 * `processText`, so a transform fired with context-awareness on gets
 * spelling hints for free.
 */
export async function processTextWithCustomPrompt(
	text: string,
	systemPrompt: string,
	context = ""
): Promise<string> {
	assertNonEmptyString(text, "Text is required for LLM processing", "text");
	assertNonEmptyString(systemPrompt, "Transform prompt is required", "systemPrompt");

	const provider = getStoreValue("llm.transforms.provider");
	const timeout = getStoreValue("llm.timeout");
	const effectiveSystemPrompt = withContextPrefix(systemPrompt, context);

	try {
		return await runCustomPromptPath(text, effectiveSystemPrompt, provider, timeout);
	} catch (err) {
		return mapAndThrowOrReturn(err, { provider, presets: [], timeout }, text);
	}
}

// ── Ollama: detect + start ────────────────────────────────────────────

interface OllamaDetectResult {
	installed: boolean;
	path?: string;
}

async function tryDetectOllamaPosix(): Promise<OllamaDetectResult> {
	try {
		const { stdout } = await execFileAsync("which", ["ollama"], { timeout: 2000 });
		const resolved = stdout.trim();
		if (resolved) {
			return { installed: true, path: resolved };
		}
	} catch {
		// fall through
	}
	return { installed: false };
}

function pickFirstNonBlankLine(stdout: string): string | undefined {
	return stdout.split(NEWLINE_RE).find(isNonBlankLine);
}

function isNonBlankLine(line: string): boolean {
	return line.trim().length > 0;
}

async function tryFindOllamaViaWhere(): Promise<OllamaDetectResult | null> {
	try {
		const { stdout } = await execFileAsync("where", ["ollama"], { timeout: 2000 });
		const firstLine = pickFirstNonBlankLine(stdout);
		if (firstLine) {
			return { installed: true, path: firstLine.trim() };
		}
	} catch {
		// `where` failed — keep probing default locations.
	}
	return null;
}

function getOllamaCandidatePaths(): string[] {
	const candidates: string[] = [];
	pushIfDefined(candidates, process.env.LOCALAPPDATA, "Programs", "Ollama", "ollama.exe");
	pushIfDefined(candidates, process.env.ProgramFiles, "Ollama", "ollama.exe");
	return candidates;
}

function pushIfDefined(out: string[], base: string | undefined, ...rest: string[]): void {
	if (!base) {
		return;
	}
	out.push(path.join(base, ...rest));
}

async function fileExists(p: string): Promise<boolean> {
	try {
		await fsPromises.access(p);
		return true;
	} catch {
		return false;
	}
}

async function findOllamaInDefaultDirs(): Promise<OllamaDetectResult> {
	const candidates = getOllamaCandidatePaths();
	const existsResults = await Promise.all(candidates.map(fileExists));
	const hitIndex = existsResults.indexOf(true);
	if (hitIndex >= 0) {
		const candidate = candidates[hitIndex];
		if (candidate !== undefined) {
			return { installed: true, path: candidate };
		}
	}
	return { installed: false };
}

async function detectOllamaWindows(): Promise<OllamaDetectResult> {
	const viaWhere = await tryFindOllamaViaWhere();
	if (viaWhere) {
		return viaWhere;
	}
	return findOllamaInDefaultDirs();
}

export function detectOllama(): Promise<OllamaDetectResult> {
	if (process.platform !== "win32") {
		return tryDetectOllamaPosix();
	}
	return detectOllamaWindows();
}

function isOllamaUnavailable(detected: OllamaDetectResult): boolean {
	if (!detected.installed) {
		return true;
	}
	return !detected.path;
}

function spawnOllamaProcess(execPath: string): void {
	const child = spawn(execPath, ["serve"], {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	child.on("error", (err) => {
		dbg("llm", "Ollama spawn error:", err.message);
	});
	child.unref();
	dbg("llm", `Started Ollama from ${execPath}`);
}

export async function startOllama(): Promise<{ started: boolean; error?: string }> {
	const detected = await detectOllama();
	if (isOllamaUnavailable(detected)) {
		return { started: false, error: "Ollama is not installed" };
	}
	try {
		spawnOllamaProcess(detected.path as string);
		return { started: true };
	} catch (err) {
		const message = getErrorMessage(err);
		dbg("llm", "Failed to start Ollama:", message);
		return { started: false, error: message };
	}
}

// ── Ollama: pull + delete ─────────────────────────────────────────────

const ollamaPullProgressSchema = z.object({
	status: z.string(),
	digest: z.string().optional(),
	total: z.number().optional(),
	completed: z.number().optional(),
	error: z.string().optional(),
});

type OllamaPullStatus =
	| "pulling"
	| "downloading"
	| "verifying"
	| "writing"
	| "success"
	| "error"
	| "cancelled";

interface OllamaPullProgressPayload {
	completed?: number;
	digest?: string;
	error?: string;
	model: string;
	percent?: number;
	status: OllamaPullStatus;
	statusText?: string;
	total?: number;
}

interface OllamaPullResultPayload {
	cancelled?: boolean;
	error?: string;
	model: string;
	success: boolean;
}

interface OllamaDeleteResultPayload {
	error?: string;
	model: string;
	success: boolean;
}

const VALID_PULL_NAME_RE = /^[a-zA-Z0-9._:/-]+$/;
const activePulls = new Map<string, AbortController>();

function isLiveBrowserWindow(bw: BrowserWindow): boolean {
	return !bw.isDestroyed();
}

function broadcastPullProgress(progress: OllamaPullProgressPayload): void {
	const live = BrowserWindow.getAllWindows().filter(isLiveBrowserWindow);
	for (const bw of live) {
		bw.webContents.send(IPC.LLM_PULL_PROGRESS, progress);
	}
}

const PULL_STATUS_PREFIXES: ReadonlyArray<readonly [string, OllamaPullStatus]> = [
	["success", "success"],
	["pulling manifest", "pulling"],
	["retrieving", "pulling"],
	["pulling ", "downloading"],
	["downloading", "downloading"],
	["verifying", "verifying"],
	["writing", "writing"],
	["removing", "writing"],
] as const;

function matchPullStatusPrefix(normalized: string): OllamaPullStatus | undefined {
	const entry = PULL_STATUS_PREFIXES.find(([prefix]) => normalized.startsWith(prefix));
	return entry?.[1];
}

function classifyPullStatus(statusText: string): OllamaPullStatus {
	return matchPullStatusPrefix(statusText.toLowerCase()) ?? "pulling";
}

function hasValidPercentInputs(
	completed: number | undefined,
	total: number | undefined
): completed is number {
	return isPositiveNumber(total) && typeof completed === "number";
}

function isPositiveNumber(value: number | undefined): value is number {
	if (typeof value !== "number") {
		return false;
	}
	return value > 0;
}

function computePercent(completed?: number, total?: number): number | undefined {
	if (!hasValidPercentInputs(completed, total)) {
		return;
	}
	const ratio = (completed / (total as number)) * 100;
	return Math.max(0, Math.min(100, ratio));
}

// Record one layer's byte progress keyed by its digest. Lines without a digest
// (manifest / verifying / writing / success) or without a positive total carry
// no per-layer bytes, so they're ignored here — the last aggregate is reused.
function recordLayerProgress(
	layers: Map<string, PullLayerProgress>,
	parsed: z.infer<typeof ollamaPullProgressSchema>
): void {
	if (!(parsed.digest && isPositiveNumber(parsed.total))) {
		return;
	}
	const completed = typeof parsed.completed === "number" ? Math.max(0, parsed.completed) : 0;
	layers.set(parsed.digest, { completed: Math.min(completed, parsed.total), total: parsed.total });
}

// Sum bytes across every layer seen so far → one overall completed/total. The
// dominant GGUF blob is ~all the bytes, so tiny config/template layers no longer
// each render as a full 0→100 sweep (the "progress replays 4 times" bug).
function aggregatePullProgress(
	layers: Map<string, PullLayerProgress>
): PullLayerProgress | undefined {
	if (layers.size === 0) {
		return;
	}
	let completed = 0;
	let total = 0;
	for (const layer of layers.values()) {
		completed += layer.completed;
		total += layer.total;
	}
	return { completed, total };
}

function buildPullProgress(
	model: string,
	parsed: z.infer<typeof ollamaPullProgressSchema>,
	layers?: Map<string, PullLayerProgress>
): OllamaPullProgressPayload {
	const status = classifyPullStatus(parsed.status);
	const aggregate = layers ? aggregatePullProgress(layers) : undefined;
	// Once any byte progress exists, report the aggregate so the bar climbs once;
	// success forces 100 (Ollama may not emit a final completed===total per layer).
	const percent =
		status === "success"
			? 100
			: (computePercent(aggregate?.completed, aggregate?.total) ??
				computePercent(parsed.completed, parsed.total));
	return llmOmitUndefined({
		model,
		status,
		statusText: parsed.status,
		digest: parsed.digest,
		completed: aggregate?.completed ?? parsed.completed,
		total: aggregate?.total ?? parsed.total,
		percent,
		error: parsed.error,
	}) as OllamaPullProgressPayload;
}

function* iterateNdjsonChunks(buffer: { value: string }): Generator<string> {
	// react-doctor-disable-next-line js-set-map-lookups
	let newlineIdx = buffer.value.indexOf("\n");
	while (newlineIdx !== -1) {
		const line = buffer.value.slice(0, newlineIdx).trim();
		buffer.value = buffer.value.slice(newlineIdx + 1);
		if (line) {
			yield line;
		}
		// react-doctor-disable-next-line js-set-map-lookups
		newlineIdx = buffer.value.indexOf("\n");
	}
}

function parsePullLine(line: string): z.infer<typeof ollamaPullProgressSchema> | null {
	try {
		const json = JSON.parse(line) as unknown;
		const parsed = ollamaPullProgressSchema.safeParse(json);
		if (!parsed.success) {
			dbg("llm", "Ollama /api/pull line did not match schema:", parsed.error.message);
			return null;
		}
		return parsed.data;
	} catch (err) {
		dbg("llm", "Ollama /api/pull line was not JSON:", getErrorMessage(err));
		return null;
	}
}

interface PullLayerProgress {
	completed: number;
	total: number;
}

interface PullStreamState {
	buffer: { value: string };
	final: { error?: string; success: boolean };
	// Per-digest (per-layer) byte progress, accumulated so the renderer can show
	// ONE aggregate bar instead of a separate 0→100 sweep per blob. Ollama's
	// /api/pull stream reports completed/total scoped to the current layer only.
	layers: Map<string, PullLayerProgress>;
}

function applyPullLine(
	final: PullStreamState["final"],
	model: string,
	parsed: z.infer<typeof ollamaPullProgressSchema>,
	layers?: Map<string, PullLayerProgress>
): void {
	if (layers) {
		recordLayerProgress(layers, parsed);
	}
	const progress = buildPullProgress(model, parsed, layers);
	broadcastPullProgress(progress);
	if (progress.status === "success") {
		final.success = true;
	}
	if (parsed.error) {
		final.error = parsed.error;
	}
}

function consumePullLines(state: PullStreamState, model: string): void {
	for (const line of iterateNdjsonChunks(state.buffer)) {
		const parsed = parsePullLine(line);
		if (parsed) {
			applyPullLine(state.final, model, parsed, state.layers);
		}
	}
}

async function drainReaderInto(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	decoder: TextDecoder,
	state: PullStreamState,
	model: string
): Promise<void> {
	while (true) {
		// react-doctor-disable-next-line async-await-in-loop
		const { value, done } = await reader.read();
		if (done) {
			return;
		}
		state.buffer.value += decoder.decode(value, { stream: true });
		consumePullLines(state, model);
	}
}

function flushPullBuffer(state: PullStreamState, decoder: TextDecoder, model: string): void {
	state.buffer.value += decoder.decode();
	if (state.buffer.value.trim()) {
		consumePullLines(state, model);
	}
}

async function readPullStream(
	body: ReadableStream<Uint8Array>,
	model: string
): Promise<{ success: boolean; error?: string }> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state: PullStreamState = {
		buffer: { value: "" },
		final: { success: false },
		layers: new Map(),
	};
	await drainReaderInto(reader, decoder, state, model);
	flushPullBuffer(state, decoder, model);
	return state.final;
}

function isAbortError(err: unknown): boolean {
	if (!(err instanceof Error)) {
		return false;
	}
	return err.name === "AbortError";
}

function pullResultFromStreamOutcome(
	model: string,
	result: { success: boolean; error?: string }
): OllamaPullResultPayload {
	if (result.success) {
		return { success: true, model };
	}
	const message = result.error ?? "Pull did not complete successfully";
	broadcastPullProgress({ model, status: "error", error: message });
	return { success: false, model, error: message };
}

async function performPull(
	endpoint: string,
	model: string,
	signal: AbortSignal
): Promise<OllamaPullResultPayload> {
	const url = buildOllamaApiUrl(endpoint, "/api/pull");
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model, stream: true, insecure: false }),
		signal,
	});

	if (!response.ok) {
		const errorText = await readErrorText(response);
		const message = `Ollama /api/pull returned HTTP ${response.status}: ${errorText}`;
		dbg("llm", message);
		broadcastPullProgress({ model, status: "error", error: message });
		return { success: false, model, error: message };
	}

	if (!response.body) {
		const message = "Ollama /api/pull returned empty body";
		broadcastPullProgress({ model, status: "error", error: message });
		return { success: false, model, error: message };
	}

	return pullResultFromStreamOutcome(model, await readPullStream(response.body, model));
}

function assertValidModelName(model: string): void {
	assertNonEmptyString(model, "Model name is required", "model");
	if (!VALID_PULL_NAME_RE.test(model)) {
		throw new ValidationError("Model name contains invalid characters", "model");
	}
}

function handlePullError(err: unknown, model: string): OllamaPullResultPayload {
	if (isAbortError(err)) {
		broadcastPullProgress({ model, status: "cancelled" });
		return { success: false, model, cancelled: true };
	}
	const message = getErrorMessage(err);
	dbg("llm", `Ollama pull failed for ${model}:`, message);
	broadcastPullProgress({ model, status: "error", error: message });
	return { success: false, model, error: message };
}

export async function pullOllamaModel(
	endpoint: string,
	model: string
): Promise<OllamaPullResultPayload> {
	assertValidModelName(model);
	const normalizedEndpoint = assertValidEndpoint(endpoint);

	if (activePulls.has(model)) {
		return { success: false, model, error: "A pull is already in progress for this model" };
	}

	const controller = new AbortController();
	activePulls.set(model, controller);
	broadcastPullProgress({ model, status: "pulling", statusText: "starting" });

	try {
		return await performPull(normalizedEndpoint, model, controller.signal);
	} catch (err) {
		return handlePullError(err, model);
	} finally {
		activePulls.delete(model);
	}
}

export function cancelOllamaModelPull(model: string): { cancelled: boolean } {
	const controller = activePulls.get(model);
	if (!controller) {
		return { cancelled: false };
	}
	controller.abort();
	return { cancelled: true };
}

export async function deleteOllamaModel(
	endpoint: string,
	model: string
): Promise<OllamaDeleteResultPayload> {
	assertValidModelName(model);
	const normalizedEndpoint = assertValidEndpoint(endpoint);

	const url = buildOllamaApiUrl(normalizedEndpoint, "/api/delete");
	const response = await safeFetch(
		url,
		{
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model }),
			signal: AbortSignal.timeout(15_000),
		},
		`Ollama delete ${model}`
	);

	if (isFetchError(response)) {
		return { success: false, model, error: response.error };
	}
	if (!response.ok) {
		const errorText = await readErrorText(response);
		const message = `Ollama /api/delete returned HTTP ${response.status}: ${errorText}`;
		dbg("llm", message);
		return { success: false, model, error: message };
	}
	return { success: true, model };
}

// ── IPC wiring ────────────────────────────────────────────────────────

function isPlainObject(payload: unknown): payload is Record<string, unknown> {
	if (!payload) {
		return false;
	}
	return typeof payload === "object";
}

function assertPlainObject(payload: unknown, message: string): asserts payload is object {
	if (!isPlainObject(payload)) {
		throw new ValidationError(message, "payload");
	}
}

function assertStringField(
	payload: object,
	field: "text" | "systemPrompt" | "model",
	message: string
): void {
	const value = (payload as Record<string, unknown>)[field];
	if (typeof value !== "string") {
		throw new ValidationError(message, field);
	}
}

function assertProcessTextPayload(payload: unknown): asserts payload is { text: string } {
	assertPlainObject(payload, "LLM process-text payload must be an object");
	assertStringField(payload, "text", "LLM process-text payload.text must be a string");
}

async function handleProcessTextSafe(payload: unknown): Promise<string> {
	try {
		assertProcessTextPayload(payload);
		return await processText(payload.text);
	} catch (error) {
		console.error("[llm] Failed to process text:", getErrorMessage(error));
		throw error;
	}
}

function assertCustomPromptPayload(
	payload: unknown
): asserts payload is { text: string; systemPrompt: string } {
	assertPlainObject(payload, "LLM custom-prompt payload must be an object");
	assertStringField(payload, "text", "LLM custom-prompt payload.text must be a string");
	assertStringField(
		payload,
		"systemPrompt",
		"LLM custom-prompt payload.systemPrompt must be a string"
	);
}

async function handleProcessTextCustomSafe(payload: unknown): Promise<string> {
	try {
		assertCustomPromptPayload(payload);
		return await processTextWithCustomPrompt(payload.text, payload.systemPrompt);
	} catch (error) {
		console.error("[llm] custom-prompt processing failed:", getErrorMessage(error));
		throw error;
	}
}

function assertModelPayload(payload: unknown): asserts payload is { model: string } {
	assertPlainObject(payload, "Payload must be an object");
	assertStringField(payload, "model", "Payload.model must be a string");
}

export function setupLlm(): () => void {
	const handleScanModels = async () => {
		const endpoint = getStoreValue("llm.endpoint");
		return await scanOllamaModels(endpoint);
	};

	const handleScanOpenRouterModels = async () => {
		const apiKey = getStoreValue("llm.openrouterApiKey");
		return await scanOpenRouterModels(apiKey);
	};

	const handleDetectOllama = async () => detectOllama();

	const handleStartOllama = async () => startOllama();

	const handleProcessText = async (_event: unknown, payload: { text: string }) =>
		handleProcessTextSafe(payload);

	const handleProcessTextCustom = async (_event: unknown, payload: unknown) =>
		handleProcessTextCustomSafe(payload);

	const handlePullModel = async (_event: unknown, payload: unknown) => {
		assertModelPayload(payload);
		const endpoint = getStoreValue("llm.endpoint");
		return await pullOllamaModel(endpoint, payload.model);
	};

	const handleCancelPull = (_event: unknown, payload: unknown) => {
		assertModelPayload(payload);
		return cancelOllamaModelPull(payload.model);
	};

	const handleDeleteModel = async (_event: unknown, payload: unknown) => {
		assertModelPayload(payload);
		const endpoint = getStoreValue("llm.endpoint");
		return await deleteOllamaModel(endpoint, payload.model);
	};

	ipcMain.handle(IPC.LLM_SCAN_MODELS, handleScanModels);
	ipcMain.handle(IPC.LLM_PROCESS_TEXT, handleProcessText);
	ipcMain.handle(IPC.LLM_PROCESS_TEXT_CUSTOM, handleProcessTextCustom);
	ipcMain.handle(IPC.LLM_DETECT_OLLAMA, handleDetectOllama);
	ipcMain.handle(IPC.LLM_START_OLLAMA, handleStartOllama);
	ipcMain.handle(IPC.LLM_SCAN_OPENROUTER_MODELS, handleScanOpenRouterModels);
	ipcMain.handle(IPC.LLM_PULL_MODEL, handlePullModel);
	ipcMain.handle(IPC.LLM_CANCEL_PULL_MODEL, handleCancelPull);
	ipcMain.handle(IPC.LLM_DELETE_MODEL, handleDeleteModel);
	// Settings window may mount after a warmup has already fired; let it
	// pull the latest snapshot rather than waiting for the next interval.
	ipcMain.handle(IPC.LLM_GET_WARMUP_STATUS, () => getLastWarmupStatus());

	return () => {
		ipcMain.removeHandler(IPC.LLM_SCAN_MODELS);
		ipcMain.removeHandler(IPC.LLM_PROCESS_TEXT);
		ipcMain.removeHandler(IPC.LLM_PROCESS_TEXT_CUSTOM);
		ipcMain.removeHandler(IPC.LLM_DETECT_OLLAMA);
		ipcMain.removeHandler(IPC.LLM_START_OLLAMA);
		ipcMain.removeHandler(IPC.LLM_SCAN_OPENROUTER_MODELS);
		ipcMain.removeHandler(IPC.LLM_PULL_MODEL);
		ipcMain.removeHandler(IPC.LLM_CANCEL_PULL_MODEL);
		ipcMain.removeHandler(IPC.LLM_DELETE_MODEL);
		ipcMain.removeHandler(IPC.LLM_GET_WARMUP_STATUS);
		for (const controller of activePulls.values()) {
			controller.abort();
		}
		activePulls.clear();
	};
}

// ── Ollama warmup (keep models hot between dictations) ───────────────
//
// Ollama unloads idle models after ~5 min. The first /api/chat after that
// pays a multi-second model-load tax which makes dictation feel broken —
// the user sees the recording pill swap to the thinking indicator for ages
// before any text appears. We preload the configured dictation/transforms
// model on app start, after settings change, and on a 4-minute interval so
// the model is always sitting in RAM by the time the user actually dictates.
//
// Warmup is fire-and-forget and silent on failure: Ollama may be offline,
// the model may be wrong, the user may not have a model selected at all.
// None of those should surface as errors — they just mean the first real
// call will pay the cold-start tax, which is the status-quo behaviour.

// Re-warm slightly before Ollama would unload the model so it never goes
// cold between dictations. Default Ollama unload is 5 min; keep_alive on
// the chat/warmup requests is 30 min, but we still refresh on this cadence
// to handle store restarts and brief Ollama outages.
const WARMUP_INTERVAL_MS = 4 * 60 * 1000;

// Debounce settings-driven warmups so toggling a switch a few times in
// rapid succession doesn't fire N concurrent warmups.
const WARMUP_SETTINGS_DEBOUNCE_MS = 500;

// Avoid hammering `ollama serve` if a previous spawn already started but
// hasn't bound the port yet, or if Ollama isn't installed at all. One
// auto-start per 30 s is plenty — the periodic warmup interval is 4 min,
// so even a stubborn outage gets a fresh try every two warmups.
const OLLAMA_AUTO_START_THROTTLE_MS = 30_000;

// After spawning `ollama serve`, give it up to this long to bind the port
// and accept its first `/api/tags`. Local Ollama usually boots in 1-2 s;
// 10 s leaves headroom for slower disks and antivirus pre-scan.
const OLLAMA_BOOT_WAIT_MS = 10_000;

// Hostnames where auto-starting a *local* `ollama serve` actually helps.
// Remote endpoints (someone else's box) get no auto-start — we can't fix
// their machine from here, and `detectOllama()` would happily find a
// local install that has nothing to do with the remote endpoint they
// configured.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", ""]);

function isLoopbackEndpoint(endpoint: string): boolean {
	const normalized = normalizeOllamaEndpoint(endpoint);
	if (!normalized) {
		return false;
	}
	try {
		const url = new URL(normalized);
		return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
	} catch {
		return false;
	}
}

async function pingOllama(endpoint: string, timeoutMs = 2000): Promise<boolean> {
	const normalized = normalizeOllamaEndpoint(endpoint);
	if (!normalized) {
		return false;
	}
	try {
		const response = await fetch(buildOllamaApiUrl(normalized, "/api/tags"), {
			method: "GET",
			signal: AbortSignal.timeout(timeoutMs),
		});
		return response.ok;
	} catch {
		return false;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function waitForOllama(endpoint: string, totalMs: number): Promise<boolean> {
	const deadline = Date.now() + totalMs;
	while (Date.now() < deadline) {
		// react-doctor-disable-next-line async-await-in-loop
		if (await pingOllama(endpoint, 1500)) {
			return true;
		}
		// react-doctor-disable-next-line async-await-in-loop
		await sleep(500);
	}
	return false;
}

let lastAutoStartAttemptMs = 0;

/**
 * Make sure Ollama is reachable at `endpoint`. If it isn't, attempt to
 * auto-spawn `ollama serve` (only for loopback endpoints + when Ollama is
 * actually installed on this machine), then poll for boot.
 *
 * Throttled: at most one auto-start every {@link OLLAMA_AUTO_START_THROTTLE_MS}
 * so a sustained outage doesn't spawn dozens of `ollama serve` processes.
 *
 * Returns true when Ollama is reachable (already running or just started),
 * false otherwise. Callers should skip Ollama work when false — there's
 * nothing useful to do.
 */
function isAutoStartThrottled(now: number): boolean {
	return now - lastAutoStartAttemptMs < OLLAMA_AUTO_START_THROTTLE_MS;
}

async function ensureOllamaInstalled(): Promise<boolean> {
	const detected = await detectOllama();
	if (isOllamaUnavailable(detected)) {
		dbg("llm", "Ollama unreachable and not installed — dictation will be skipped");
		return false;
	}
	return true;
}

function describeStartFailure(error: string | undefined): string {
	return error ?? "unknown";
}

async function spawnOllamaOrLog(): Promise<boolean> {
	dbg("llm", "Ollama unreachable — attempting auto-start");
	const result = await startOllama();
	if (!result.started) {
		dbg("llm", `Ollama auto-start failed: ${describeStartFailure(result.error)}`);
		return false;
	}
	return true;
}

async function waitForOllamaOrLog(endpoint: string): Promise<boolean> {
	const up = await waitForOllama(endpoint, OLLAMA_BOOT_WAIT_MS);
	if (!up) {
		dbg("llm", `Ollama auto-started but didn't bind within ${OLLAMA_BOOT_WAIT_MS}ms`);
		return false;
	}
	dbg("llm", "Ollama auto-start succeeded");
	return true;
}

async function tryAutoStartAndWait(endpoint: string): Promise<boolean> {
	if (!(await ensureOllamaInstalled())) {
		return false;
	}
	if (!(await spawnOllamaOrLog())) {
		return false;
	}
	return await waitForOllamaOrLog(endpoint);
}

function isRemoteEndpointBail(endpoint: string): boolean {
	if (isLoopbackEndpoint(endpoint)) {
		return false;
	}
	dbg("llm", `Ollama unreachable at ${endpoint}; remote endpoint — cannot auto-start`);
	return true;
}

function isThrottledBail(now: number): boolean {
	if (!isAutoStartThrottled(now)) {
		return false;
	}
	dbg("llm", "Ollama unreachable; auto-start throttled (recent attempt)");
	return true;
}

async function tryStartIfNotThrottled(endpoint: string): Promise<boolean> {
	const now = Date.now();
	if (isThrottledBail(now)) {
		return false;
	}
	lastAutoStartAttemptMs = now;
	return await tryAutoStartAndWait(endpoint);
}

async function ensureOllamaReachableUnpinged(endpoint: string): Promise<boolean> {
	if (isRemoteEndpointBail(endpoint)) {
		return false;
	}
	return await tryStartIfNotThrottled(endpoint);
}

async function ensureOllamaReachable(endpoint: string): Promise<boolean> {
	if (await pingOllama(endpoint)) {
		return true;
	}
	return await ensureOllamaReachableUnpinged(endpoint);
}

/**
 * Outcome of a single model warmup. Distinguishes the user-actionable
 * cases (model isn't installed → pull it; model load blew up → reinstall
 * or pick a different one) from generic transport failures so logs are
 * useful when something goes wrong.
 *
 * `"loading"` is a transient marker broadcast at the START of a warmup
 * pass so the renderer's swap-tracker UI can stay visible until a
 * terminal outcome arrives (a real swap on a single GPU can legitimately
 * take 60+ seconds for big reasoning models, exceeding the renderer's
 * safety timeout if it only sees a single end-of-pass broadcast).
 */
type WarmupOutcome =
	| "ok"
	| "unreachable"
	| "model-not-found"
	| "load-failed"
	| "skipped"
	| "loading";

/**
 * Ollama returns HTTP 404 with a body like:
 *   {"error":"model 'gemma3:99b' not found, try pulling it first"}
 * for an uninstalled model. Other non-2xx responses on /api/generate
 * (most often 500 with a runner error) indicate the model file is
 * present but failed to load — typically corruption, incompatible
 * quant, or out-of-memory.
 */
function classifyWarmupResponse(status: number): WarmupOutcome {
	if (status === 404) {
		return "model-not-found";
	}
	return "load-failed";
}

interface WarmupModelResult {
	errorBody?: string;
	model: string;
	outcome: WarmupOutcome;
}

function logWarmupFailure(
	outcome: WarmupOutcome,
	model: string,
	status: number,
	body: string
): void {
	if (outcome === "model-not-found") {
		dbg(
			"llm",
			`Ollama warmup: model "${model}" not installed — pull it from the Ollama panel. ${body}`
		);
		return;
	}
	dbg(
		"llm",
		`Ollama warmup: model "${model}" failed to load (HTTP ${status}) — file may be corrupted, incompatible, or out of memory. ${body}`
	);
}

async function performWarmupRequest(
	normalizedEndpoint: string,
	model: string
): Promise<WarmupModelResult> {
	// /api/generate with empty prompt loads the model into VRAM/RAM
	// without producing output. Cheaper than a real chat round-trip.
	const response = await fetch(buildOllamaApiUrl(normalizedEndpoint, "/api/generate"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			prompt: "",
			stream: false,
			keep_alive: OLLAMA_KEEP_ALIVE,
		}),
		// Generous timeout — a cold model load can easily take 30s+ on first
		// run. Bail at 2 min so a hung Ollama doesn't pin a forever-running
		// fetch on the warmup interval.
		signal: AbortSignal.timeout(120_000),
	});
	if (!response.ok) {
		const body = await readErrorText(response);
		const outcome = classifyWarmupResponse(response.status);
		logWarmupFailure(outcome, model, response.status, body);
		return { model, outcome, errorBody: body };
	}
	// Drain the body so the socket can be reused.
	await response.json().catch(() => undefined);
	dbg("llm", `Ollama warmup OK: ${model}`);
	return { model, outcome: "ok" };
}

function resolveWarmupEndpointOrSkip(endpoint: string, model: string): string | WarmupModelResult {
	if (!model) {
		return { model, outcome: "skipped" };
	}
	const normalizedEndpoint = normalizeOllamaEndpoint(endpoint);
	if (!normalizedEndpoint) {
		return { model, outcome: "skipped" };
	}
	return normalizedEndpoint;
}

async function warmupOllamaModel(endpoint: string, model: string): Promise<WarmupModelResult> {
	const resolved = resolveWarmupEndpointOrSkip(endpoint, model);
	if (typeof resolved !== "string") {
		return resolved;
	}
	try {
		return await performWarmupRequest(resolved, model);
	} catch (err) {
		const message = getErrorMessage(err);
		dbg("llm", `Ollama warmup failed for ${model}:`, message);
		return { model, outcome: "unreachable", errorBody: message };
	}
}

function isOllamaFeatureActive(feature: LlmFeature): boolean {
	const enabledKey = `llm.${feature}.enabled` as const;
	const providerKey = `llm.${feature}.provider` as const;
	if (getStoreValue(enabledKey) !== true) {
		return false;
	}
	return getStoreValue(providerKey) === "ollama";
}

function getOllamaModelForFeature(feature: LlmFeature): string {
	const modelKey = `llm.${feature}.model` as const;
	return getStoreValue(modelKey);
}

function addEnabledOllamaModel(out: Set<string>, feature: LlmFeature): void {
	if (!isOllamaFeatureActive(feature)) {
		return;
	}
	const model = getOllamaModelForFeature(feature);
	if (model) {
		out.add(model);
	}
}

function collectEnabledOllamaModels(): string[] {
	const out = new Set<string>();
	addEnabledOllamaModel(out, "dictation");
	addEnabledOllamaModel(out, "transforms");
	return Array.from(out);
}

// Status payload broadcast to all renderers after every warmup pass.
// The renderer uses this to drive UI banners — "Ollama not running",
// "Model not installed", "Model failed to load" — so the user has
// concrete information instead of a silently-stuck dictation toggle.
//
// `inProgress` is true on the leading broadcast (when warmup work
// begins for a non-empty model set). It flips false on the trailing
// broadcast that carries terminal outcomes. The renderer's swap
// tracker keys its spinner off this flag rather than waiting for a
// model to appear in `models[]` so slow loads (reasoning models on a
// single GPU evicting a previously-pinned model) don't pre-empt the
// 60-second safety timeout.
interface WarmupStatusPayload {
	endpoint: string;
	inProgress: boolean;
	models: WarmupModelResult[];
	ollamaInstalled: boolean;
	// `null` when no Ollama-backed feature is enabled (no work to do).
	// `true` when /api/tags answers. `false` when unreachable + auto-start
	// either didn't try (remote / throttled) or failed.
	reachable: boolean | null;
	timestamp: number;
}

let lastWarmupStatus: WarmupStatusPayload | null = null;

function broadcastWarmupStatus(payload: WarmupStatusPayload): void {
	lastWarmupStatus = payload;
	const live = BrowserWindow.getAllWindows().filter((bw) => !bw.isDestroyed());
	for (const bw of live) {
		try {
			bw.webContents.send(IPC.LLM_WARMUP_STATUS, payload);
		} catch (err) {
			dbg("llm", "broadcastWarmupStatus failed for window:", getErrorMessage(err));
		}
	}
}

function getLastWarmupStatus(): WarmupStatusPayload | null {
	return lastWarmupStatus;
}

// Models warmed on the previous pass. We diff this against the new
// enabled set to find models that should be unloaded — sending a
// `keep_alive: 0` POST to Ollama immediately frees their VRAM instead
// of waiting for the 30 m keep-alive lease to expire on its own. Critical
// for swap UX on single-GPU setups: without explicit eviction, swapping
// from a 14B reasoning model to a 4B chat model forces Ollama to
// serialize the new load behind the old model's keep-alive, blowing
// past the renderer's 60-second safety timeout.
let lastWarmedModels = new Set<string>();

async function unloadOllamaModel(endpoint: string, model: string): Promise<void> {
	const normalizedEndpoint = normalizeOllamaEndpoint(endpoint);
	if (!normalizedEndpoint) {
		return;
	}
	try {
		// Ollama interprets `keep_alive: 0` as "evict immediately" — the
		// model is unloaded the moment this request completes. We don't
		// need to wait for a real response, but await so we can log
		// failures. AbortSignal caps the wait at 5s in case Ollama is
		// hung; eviction is best-effort either way.
		await fetch(buildOllamaApiUrl(normalizedEndpoint, "/api/generate"), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model, prompt: "", keep_alive: 0, stream: false }),
			signal: AbortSignal.timeout(5000),
		});
		dbg("llm", `Ollama evict OK: ${model}`);
	} catch (err) {
		dbg("llm", `Ollama evict failed for ${model}:`, getErrorMessage(err));
	}
}

/**
 * Evict every model WinSTT has warmed into Ollama's VRAM/RAM. Called on app
 * quit. Ollama is a detached, long-lived daemon (often a system service), so
 * killing the WinSTT process tree never frees its models — they stay pinned
 * until the keep-alive lease lapses (default 5 m, longer if the user raised
 * it). A `keep_alive: 0` POST per model hands that VRAM back the moment WinSTT
 * exits. Scoped to `lastWarmedModels` so we only evict what *we* pinned, never
 * a model the user loaded from another app. Best-effort and bounded (each
 * request self-caps at 5 s); a down/unreachable Ollama just no-ops.
 */
export async function evictWarmedOllamaModels(): Promise<void> {
	const toEvict = Array.from(lastWarmedModels);
	lastWarmedModels = new Set();
	if (toEvict.length === 0) {
		return;
	}
	const endpoint = getStoreValue("llm.endpoint");
	await Promise.all(toEvict.map((m) => unloadOllamaModel(endpoint, m)));
}

async function warmupEnabledModels(): Promise<void> {
	const models = collectEnabledOllamaModels();
	const endpoint = getStoreValue("llm.endpoint");
	// Abort any in-flight chat from a previous (potentially different)
	// model so the new warmup doesn't queue behind a slow reasoning
	// stream on Ollama's per-model serializer.
	abortActiveOllamaChats("model-set changed");
	if (models.length === 0) {
		// Evict whatever we previously warmed — the user disabled every
		// Ollama-backed feature; don't leave VRAM pinned.
		const toEvict = Array.from(lastWarmedModels);
		lastWarmedModels = new Set();
		await Promise.all(toEvict.map((m) => unloadOllamaModel(endpoint, m)));
		broadcastWarmupStatus({
			endpoint,
			inProgress: false,
			reachable: null,
			ollamaInstalled: false,
			models: [],
			timestamp: Date.now(),
		});
		return;
	}
	// App-just-launched + Ollama-not-running case: bring it up before any
	// model warmup hits. Without this the first call refuses for ~10 s on
	// connection refused while the user wonders why dictation is broken.
	const reachable = await ensureOllamaReachable(endpoint);
	const detected = await detectOllama().catch(() => ({ installed: false }) as const);
	if (!reachable) {
		broadcastWarmupStatus({
			endpoint,
			inProgress: false,
			reachable: false,
			ollamaInstalled: detected.installed === true,
			// Mark every enabled model as unreachable so the UI can show
			// the same "Ollama isn't running" message under each subsection.
			models: models.map((m) => ({ model: m, outcome: "unreachable" as const })),
			timestamp: Date.now(),
		});
		return;
	}
	// Unload stale models (previously warmed but no longer enabled)
	// in parallel with the leading in-progress broadcast so the new
	// warmup gets a fresh VRAM slate without forcing the renderer to
	// wait for eviction before showing progress.
	const toEvict = Array.from(lastWarmedModels).filter((m) => !models.includes(m));
	const evictionPromise = Promise.all(toEvict.map((m) => unloadOllamaModel(endpoint, m)));
	// Leading broadcast — renderer's swap tracker treats "loading"
	// outcomes as "still working, keep spinner up" so a slow load no
	// longer trips the safety timeout.
	broadcastWarmupStatus({
		endpoint,
		inProgress: true,
		reachable: true,
		ollamaInstalled: detected.installed === true,
		models: models.map((m) => ({ model: m, outcome: "loading" as const })),
		timestamp: Date.now(),
	});
	await evictionPromise;
	const results = await Promise.all(models.map((m) => warmupOllamaModel(endpoint, m)));
	lastWarmedModels = new Set(results.filter((r) => r.outcome === "ok").map((r) => r.model));
	broadcastWarmupStatus({
		endpoint,
		inProgress: false,
		reachable: true,
		ollamaInstalled: detected.installed === true,
		models: results,
		timestamp: Date.now(),
	});
}

let warmupInterval: ReturnType<typeof setInterval> | null = null;
let warmupStoreUnsub: (() => void) | null = null;
let warmupDebounceTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Last warmup-relevant config signature. The `llm.*` store subtree is rewritten
 * wholesale by `settings:save` (which copies every key, changed or not), so a
 * naive `onDidChange("llm")` fires on every dictation cycle (settings save is
 * triggered by transient updates like VAD sensitivity adaptation). That makes
 * Ollama warm up on every PTT release — wasted bandwidth + visible Ollama-side
 * GPU/CPU churn. Gate the listener on a fingerprint of the only fields that
 * actually affect warmup (provider / model / endpoint / enabled flags) so
 * unchanged saves are a no-op.
 */
let lastWarmupSignature: string | null = null;

interface WarmupFeatureSignature {
	enabled: boolean;
	model: string;
	provider: string;
}

function readWarmupFeatureSignature(feature: LlmFeature): WarmupFeatureSignature {
	const enabledKey = `llm.${feature}.enabled` as const;
	const providerKey = `llm.${feature}.provider` as const;
	const modelKey = `llm.${feature}.model` as const;
	return {
		enabled: getStoreValue(enabledKey) === true,
		provider: getStoreValue(providerKey) ?? "",
		model: getStoreValue(modelKey) ?? "",
	};
}

function computeWarmupSignature(): string {
	// Stable JSON ordering — these are the inputs to `collectEnabledOllamaModels`
	// plus the endpoint that `warmupOllamaModel` POSTs to. Anything outside this
	// set (presets, openrouter keys, timeout, etc.) doesn't change WHAT we warm
	// up, so a save that only touches those keys is correctly a no-op.
	return JSON.stringify({
		endpoint: getStoreValue("llm.endpoint") ?? "",
		dictation: readWarmupFeatureSignature("dictation"),
		transforms: readWarmupFeatureSignature("transforms"),
	});
}

function fireWarmup(): void {
	lastWarmupSignature = computeWarmupSignature();
	warmupEnabledModels().catch((err) => {
		dbg("llm", "warmupEnabledModels rejected:", getErrorMessage(err));
	});
}

function scheduleDebouncedWarmup(): void {
	if (warmupDebounceTimer) {
		clearTimeout(warmupDebounceTimer);
	}
	warmupDebounceTimer = setTimeout(() => {
		warmupDebounceTimer = null;
		const next = computeWarmupSignature();
		if (next === lastWarmupSignature) {
			// Settings save didn't touch any warmup-relevant field — skip.
			return;
		}
		fireWarmup();
	}, WARMUP_SETTINGS_DEBOUNCE_MS);
}

/**
 * Start the Ollama warmup loop. Idempotent — calling it twice tears down
 * the previous interval/listener before installing fresh ones, so a hot
 * reload during development doesn't stack timers.
 *
 * Returns a cleanup function that stops the interval and unsubscribes from
 * the store listener; call from app shutdown / module teardown.
 */
export function setupLlmWarmup(): () => void {
	cleanupLlmWarmup();

	// Fire once immediately so the model is ready by the time the user
	// presses PTT — without this the user pays cold-start on first dictation
	// every single app launch.
	fireWarmup();

	warmupInterval = setInterval(fireWarmup, WARMUP_INTERVAL_MS);

	// Any change to the `llm` subtree (enabled toggle, provider switch,
	// model swap, endpoint edit) → rewarm so the newly-selected model is
	// hot. Debounced so flipping switches doesn't spam Ollama.
	warmupStoreUnsub = store.onDidChange("llm", scheduleDebouncedWarmup);

	return cleanupLlmWarmup;
}

function clearWarmupInterval(): void {
	if (warmupInterval) {
		clearInterval(warmupInterval);
		warmupInterval = null;
	}
}

function clearWarmupStoreUnsub(): void {
	if (warmupStoreUnsub) {
		warmupStoreUnsub();
		warmupStoreUnsub = null;
	}
}

function clearWarmupDebounceTimer(): void {
	if (warmupDebounceTimer) {
		clearTimeout(warmupDebounceTimer);
		warmupDebounceTimer = null;
	}
}

function cleanupLlmWarmup(): void {
	clearWarmupInterval();
	clearWarmupStoreUnsub();
	clearWarmupDebounceTimer();
	lastWarmupSignature = null;
}

// ── Test-only re-exports of newly extracted pure helpers ─────────────

export const __llm_test_helpers__ = {
	withContextPrefix,
	withVocabPrefix,
	salvageStructuredText,
	assertNonEmptyString,
	assertValidEndpoint,
	describePresets,
	parseOllamaTagsOrFail,
	parseChatStreamLine,
	applyChatStreamChunk,
	consumeChatStreamLines,
	readOllamaChatStream,
	splitInlineThinking,
	extractBoxedAnswer,
	extractHarmonyAnswer,
	extractPartialStructuredText,
	extractStructuredFinalText,
	finalizeChatAnswer,
	parseOpenRouterModelsOrFail,
	enrichOpenRouterModel,
	buildAuthHeaders,
	buildModelOptions,
	buildOllamaChatBody,
	stripTildePrefix,
	repairOpenRouterText,
	isPassThroughError,
	mapAndThrowOrReturn,
	isOllamaUnavailable,
	getOllamaCandidatePaths,
	isNonBlankLine,
	pickFirstNonBlankLine,
	assertProcessTextPayload,
	assertModelPayload,
	assertValidModelName,
	classifyPullStatus,
	matchPullStatusPrefix,
	computePercent,
	buildPullProgress,
	recordLayerProgress,
	aggregatePullProgress,
	parsePullLine,
	// Additional helpers for CRAP reduction
	readErrorText,
	assertOllamaResponseOk,
	resolveOpenRouterModelId,
	returnTextIfEmpty,
	rethrowOrFallbackEligible,
	isAbortError,
	iterateNdjsonChunks,
	applyPullLine,
	consumePullLines,
	broadcastPullProgress,
	runProcessText,
	findOllamaInDefaultDirs,
	fileExists,
	tryDetectOllamaPosix,
	tryFindOllamaViaWhere,
	detectOllamaWindows,
	handleProcessTextSafe,
	pullResultFromStreamOutcome,
	// CRAP reduction wave: predicate helpers for payload assertions + percent
	isPlainObject,
	assertPlainObject,
	assertStringField,
	assertCustomPromptPayload,
	handleProcessTextCustomSafe,
	isPositiveNumber,
	hasValidPercentInputs,
	processWithOpenRouterCustom,
	runCustomPromptPath,
	// Warmup helpers — exported so tests can assert which models get warmed
	// without firing real network calls (callers stub fetch).
	collectEnabledOllamaModels,
	warmupOllamaModel,
	warmupEnabledModels,
	// Reachability + classification helpers for the auto-start + missing/
	// corrupted-model edge cases.
	classifyWarmupResponse,
	isLoopbackEndpoint,
	pingOllama,
	ensureOllamaReachable,
	// Status broadcast accessor — tests assert the renderer-facing
	// payload shape after a warmup pass.
	getLastWarmupStatus,
	broadcastWarmupStatus,
	// CRAP-reduction wave: additional helpers exposed for unit tests.
	describeCustomPreset,
	describeTranslatePreset,
	tryAbortController,
	abortActiveOllamaChats,
	broadcastLearnedProperNouns,
	drainChatReaderInto,
	flushChatStreamBuffer,
	readRawNounsArray,
	isAcceptableNounString,
	appendCleanedNoun,
	cleanupRawNouns,
	endsWithEllipsis,
	classifyEllipsisPair,
	pickLongerOfTwo,
	pickLongerDescription,
	buildEndpointsResult,
	getCachedCapabilities,
	applyEndpointDetailToModel,
	isAcceptableUniqueNoun,
	normalizeNounCandidate,
	appendUniqueOpenRouterNoun,
	cleanOpenRouterNouns,
	readTransformsThinkingEffort,
	ensureOllamaInstalled,
	describeStartFailure,
	spawnOllamaOrLog,
	waitForOllamaOrLog,
	tryAutoStartAndWait,
	isThrottledBail,
	tryStartIfNotThrottled,
	waitForOllama,
	addEnabledOllamaModel,
	unloadOllamaModel,
	evictWarmedOllamaModels,
	readWarmupFeatureSignature,
	computeWarmupSignature,
	scheduleDebouncedWarmup,
	clearWarmupInterval,
	clearWarmupStoreUnsub,
	clearWarmupDebounceTimer,
	// Internal mutables exposed only for tests (read-only access — tests
	// inspect the set to assert register/unregister semantics).
	activeChatControllers,
	cacheCapabilities,
};
