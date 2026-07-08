import type { OllamaModel, OpenRouterModel } from "@/shared/api/models";
import type { OpenRouterVariant } from "@/shared/api/models";

// Fetch model catalogs directly from the providers (this tool runs outside
// Tauri, so it can't use the app's IPC scan commands) and map the raw responses
// into the exact shapes the reused app selectors consume.

type Json = Record<string, unknown>;

function asRecord(v: unknown): Json {
	return v && typeof v === "object" ? (v as Json) : {};
}
function asString(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function asStringArray(v: unknown): string[] | undefined {
	return Array.isArray(v)
		? v.filter((x): x is string => typeof x === "string")
		: undefined;
}

/** Spread helper: include the key only when the value is defined, so optional
 *  fields stay absent (required under exactOptionalPropertyTypes). */
function defined<K extends string, V>(
	key: K,
	value: V | undefined,
): Record<K, V> | Record<string, never> {
	return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

export async function fetchOllamaCatalog(
	endpoint: string,
): Promise<OllamaModel[]> {
	const res = await fetch(`${endpoint.replace(/\/$/, "")}/api/tags`);
	if (!res.ok) throw new Error(`Ollama /api/tags HTTP ${res.status}`);
	const data = asRecord(await res.json());
	const models = Array.isArray(data["models"]) ? data["models"] : [];
	return models.map((raw): OllamaModel => {
		const m = asRecord(raw);
		const d = asRecord(m["details"]);
		return {
			name: asString(m["name"]) ?? asString(m["model"]) ?? "unknown",
			size: asNumber(m["size"]) ?? null,
			modifiedAt: asString(m["modified_at"]) ?? null,
			capabilities: asStringArray(m["capabilities"]) ?? null,
			contextLength:
				asNumber(m["context_length"]) ?? asNumber(d["context_length"]) ?? null,
			details: {
				format: asString(d["format"]) ?? null,
				family: asString(d["family"]) ?? null,
				families: asStringArray(d["families"]) ?? null,
				parameterSize: asString(d["parameter_size"]) ?? null,
				quantizationLevel: asString(d["quantization_level"]) ?? null,
			},
		};
	});
}

const VARIANTS: readonly OpenRouterVariant[] = [
	"exacto",
	"extended",
	"floor",
	"free",
	"nitro",
	"online",
	"thinking",
];

function variantFromId(id: string): OpenRouterVariant | null {
	const suffix = id.split(":")[1];
	return suffix && (VARIANTS as readonly string[]).includes(suffix)
		? (suffix as OpenRouterVariant)
		: null;
}

/** Map OpenRouter `/api/v1/models` to the picker's `OpenRouterModel`. The app
 *  normally does this in Rust; we replicate the fields the selector renders
 *  (maker derives from the id prefix, variant from a `:suffix`). */
export async function fetchOpenRouterCatalog(
	apiKey: string,
): Promise<OpenRouterModel[]> {
	const res = await fetch("https://openrouter.ai/api/v1/models", {
		headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
	});
	if (!res.ok) throw new Error(`OpenRouter /models HTTP ${res.status}`);
	const data = asRecord(await res.json());
	const models = Array.isArray(data["data"]) ? data["data"] : [];
	return models.map((raw): OpenRouterModel => {
		const m = asRecord(raw);
		const id = asString(m["id"]) ?? "unknown";
		const arch = asRecord(m["architecture"]);
		const pricing = asRecord(m["pricing"]);
		return {
			id,
			name: asString(m["name"]) ?? id,
			...defined("description", asString(m["description"])),
			...defined("context_length", asNumber(m["context_length"])),
			...defined("maker", id.split("/")[0]),
			...defined("model_name", id.split("/")[1]?.split(":")[0]),
			variant: variantFromId(id),
			...defined(
				"supported_parameters",
				asStringArray(m["supported_parameters"]),
			),
			architecture: {
				...defined("modality", asString(arch["modality"])),
				...defined("input_modalities", asStringArray(arch["input_modalities"])),
				...defined(
					"output_modalities",
					asStringArray(arch["output_modalities"]),
				),
				...defined("tokenizer", asString(arch["tokenizer"])),
				...defined("instruct_type", asString(arch["instruct_type"])),
			},
			pricing: {
				...defined("prompt", asString(pricing["prompt"])),
				...defined("completion", asString(pricing["completion"])),
				...defined("request", asString(pricing["request"])),
				...defined("image", asString(pricing["image"])),
			},
		};
	});
}
