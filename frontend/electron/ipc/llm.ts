import { execFile, spawn } from "node:child_process";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateObject } from "ai";
import { BrowserWindow, ipcMain } from "electron";
import { z } from "zod";
import { PRESET_PROMPTS } from "../../src/entities/llm-catalog/lib/preset-prompts";
import { IPC } from "../../src/shared/api/ipc-channels";
import {
	ConnectionError,
	getErrorMessage,
	TimeoutError,
	ValidationError,
} from "../../src/shared/lib/errors";
import { buildOllamaApiUrl, normalizeOllamaEndpoint } from "../../src/shared/lib/ollama-endpoint";
import { parseModelSelection } from "../../src/shared/lib/openrouter-model-selection";
import { dbg } from "../lib/debug-log";
import { getStoreValue } from "../lib/store";

const execFileAsync = promisify(execFile);
const NEWLINE_RE = /\r?\n/;

// ── Ollama API response schemas ───────────────────────────────────────

const ollamaTagsModelSchema = z.object({
	name: z.string(),
	size: z.number(),
	modified_at: z.string().optional(),
	modifiedAt: z.string().optional(),
});

const ollamaTagsResponseSchema = z.object({
	models: z.array(ollamaTagsModelSchema).optional(),
});

const ollamaChatResponseSchema = z.object({
	model: z.string(),
	created_at: z.string(),
	message: z.object({
		role: z.string(),
		content: z.string(),
	}),
	done: z.boolean(),
});

interface OllamaModel {
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

const openRouterModelSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string().optional(),
	context_length: z.number().int().optional(),
	pricing: openRouterPricingSchema.optional(),
	supported_parameters: z.array(z.string()).optional(),
});

const openRouterModelsResponseSchema = z.object({
	data: z.array(openRouterModelSchema).optional(),
});

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

interface OpenRouterScanResult {
	error?: string;
	models: OpenRouterScanModel[];
	reachable: boolean;
}

const STRUCTURED_OUTPUT_DESCRIPTION =
	"Return ONLY the transformed text. No commentary, no explanations, no JSON keys other than `text`.";

const transformedTextSchema = z.object({
	text: z.string().describe("The transformed text, with no commentary or explanations."),
});

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

function resolvePresetPrompt(preset: string): string {
	if (preset in PRESET_PROMPTS) {
		return PRESET_PROMPTS[preset as keyof typeof PRESET_PROMPTS];
	}
	return PRESET_PROMPTS.neutral;
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

function toOllamaModel(item: z.infer<typeof ollamaTagsModelSchema>): OllamaModel {
	const modifiedAt = item.modifiedAt ?? item.modified_at ?? "";
	return { name: item.name, size: item.size, modifiedAt };
}

function parseOllamaTagsOrFail(json: unknown): OllamaScanResult {
	const parsed = ollamaTagsResponseSchema.safeParse(json);
	if (!parsed.success) {
		dbg("llm", "Ollama /api/tags response did not match expected schema:", parsed.error.message);
		return { models: [], reachable: true, error: "Unexpected response shape from Ollama" };
	}
	return { models: mapOllamaTagsModels(parsed.data.models ?? []), reachable: true };
}

function parseOllamaChatOrFallback(json: unknown, fallback: string): string {
	const parsed = ollamaChatResponseSchema.safeParse(json);
	if (!parsed.success) {
		dbg("llm", "Ollama /api/chat response did not match expected schema:", parsed.error.message);
		return fallback;
	}
	const generated = parsed.data.message.content.trim();
	if (!generated) {
		dbg("llm", "Empty response from Ollama, using original text");
		return fallback;
	}
	return generated;
}

async function assertOllamaResponseOk(
	response: Response,
	ctx: { endpoint: string; model: string; preset: string }
): Promise<void> {
	if (response.ok) {
		return;
	}
	const errorText = await readErrorText(response);
	throw new ConnectionError(
		`LLM API request failed: HTTP ${response.status} - ${errorText}`,
		ctx.endpoint,
		false,
		{ model: ctx.model, preset: ctx.preset, statusCode: response.status }
	);
}

function buildOllamaChatBody(
	model: string,
	messages: OllamaChatMessage[],
	textLength: number
): string {
	return JSON.stringify({
		model,
		messages,
		stream: false,
		options: {
			temperature: 0.3,
			top_p: 0.9,
			num_predict: Math.max(textLength * 2, 100),
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
	return {
		id: m.id,
		name: m.name,
		description: m.description,
		context_length: m.context_length,
		pricing: m.pricing,
		provider: "openrouter",
		maker,
		model_name,
		variant,
		supported_parameters: m.supported_parameters,
	};
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
	return parseOllamaTagsOrFail(json);
}

async function processWithOllama(
	text: string,
	model: string,
	preset: string,
	endpoint: string,
	timeout: number
): Promise<string> {
	assertNonEmptyString(model, "Ollama model is required", "model");
	const normalizedEndpoint = assertValidEndpoint(endpoint);

	const systemPrompt = resolvePresetPrompt(preset);
	const userPrompt = `Transform the following text according to the style guide above. Return ONLY the transformed text with no additional commentary, explanations, or JSON formatting. Just the plain transformed text.\n\nText to transform:\n${text}`;

	const messages: OllamaChatMessage[] = [
		{ role: "system", content: systemPrompt },
		{ role: "user", content: userPrompt },
	];

	const response = await fetch(buildOllamaApiUrl(normalizedEndpoint, "/api/chat"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: buildOllamaChatBody(model, messages, text.length),
		signal: AbortSignal.timeout(timeout),
	});

	await assertOllamaResponseOk(response, { endpoint: normalizedEndpoint, model, preset });

	const chatJson: unknown = await response.json();
	return parseOllamaChatOrFallback(chatJson, text);
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
	if (isFetchError(response)) {
		return { models: [], reachable: false, error: response.error };
	}
	if (!response.ok) {
		const message = `OpenRouter /models returned HTTP ${response.status}`;
		dbg("llm", message);
		return { models: [], reachable: true, error: message };
	}
	const json: unknown = await response.json();
	return parseOpenRouterModelsOrFail(json);
}

async function processWithOpenRouter(
	text: string,
	apiKey: string,
	modelSelection: string,
	preset: string,
	timeout: number
): Promise<string> {
	if (!apiKey) {
		throw new ValidationError("OpenRouter API key is required", "apiKey");
	}
	const { modelId, providerSlug } = parseModelSelection(modelSelection);
	const effectiveModelId = resolveOpenRouterModelId(modelId);

	const systemPrompt = resolvePresetPrompt(preset);
	const userPrompt = `Transform the following text according to the style guide above. ${STRUCTURED_OUTPUT_DESCRIPTION}\n\nText to transform:\n${text}`;

	const openrouter = createOpenRouter({
		apiKey,
		headers: {
			"HTTP-Referer": "https://github.com/dahshury/winstt",
			"X-Title": "WinSTT",
		},
	});

	const model = openrouter.chat(effectiveModelId, buildModelOptions(providerSlug));

	const result = await generateObject({
		model,
		system: systemPrompt,
		prompt: userPrompt,
		abortSignal: AbortSignal.timeout(timeout),
		schemaName: "TransformedText",
		schemaDescription: "The transformed text only.",
		schema: transformedTextSchema,
		// Some providers (notably Anthropic via OpenRouter) return JSON wrapped
		// in markdown fences or with leading commentary. The OpenRouter
		// `response-healing` plugin handles this server-side; this fallback
		// repairs anything that still slips through.
		experimental_repairText: ({ text: raw }) => Promise.resolve(repairOpenRouterText(raw)),
		providerOptions: {
			openrouter: {
				plugins: [{ id: "response-healing" }],
			},
		},
	});

	return returnTextIfEmpty(result.object.text.trim(), text);
}

// ── processText: dispatch + error mapping ─────────────────────────────

interface ProcessTextCtx {
	preset: string;
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
	dbg("llm", "LLM processing failed:", getErrorMessage(err));
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
	preset: string,
	timeout: number
): Promise<string> {
	try {
		return await processWithOpenRouter(text, apiKey, primary, preset, timeout);
	} catch (primaryErr) {
		rethrowOrFallbackEligible(primaryErr, fallback);
		dbg(
			"llm",
			`OpenRouter primary failed (${getErrorMessage(primaryErr)}); trying fallback ${fallback}`
		);
		return await processWithOpenRouter(text, apiKey, fallback, preset, timeout);
	}
}

function runOpenRouterPath(text: string, preset: string, timeout: number): Promise<string> {
	const apiKey = getStoreValue("llm.openrouterApiKey");
	const primary = getStoreValue("llm.openrouterModel");
	const fallback = getStoreValue("llm.openrouterFallbackModel");
	return runOpenRouterWithFallback(text, apiKey, primary, fallback, preset, timeout);
}

function runOllamaPath(text: string, preset: string, timeout: number): Promise<string> {
	const endpoint = getStoreValue("llm.endpoint");
	const model = getStoreValue("llm.model");
	return processWithOllama(text, model, preset, endpoint, timeout);
}

function runProcessText(
	text: string,
	provider: string,
	preset: string,
	timeout: number
): Promise<string> {
	if (provider === "openrouter") {
		return runOpenRouterPath(text, preset, timeout);
	}
	return runOllamaPath(text, preset, timeout);
}

/**
 * Process text using either Ollama or OpenRouter, based on stored settings.
 * OpenRouter goes through the Vercel AI SDK with a strict Zod-validated
 * structured output (`{ text }`), so the result is guaranteed to be plain
 * transformed text with no surrounding commentary.
 */
export async function processText(text: string): Promise<string> {
	assertNonEmptyString(text, "Text is required for LLM processing", "text");

	const provider = getStoreValue("llm.provider");
	const preset = getStoreValue("llm.preset");
	const timeout = getStoreValue("llm.timeout");

	try {
		return await runProcessText(text, provider, preset, timeout);
	} catch (err) {
		return mapAndThrowOrReturn(err, { provider, preset, timeout }, text);
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

function broadcastPullProgress(progress: OllamaPullProgressPayload): void {
	for (const bw of BrowserWindow.getAllWindows()) {
		if (!bw.isDestroyed()) {
			bw.webContents.send(IPC.LLM_PULL_PROGRESS, progress);
		}
	}
}

function classifyPullStatus(statusText: string): OllamaPullStatus {
	const normalized = statusText.toLowerCase();
	if (normalized === "success") {
		return "success";
	}
	if (normalized.startsWith("pulling manifest") || normalized.startsWith("retrieving")) {
		return "pulling";
	}
	if (normalized.startsWith("pulling ") || normalized.startsWith("downloading")) {
		return "downloading";
	}
	if (normalized.startsWith("verifying")) {
		return "verifying";
	}
	if (normalized.startsWith("writing") || normalized.startsWith("removing")) {
		return "writing";
	}
	return "pulling";
}

function computePercent(completed?: number, total?: number): number | undefined {
	if (typeof completed !== "number" || typeof total !== "number" || total <= 0) {
		return;
	}
	const ratio = (completed / total) * 100;
	return Math.max(0, Math.min(100, ratio));
}

function buildPullProgress(
	model: string,
	parsed: z.infer<typeof ollamaPullProgressSchema>
): OllamaPullProgressPayload {
	return {
		model,
		status: classifyPullStatus(parsed.status),
		statusText: parsed.status,
		digest: parsed.digest,
		completed: parsed.completed,
		total: parsed.total,
		percent: computePercent(parsed.completed, parsed.total),
		error: parsed.error,
	};
}

function* iterateNdjsonChunks(buffer: { value: string }): Generator<string> {
	let newlineIdx = buffer.value.indexOf("\n");
	while (newlineIdx !== -1) {
		const line = buffer.value.slice(0, newlineIdx).trim();
		buffer.value = buffer.value.slice(newlineIdx + 1);
		if (line) {
			yield line;
		}
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

interface PullStreamState {
	buffer: { value: string };
	final: { error?: string; success: boolean };
}

function consumePullLines(state: PullStreamState, model: string): void {
	for (const line of iterateNdjsonChunks(state.buffer)) {
		const parsed = parsePullLine(line);
		if (!parsed) {
			continue;
		}
		const progress = buildPullProgress(model, parsed);
		broadcastPullProgress(progress);
		if (progress.status === "success") {
			state.final.success = true;
		}
		if (parsed.error) {
			state.final.error = parsed.error;
		}
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
	};
	while (true) {
		const { value, done } = await reader.read();
		if (done) {
			break;
		}
		state.buffer.value += decoder.decode(value, { stream: true });
		consumePullLines(state, model);
	}
	state.buffer.value += decoder.decode();
	if (state.buffer.value.trim()) {
		consumePullLines({ buffer: state.buffer, final: state.final }, model);
	}
	return state.final;
}

function isAbortError(err: unknown): boolean {
	if (!(err instanceof Error)) {
		return false;
	}
	return err.name === "AbortError";
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

	const result = await readPullStream(response.body, model);
	if (result.success) {
		return { success: true, model };
	}
	const message = result.error ?? "Pull did not complete successfully";
	broadcastPullProgress({ model, status: "error", error: message });
	return { success: false, model, error: message };
}

function assertValidModelName(model: string): void {
	assertNonEmptyString(model, "Model name is required", "model");
	if (!VALID_PULL_NAME_RE.test(model)) {
		throw new ValidationError("Model name contains invalid characters", "model");
	}
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
		if (isAbortError(err)) {
			broadcastPullProgress({ model, status: "cancelled" });
			return { success: false, model, cancelled: true };
		}
		const message = getErrorMessage(err);
		dbg("llm", `Ollama pull failed for ${model}:`, message);
		broadcastPullProgress({ model, status: "error", error: message });
		return { success: false, model, error: message };
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

function assertProcessTextPayload(payload: unknown): asserts payload is { text: string } {
	if (!payload || typeof payload !== "object") {
		throw new ValidationError("LLM process-text payload must be an object", "payload");
	}
	const text = (payload as { text?: unknown }).text;
	if (typeof text !== "string") {
		throw new ValidationError("LLM process-text payload.text must be a string", "text");
	}
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

function assertModelPayload(payload: unknown): asserts payload is { model: string } {
	if (!payload || typeof payload !== "object") {
		throw new ValidationError("Payload must be an object", "payload");
	}
	const model = (payload as { model?: unknown }).model;
	if (typeof model !== "string") {
		throw new ValidationError("Payload.model must be a string", "model");
	}
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
	ipcMain.handle(IPC.LLM_DETECT_OLLAMA, handleDetectOllama);
	ipcMain.handle(IPC.LLM_START_OLLAMA, handleStartOllama);
	ipcMain.handle(IPC.LLM_SCAN_OPENROUTER_MODELS, handleScanOpenRouterModels);
	ipcMain.handle(IPC.LLM_PULL_MODEL, handlePullModel);
	ipcMain.handle(IPC.LLM_CANCEL_PULL_MODEL, handleCancelPull);
	ipcMain.handle(IPC.LLM_DELETE_MODEL, handleDeleteModel);

	return () => {
		ipcMain.removeHandler(IPC.LLM_SCAN_MODELS);
		ipcMain.removeHandler(IPC.LLM_PROCESS_TEXT);
		ipcMain.removeHandler(IPC.LLM_DETECT_OLLAMA);
		ipcMain.removeHandler(IPC.LLM_START_OLLAMA);
		ipcMain.removeHandler(IPC.LLM_SCAN_OPENROUTER_MODELS);
		ipcMain.removeHandler(IPC.LLM_PULL_MODEL);
		ipcMain.removeHandler(IPC.LLM_CANCEL_PULL_MODEL);
		ipcMain.removeHandler(IPC.LLM_DELETE_MODEL);
		for (const controller of activePulls.values()) {
			controller.abort();
		}
		activePulls.clear();
	};
}

// ── Test-only re-exports of newly extracted pure helpers ─────────────

export const __llm_test_helpers__ = {
	assertNonEmptyString,
	assertValidEndpoint,
	resolvePresetPrompt,
	parseOllamaTagsOrFail,
	parseOllamaChatOrFallback,
	parseOpenRouterModelsOrFail,
	enrichOpenRouterModel,
	buildAuthHeaders,
	buildModelOptions,
	buildOllamaChatBody,
	stripTildePrefix,
	repairOpenRouterText,
	isPassThroughError,
	isAbortLikeTimeoutError,
	toTimeoutErrorOrNull,
	mapAndThrowOrReturn,
	isOllamaUnavailable,
	getOllamaCandidatePaths,
	isNonBlankLine,
	pickFirstNonBlankLine,
	assertProcessTextPayload,
	assertModelPayload,
	assertValidModelName,
	classifyPullStatus,
	computePercent,
	buildPullProgress,
	parsePullLine,
};
