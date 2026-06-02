/**
 * Provider / model-maker icon mappings — vendored into the main app `src/`
 * from `packages/model-picker/src/lib/provider-icons.ts` (that package is a
 * separate webview bundle and isn't importable here, same as the vendored
 * `public-asset.ts`). PNG/SVG/WebP icons live in `public/provider-icons/`.
 *
 * Used by the transcription-history footer to brand the model chip with its
 * maker logo. `resolveProviderIcon` returns `null` for an unmapped maker so the
 * caller can fall back to a neutral glyph instead of a misleading logo.
 */

import { publicAsset } from "./public-asset";

const PROVIDER_ICONS: Record<string, string> = {
	ai21: "/provider-icons/ai21.png",
	"aion-labs": "/provider-icons/aion-labs.png",
	alfredpros: "/provider-icons/alfredpros.png",
	alibaba: "/provider-icons/alibaba.png",
	allenai: "/provider-icons/allenai.png",
	alpindale: "/provider-icons/alpindale.png",
	amazon: "/provider-icons/amazon.png",
	"anthracite-org": "/provider-icons/anthracite-org.png",
	anthropic: "/provider-icons/anthropic.png",
	"arcee-ai": "/provider-icons/arcee-ai.png",
	arliai: "/provider-icons/arliai.png",
	baidu: "/provider-icons/baidu.png",
	bytedance: "/provider-icons/bytedance.png",
	cognitivecomputations: "/provider-icons/cognitivecomputations.png",
	cohere: "/provider-icons/cohere.png",
	deepcogito: "/provider-icons/deepcogito.png",
	deepseek: "/provider-icons/deepseek.png",
	eleutherai: "/provider-icons/eleutherai.png",
	essentialai: "/provider-icons/essentialai.png",
	google: "/provider-icons/google.svg",
	gryphe: "/provider-icons/gryphe.png",
	huggingface: "/provider-icons/huggingface.svg",
	"ibm-granite": "/provider-icons/ibm-granite.webp",
	inception: "/provider-icons/inception.png",
	inflection: "/provider-icons/inflection.png",
	kwaipilot: "/provider-icons/kwaipilot.png",
	liquid: "/provider-icons/liquid.png",
	mancer: "/provider-icons/mancer.png",
	meituan: "/provider-icons/meituan.png",
	"meta-llama": "/provider-icons/meta-llama.png",
	microsoft: "/provider-icons/microsoft.svg",
	minimax: "/provider-icons/minimax.png",
	mistralai: "/provider-icons/mistralai.png",
	moonshotai: "/provider-icons/moonshotai.png",
	morph: "/provider-icons/morph.png",
	neversleep: "/provider-icons/neversleep.webp",
	"nex-agi": "/provider-icons/nex-agi.png",
	nousresearch: "/provider-icons/nousresearch.png",
	nvidia: "/provider-icons/nvidia.png",
	openai: "/provider-icons/openai.png",
	opengvlab: "/provider-icons/opengvlab.png",
	openrouter: "/provider-icons/openrouter.png",
	perplexity: "/provider-icons/perplexity.svg",
	"prime-intellect": "/provider-icons/prime-intellect.png",
	qwen: "/provider-icons/qwen.png",
	raifle: "/provider-icons/raifle.png",
	relace: "/provider-icons/relace.png",
	sao10k: "/provider-icons/sao10k.png",
	"stepfun-ai": "/provider-icons/stepfun-ai.png",
	switchpoint: "/provider-icons/switchpoint.png",
	tencent: "/provider-icons/tencent.png",
	thedrummer: "/provider-icons/thedrummer.png",
	thudm: "/provider-icons/thudm.webp",
	tngtech: "/provider-icons/tngtech.png",
	undi95: "/provider-icons/undi95.png",
	"x-ai": "/provider-icons/x-ai.png",
	xiaomi: "/provider-icons/xiaomi.webp",
	"z-ai": "/provider-icons/z-ai.png",
};

const PROVIDER_NAME_ALIASES: Record<string, string> = {
	gemini: "google",
	gemma: "google",
	gpt: "openai",
	llama: "meta-llama",
	meta: "meta-llama",
	mistral: "mistralai",
	phi: "microsoft",
	qwq: "qwen",
	xai: "x-ai",
};

function findExactProviderKey(normalized: string): string | null {
	return PROVIDER_ICONS[normalized] ? normalized : null;
}

function findAliasProviderKey(normalized: string): string | null {
	const alias = PROVIDER_NAME_ALIASES[normalized];
	return alias && PROVIDER_ICONS[alias] ? alias : null;
}

const FUZZY_MATCH_PREDICATES: Array<(key: string, normalized: string) => boolean> = [
	(key, normalized) => key.startsWith(normalized),
	(key, normalized) => normalized.startsWith(key),
	(key, normalized) => key.includes(normalized),
	(key, normalized) => normalized.includes(key),
];

function findFuzzyProviderKey(normalized: string): string | null {
	for (const key of Object.keys(PROVIDER_ICONS)) {
		if (FUZZY_MATCH_PREDICATES.some((p) => p(key, normalized))) {
			return key;
		}
	}
	return null;
}

const PROVIDER_NAME_RESOLVERS: Array<(normalized: string) => string | null> = [
	findExactProviderKey,
	findAliasProviderKey,
	findFuzzyProviderKey,
];

/**
 * Reduce an LLM model id to a maker token the icon table can match.
 * - OpenRouter pins (`model::provider`) → drop the `::provider` suffix.
 * - OpenRouter ids (`vendor/model`) → the `vendor` segment.
 * - Ollama ids (`qwen2.5:7b`) → the family before the `:tag`.
 * Fuzzy matching in {@link getProviderIcon} then maps e.g. `qwen2.5` → `qwen`.
 */
export function makerFromModelId(model: string): string {
	const withoutPin = model.split("::")[0] ?? model;
	const vendor = withoutPin.includes("/") ? withoutPin.split("/")[0] : withoutPin;
	return (vendor ?? withoutPin).split(":")[0]?.trim() ?? "";
}

function getProviderIcon(provider: string | null | undefined): string | null {
	if (!provider) {
		return null;
	}
	const normalized = provider.toLowerCase().trim();
	if (!normalized) {
		return null;
	}
	for (const resolver of PROVIDER_NAME_RESOLVERS) {
		const match = resolver(normalized);
		if (match) {
			return PROVIDER_ICONS[match] ?? null;
		}
	}
	return null;
}

/**
 * Resolve a maker token (or raw model id, via {@link makerFromModelId}) to a
 * renderer-root-relative logo URL, or `null` when no logo is bundled for that
 * maker — callers render a neutral fallback glyph instead.
 */
export function resolveProviderIcon(provider: string | null | undefined): string | null {
	const path = getProviderIcon(provider);
	return path ? publicAsset(path) : null;
}
