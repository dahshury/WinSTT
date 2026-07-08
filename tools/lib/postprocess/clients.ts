// Provider clients for the modifier benchmark. Both the runner (model under
// test) and the judge can be either Ollama (local) or OpenRouter (cloud); the
// same call paths capture deterministic speed data from actual run output.

export type Provider = "ollama" | "openrouter";

export const TEXT_SCHEMA = {
	type: "object",
	properties: { text: { type: "string" } },
	required: ["text"],
	additionalProperties: false,
} as const;

export interface SpeedSample {
	/** End-to-end wall-clock time measured around the request (ms). */
	wallMs: number;
	/** Model-reported generation time (Ollama eval_duration), ms — null on cloud. */
	genMs: number | null;
	/** Completion/generation token count. */
	genTokens: number | null;
	/** Prompt (input) token count. */
	promptTokens: number | null;
	/** Generation throughput. From model timing when available, else wall clock. */
	tokensPerSec: number | null;
	source: "ollama-internal" | "openrouter-usage" | "wall";
}

export interface ChatResult {
	/** Raw assistant message content (may be JSON, fenced JSON, or plain text). */
	raw: string;
	speed: SpeedSample;
}

export interface OllamaConfig {
	endpoint: string;
	numCtx: number;
}

export function ollamaConfig(): OllamaConfig {
	return {
		endpoint: process.env["OLLAMA_ENDPOINT"] ?? "http://127.0.0.1:11434",
		numCtx: Number(process.env["OLLAMA_NUM_CTX"] ?? 16384),
	};
}

type Json = Record<string, unknown>;

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** now() without Date.now — perf hooks are always available under bun/node. */
function clockMs(): number {
	return performance.now();
}

export async function callOllamaChat(opts: {
	model: string;
	system: string;
	user: string;
	format?: unknown;
	think?: boolean;
	numPredict?: number;
	cfg?: OllamaConfig;
	label: string;
}): Promise<ChatResult> {
	const cfg = opts.cfg ?? ollamaConfig();
	const body: Json = {
		model: opts.model,
		messages: [
			{ role: "system", content: opts.system },
			{ role: "user", content: opts.user },
		],
		stream: false,
		think: opts.think ?? false,
		options: {
			temperature: 0,
			num_ctx: cfg.numCtx,
			num_predict: opts.numPredict ?? 8192,
		},
	};
	if (opts.format !== undefined) body["format"] = opts.format;
	const started = clockMs();
	const response = await fetch(`${cfg.endpoint}/api/chat`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const wallMs = clockMs() - started;
	if (!response.ok) {
		throw new Error(
			`${opts.label}: Ollama HTTP ${response.status} ${await response.text()}`,
		);
	}
	const data = (await response.json()) as Json;
	const message = (data["message"] ?? {}) as Json;
	const raw = typeof message["content"] === "string" ? message["content"] : "";
	const evalCount = num(data["eval_count"]);
	const evalDurNs = num(data["eval_duration"]);
	const genMs = evalDurNs === null ? null : evalDurNs / 1e6;
	const tokensPerSec =
		evalCount !== null && evalDurNs !== null && evalDurNs > 0
			? evalCount / (evalDurNs / 1e9)
			: null;
	return {
		raw,
		speed: {
			wallMs,
			genMs,
			genTokens: evalCount,
			promptTokens: num(data["prompt_eval_count"]),
			tokensPerSec,
			source: tokensPerSec !== null ? "ollama-internal" : "wall",
		},
	};
}

export async function callOpenRouterChat(opts: {
	model: string;
	system: string;
	user: string;
	jsonSchema?: { name: string; schema: unknown };
	/** "off" (or omitted) sends no reasoning block; otherwise reasoning.effort. */
	reasoningEffort?: string;
	label: string;
	apiKey: string;
}): Promise<ChatResult> {
	const body: Json = {
		model: opts.model,
		messages: [
			{ role: "system", content: opts.system },
			{ role: "user", content: opts.user },
		],
		temperature: 0,
	};
	if (opts.reasoningEffort && opts.reasoningEffort !== "off") {
		body["reasoning"] = { effort: opts.reasoningEffort };
	}
	if (opts.jsonSchema) {
		body["response_format"] = {
			type: "json_schema",
			json_schema: {
				name: opts.jsonSchema.name,
				strict: true,
				schema: opts.jsonSchema.schema,
			},
		};
	}
	const started = clockMs();
	const response = await fetch(
		"https://openrouter.ai/api/v1/chat/completions",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${opts.apiKey}`,
			},
			body: JSON.stringify(body),
		},
	);
	const wallMs = clockMs() - started;
	if (!response.ok) {
		throw new Error(
			`${opts.label}: OpenRouter HTTP ${response.status} ${await response.text()}`,
		);
	}
	const data = (await response.json()) as Json;
	const choices = data["choices"];
	const first =
		Array.isArray(choices) && choices.length > 0
			? (choices[0] as Json)
			: undefined;
	const msg = (first?.["message"] ?? {}) as Json;
	const raw = typeof msg["content"] === "string" ? msg["content"] : "";
	if (raw.trim() === "") {
		throw new Error(
			`${opts.label}: OpenRouter empty content: ${JSON.stringify(data).slice(0, 400)}`,
		);
	}
	const usage = (data["usage"] ?? {}) as Json;
	const completion = num(usage["completion_tokens"]);
	const tokensPerSec =
		completion !== null && wallMs > 0 ? completion / (wallMs / 1000) : null;
	return {
		raw,
		speed: {
			wallMs,
			genMs: null,
			genTokens: completion,
			promptTokens: num(usage["prompt_tokens"]),
			tokensPerSec,
			source: completion !== null ? "openrouter-usage" : "wall",
		},
	};
}

/** Strip inline `<think>…</think>` / `<thinking>…</thinking>` reasoning that
 *  thinking models leak into the content channel when Ollama doesn't honor
 *  `format`. Mirrors the runtime's `split_inline_thinking` (answer.rs) so the
 *  benchmark grades what the app would actually paste, not the raw reasoning. */
export function stripInlineThinking(content: string): string {
	let s = content;
	s = s.replace(/<think>[\s\S]*?<\/think>/gi, "");
	s = s.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
	// Lone closing tag (open implied or already stripped): drop up to it.
	if (/<\/think(?:ing)?>/i.test(s) && !/<think(?:ing)?>/i.test(s)) {
		s = s.replace(/^[\s\S]*?<\/think(?:ing)?>/i, "");
	}
	// Lone opening tag with no close: reasoning ran to the end, no answer left.
	if (/<think(?:ing)?>/i.test(s) && !/<\/think(?:ing)?>/i.test(s)) {
		s = s.replace(/<think(?:ing)?>[\s\S]*$/i, "");
	}
	return s.trim();
}

/** Pull the transformed text out of a model response. Structured-output models
 *  return `{"text": "..."}`, but cheaper models occasionally wrap that in a
 *  ```json fence, leak `<think>` reasoning, or return the cleaned text
 *  directly — tolerate all of these. */
export function extractText(raw: string): string {
	const unfenced = stripInlineThinking(raw)
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.trim();
	try {
		const parsed = JSON.parse(unfenced) as { text?: unknown };
		if (parsed && typeof parsed.text === "string") return parsed.text;
	} catch {
		// Not JSON — treat the (unfenced) content as the text.
	}
	return unfenced;
}

/** Parse a JSON object out of a judge response, tolerating code fences and
 *  leading/trailing prose (small local judges are chatty). */
export function extractJsonObject(raw: string): Json | null {
	const unfenced = stripInlineThinking(raw)
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.trim();
	const candidates = [unfenced];
	const first = unfenced.indexOf("{");
	const last = unfenced.lastIndexOf("}");
	if (first !== -1 && last > first)
		candidates.push(unfenced.slice(first, last + 1));
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Json;
			}
		} catch {
			// try next candidate
		}
	}
	return null;
}

/** Embed text with an Ollama model (/api/embed). Returns null on any failure so
 *  the semantic-delta metric degrades gracefully rather than aborting a run. */
export async function embedOllama(
	model: string,
	input: string,
	cfg?: OllamaConfig,
): Promise<number[] | null> {
	const config = cfg ?? ollamaConfig();
	try {
		const response = await fetch(`${config.endpoint}/api/embed`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model, input }),
		});
		if (!response.ok) return null;
		const data = (await response.json()) as Json;
		const embeddings = data["embeddings"];
		if (Array.isArray(embeddings) && Array.isArray(embeddings[0])) {
			return (embeddings[0] as unknown[]).map((v) => Number(v));
		}
		return null;
	} catch {
		return null;
	}
}
