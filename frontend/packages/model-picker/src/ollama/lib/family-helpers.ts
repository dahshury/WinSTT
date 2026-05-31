/**
 * Lightweight family extraction for Ollama models.
 *
 * Ollama returns a `details.family` field on `/api/tags` for recent versions,
 * but older builds (and some custom-imported models) omit it. As a fallback,
 * we parse the model name itself — Ollama names always carry the family as a
 * prefix before the first digit or colon (`llama3.2:1b` → `llama`,
 * `qwen2.5-coder:7b` → `qwen`, `gemma3:4b` → `gemma`).
 */

import type { OllamaModel } from "@/shared/api/models";

const FAMILY_REGEX = /^([a-zA-Z]+)/;

/**
 * Extract the family slug from an Ollama model. Prefers the structured
 * `details.family` when available, falls back to a regex on the name.
 * Returns `"other"` for malformed names so grouping never produces a
 * nameless bucket.
 */
export function getOllamaFamily(model: OllamaModel): string {
	// Prefer the NAME prefix (the publisher family) over `details.family` (the
	// model ARCHITECTURE) — they differ for re-published families: SmolLM is
	// llama-architecture, so Ollama reports `details.family="llama"`, which would
	// mis-group an installed SmolLM under Meta instead of Hugging Face. The
	// recommended-models list resolves by name, so name-first keeps a model in the
	// SAME maker group before and after download. `details.family` is only the
	// fallback for names that don't carry a usable alphabetic prefix.
	const match = FAMILY_REGEX.exec(model.name);
	if (match?.[1]) {
		return match[1].toLowerCase();
	}
	const explicit = model.details?.family;
	if (explicit && explicit.trim().length > 0) {
		return explicit.toLowerCase();
	}
	return "other";
}

/** Friendly display label for a family slug — capitalized, brand-cased. */
const FAMILY_DISPLAY: Record<string, string> = {
	llama: "Llama",
	qwen: "Qwen",
	gemma: "Gemma",
	mistral: "Mistral",
	mixtral: "Mixtral",
	phi: "Phi",
	deepseek: "DeepSeek",
	codellama: "Code Llama",
	codegemma: "Code Gemma",
	codestral: "Codestral",
	starcoder: "StarCoder",
	starcoder2: "StarCoder 2",
	tinyllama: "TinyLlama",
	smollm: "SmolLM",
	smollm2: "SmolLM 2",
	dolphin: "Dolphin",
	hermes: "Hermes",
	wizardlm: "WizardLM",
	yi: "Yi",
	granite: "Granite",
	command: "Command",
	commandr: "Command R",
	nemotron: "Nemotron",
	other: "Other",
};

/**
 * Map an Ollama model family slug → publisher info. Ollama's `/api/tags` does
 * not expose the maker, so we derive it from the well-known family name.
 * `slug` matches the keys in `lib/provider-icons.ts` so callers can render
 * the brand logo via `getProviderIconWithFallback`.
 */
interface OllamaPublisher {
	label: string;
	slug: string;
}

const FAMILY_PUBLISHER: Record<string, OllamaPublisher> = {
	llama: { slug: "meta-llama", label: "Meta" },
	codellama: { slug: "meta-llama", label: "Meta" },
	tinyllama: { slug: "meta-llama", label: "Meta" },
	gemma: { slug: "google", label: "Google" },
	codegemma: { slug: "google", label: "Google" },
	qwen: { slug: "qwen", label: "Alibaba" },
	phi: { slug: "microsoft", label: "Microsoft" },
	mistral: { slug: "mistralai", label: "Mistral AI" },
	mixtral: { slug: "mistralai", label: "Mistral AI" },
	codestral: { slug: "mistralai", label: "Mistral AI" },
	deepseek: { slug: "deepseek", label: "DeepSeek" },
	granite: { slug: "ibm-granite", label: "IBM" },
	nemotron: { slug: "nvidia", label: "NVIDIA" },
	command: { slug: "cohere", label: "Cohere" },
	commandr: { slug: "cohere", label: "Cohere" },
	hermes: { slug: "nousresearch", label: "Nous Research" },
	dolphin: { slug: "cognitivecomputations", label: "Cognitive Computations" },
	yi: { slug: "01-ai", label: "01.AI" },
	smollm: { slug: "huggingface", label: "Hugging Face" },
	smollm2: { slug: "huggingface", label: "Hugging Face" },
	starcoder: { slug: "huggingface", label: "Hugging Face" },
	starcoder2: { slug: "huggingface", label: "Hugging Face" },
	wizardlm: { slug: "microsoft", label: "Microsoft" },
};

// `community` has no bundled logo on purpose — unmapped makers render a neutral
// initials chip instead of the misleading OpenRouter "O" that `openrouter` would
// pull in.
const DEFAULT_PUBLISHER: OllamaPublisher = { slug: "community", label: "Community" };

/**
 * Pattern-based publisher inference for the ~230 models on `ollama.com/library`.
 * Exact-family hits in {@link FAMILY_PUBLISHER} win first; anything else falls
 * through these rules so compound slugs (`medgemma`, `paligemma`,
 * `embeddinggemma`, `llama3-vision`, `qwen2.5-coder`) still resolve to the
 * right maker. Order is significant — list more specific markers before
 * generic ones (e.g. `codellama` before plain `code`).
 */
interface PublisherRule {
	publisher: OllamaPublisher;
	tokens: readonly string[];
}

const PUBLISHER_RULES: readonly PublisherRule[] = [
	// Google
	{
		publisher: { slug: "google", label: "Google" },
		tokens: ["gemma", "paligemma", "gemini"],
	},
	// OpenAI — open-weight releases (family slug truncates `gpt-oss` → `gpt`)
	{
		publisher: { slug: "openai", label: "OpenAI" },
		tokens: ["gpt"],
	},
	// Meta
	{
		publisher: { slug: "meta-llama", label: "Meta" },
		tokens: ["llama", "tinyllama", "codellama"],
	},
	// Alibaba — qwen / qwq / qwen2-vl / qwen2.5-coder etc
	{
		publisher: { slug: "qwen", label: "Alibaba" },
		tokens: ["qwen", "qwq"],
	},
	// Microsoft — phi family + WizardLM + Orca (Microsoft Research)
	{
		publisher: { slug: "microsoft", label: "Microsoft" },
		tokens: ["phi", "wizardlm", "wizardmath", "wizardcoder", "wizardvicuna", "orca"],
	},
	// Mistral AI
	{
		publisher: { slug: "mistralai", label: "Mistral AI" },
		tokens: ["mistral", "mixtral", "codestral", "magistral", "devstral", "pixtral", "ministral"],
	},
	// DeepSeek
	{
		publisher: { slug: "deepseek", label: "DeepSeek" },
		tokens: ["deepseek"],
	},
	// IBM
	{
		publisher: { slug: "ibm-granite", label: "IBM" },
		tokens: ["granite"],
	},
	// NVIDIA
	{
		publisher: { slug: "nvidia", label: "NVIDIA" },
		tokens: ["nemotron", "minitron", "llama-nemotron"],
	},
	// Cohere
	{
		publisher: { slug: "cohere", label: "Cohere" },
		tokens: ["command", "aya"],
	},
	// Nous Research
	{
		publisher: { slug: "nousresearch", label: "Nous Research" },
		tokens: ["hermes", "nous"],
	},
	// Cognitive Computations
	{
		publisher: { slug: "cognitivecomputations", label: "Cognitive Computations" },
		tokens: ["dolphin"],
	},
	// 01.AI
	{
		publisher: { slug: "01-ai", label: "01.AI" },
		tokens: ["yi"],
	},
	// TII (Falcon)
	{
		publisher: { slug: "tii", label: "TII" },
		tokens: ["falcon"],
	},
	// LG AI Research (EXAONE)
	{
		publisher: { slug: "lgai", label: "LG AI" },
		tokens: ["exaone"],
	},
	// Upstage (SOLAR)
	{
		publisher: { slug: "upstage", label: "Upstage" },
		tokens: ["solar"],
	},
	// Databricks
	{
		publisher: { slug: "databricks", label: "Databricks" },
		tokens: ["dbrx"],
	},
	// Stability AI (`stable-code`/`stable-beluga` → family `stable`)
	{
		publisher: { slug: "stabilityai", label: "Stability AI" },
		tokens: ["stablelm", "stable"],
	},
	// Deep Cogito
	{
		publisher: { slug: "deepcogito", label: "Deep Cogito" },
		tokens: ["cogito"],
	},
	// Intel (`neural-chat` → family `neural`)
	{
		publisher: { slug: "intel", label: "Intel" },
		tokens: ["neural"],
	},
	// Nexusflow
	{
		publisher: { slug: "nexusflow", label: "Nexusflow" },
		tokens: ["athene", "nexusraven"],
	},
	// Hugging Face hosted (community)
	{
		publisher: { slug: "huggingface", label: "Hugging Face" },
		tokens: ["smollm", "smolvlm", "starcoder", "zephyr"],
	},
	// Moonshot
	{
		publisher: { slug: "moonshotai", label: "Moonshot" },
		tokens: ["kimi", "moonshot"],
	},
	// xAI
	{
		publisher: { slug: "x-ai", label: "xAI" },
		tokens: ["grok"],
	},
	// Z.AI / Zhipu — GLM family
	{
		publisher: { slug: "z-ai", label: "Z.AI" },
		tokens: ["glm", "chatglm"],
	},
	// MiniMax
	{
		publisher: { slug: "minimax", label: "MiniMax" },
		tokens: ["minimax"],
	},
	// Allen AI
	{
		publisher: { slug: "allenai", label: "Allen AI" },
		tokens: ["olmo", "tulu", "molmo"],
	},
	// StepFun AI
	{
		publisher: { slug: "stepfun-ai", label: "StepFun AI" },
		tokens: ["step"],
	},
	// Liquid AI
	{
		publisher: { slug: "liquid", label: "Liquid AI" },
		tokens: ["lfm", "liquid"],
	},
	// OpenGVLab / InternLM
	{
		publisher: { slug: "opengvlab", label: "OpenGVLab" },
		tokens: ["internlm", "internvl"],
	},
	// Tencent
	{
		publisher: { slug: "tencent", label: "Tencent" },
		tokens: ["hunyuan"],
	},
	// Baidu
	{
		publisher: { slug: "baidu", label: "Baidu" },
		tokens: ["ernie"],
	},
	// ByteDance
	{
		publisher: { slug: "bytedance", label: "ByteDance" },
		tokens: ["doubao", "seedream"],
	},
	// THUDM
	{
		publisher: { slug: "thudm", label: "THUDM" },
		tokens: ["codegeex"],
	},
	// Inception
	{
		publisher: { slug: "inception", label: "Inception" },
		tokens: ["jais"],
	},
];

function matchPublisherRule(slug: string): OllamaPublisher | null {
	for (const rule of PUBLISHER_RULES) {
		for (const token of rule.tokens) {
			if (slug.includes(token)) {
				return rule.publisher;
			}
		}
	}
	return null;
}

/**
 * Resolve the publisher for an Ollama model family.
 *
 * The lookup runs in three stages: exact `FAMILY_PUBLISHER` hit (cheapest,
 * preserves backward-compat with callers passing already-narrowed family
 * slugs), then a substring scan via {@link PUBLISHER_RULES} so compound
 * names (`medgemma`, `paligemma`, `qwen2-vl`, `llama-guard`) still pick up
 * the right maker, then the community fallback.
 */
export function getOllamaPublisher(family: string): OllamaPublisher {
	const normalized = family.toLowerCase();
	const exact = FAMILY_PUBLISHER[normalized];
	if (exact) {
		return exact;
	}
	const inferred = matchPublisherRule(normalized);
	if (inferred) {
		return inferred;
	}
	return DEFAULT_PUBLISHER;
}

/**
 * Group models by *publisher* (Google, Meta, Microsoft, …) rather than family
 * slug. Two different families that share a publisher (e.g. `gemma` and
 * `codegemma` → Google) collapse into one section so the user sees one tile
 * per maker — the same mental model as the OpenRouter picker.
 *
 * Returns `[publisherSlug, models][]` sorted alphabetically by label, with
 * the slug usable as a `data-rail-section` id and a lookup key for
 * {@link getOllamaPublisher}.
 */
export function groupOllamaModelsByPublisher(
	models: readonly OllamaModel[]
): [string, OllamaModel[]][] {
	const groups = new Map<string, OllamaModel[]>();
	for (const model of models) {
		const family = getOllamaFamily(model);
		const publisher = getOllamaPublisher(family);
		const bucket = groups.get(publisher.slug);
		if (bucket) {
			bucket.push(model);
		} else {
			groups.set(publisher.slug, [model]);
		}
	}
	return Array.from(groups.entries()).toSorted(([a], [b]) => {
		const labelA = getOllamaPublisherBySlug(a).label;
		const labelB = getOllamaPublisherBySlug(b).label;
		return labelA.localeCompare(labelB);
	});
}

/**
 * Resolve a publisher straight from its slug — used by the picker to render
 * group headers and rail tiles after {@link groupOllamaModelsByPublisher}
 * has already converted the family slug to its publisher.
 */
export function getOllamaPublisherBySlug(slug: string): OllamaPublisher {
	if (slug === DEFAULT_PUBLISHER.slug) {
		return DEFAULT_PUBLISHER;
	}
	for (const value of Object.values(FAMILY_PUBLISHER)) {
		if (value.slug === slug) {
			return value;
		}
	}
	for (const rule of PUBLISHER_RULES) {
		if (rule.publisher.slug === slug) {
			return rule.publisher;
		}
	}
	return { slug, label: slug.charAt(0).toUpperCase() + slug.slice(1) };
}

// Tokens we strip from the display name because they're shown as their own
// chips (parameter count, quantization) — repeating them in the title makes
// the row look noisy. Matches `4b`, `1.7b`, `270m`, `135m`, `0.6b`, `q4_K_M`,
// `q8_0`, `fp16`, `int8`, `bf16`.
const PARAM_TOKEN_RE = /^\d+(?:\.\d+)?[mbk]$/i;
const QUANT_TOKEN_RE = /^(?:q\d[a-z0-9_]*|fp\d+|int\d+|bf\d+)$/i;
// Strips the whole quant marker plus any underscore-joined numeric tail
// (`q8_0`, `q4_K_M`) from a variant string before we split on `-_`. Doing
// this in one shot avoids producing leftover trailing `0` / `M` tokens.
const QUANT_STRIP_RE = /(?:^|[-_])(?:q\d[a-z0-9]*(?:_[a-z0-9]+)*|fp\d+|int\d+|bf\d+)/gi;
const LEADING_DIGIT_RE = /^\d/;
const VARIANT_SPLIT_RE = /[-_]/;

/** Token-by-token capitalization preserving known multi-cap brand spellings. */
const TOKEN_CASING: Record<string, string> = {
	it: "IT",
	qat: "QAT",
	instruct: "Instruct",
	chat: "Chat",
	vision: "Vision",
	cloud: "Cloud",
	mini: "Mini",
	moe: "MoE",
	tools: "Tools",
};

function formatToken(token: string): string {
	const lower = token.toLowerCase();
	if (TOKEN_CASING[lower]) {
		return TOKEN_CASING[lower] as string;
	}
	if (LEADING_DIGIT_RE.test(lower)) {
		return lower;
	}
	return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function splitBaseAlphaNumeric(base: string): string[] {
	return base.match(/[a-zA-Z]+|[\d.]+/g) ?? [];
}

/**
 * Beautify an Ollama tag for display:
 *
 *   `gemma3:4b`           → "Gemma 3"
 *   `qwen3:1.7b`          → "Qwen 3"
 *   `llama3.2:1b`         → "Llama 3.2"
 *   `phi3:mini`           → "Phi 3 Mini"
 *   `gemma3:4b-it-q8_0`   → "Gemma 3 IT"
 *   `smollm2:135m`        → "SmolLM 2"
 *   `tinyllama`           → "TinyLlama"
 *
 * Parameter-size and quantization tokens are stripped because the picker
 * surfaces those as dedicated chips. Family slugs hit
 * {@link FAMILY_DISPLAY} for known brand casing (TinyLlama, SmolLM, DeepSeek…);
 * unknown families fall back to first-letter capitalization.
 */
export function formatOllamaDisplayName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) {
		return "";
	}
	const colonIdx = trimmed.indexOf(":");
	const base = colonIdx >= 0 ? trimmed.slice(0, colonIdx) : trimmed;
	const variant = colonIdx >= 0 ? trimmed.slice(colonIdx + 1) : "";

	const baseTokens = splitBaseAlphaNumeric(base);
	const firstToken = baseTokens[0]?.toLowerCase() ?? "";
	const familyLabel = FAMILY_DISPLAY[firstToken] ?? formatToken(firstToken);
	const baseParts = [familyLabel, ...baseTokens.slice(1).map(formatToken)];

	const variantWithoutQuant = variant.replace(QUANT_STRIP_RE, "");
	const variantParts = variantWithoutQuant
		.split(VARIANT_SPLIT_RE)
		.map((t) => t.trim())
		.filter((t) => t.length > 0 && !PARAM_TOKEN_RE.test(t) && !QUANT_TOKEN_RE.test(t))
		.map(formatToken);

	return [...baseParts, ...variantParts].filter(Boolean).join(" ");
}

/** Pretty size label — "1.2 GB" / "650 MB" / "—" when unknown. */
export function formatOllamaSize(bytes: number | undefined): string {
	if (!bytes || bytes <= 0) {
		return "—";
	}
	if (bytes >= 1e9) {
		return `${(bytes / 1e9).toFixed(1)} GB`;
	}
	if (bytes >= 1e6) {
		return `${Math.round(bytes / 1e6)} MB`;
	}
	return `${bytes} B`;
}
