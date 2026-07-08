/**
 * Classifies how an Ollama model's "thinking" should be surfaced in the UI.
 *
 * Ollama's `/api/show` reports the same `thinking` capability for THREE
 * behaviourally different kinds of model, so a single Off/Low/Medium/High
 * control mis-serves two of them (verified against `/api/chat`):
 *
 *   - GPT-OSS tunes the reasoning trace by effort LEVEL (Low/Medium/High) but
 *     CANNOT stop reasoning: measured live, `think:false` still produced a
 *     default-length ~2k-char trace (~3.4× slower than "low"). So its control
 *     offers levels WITHOUT an Off, and the backend maps a stored `off` to
 *     `"low"` on the wire.
 *   - Hybrid models (gemma, qwen3, granite, …) only TOGGLE: `think:true` vs
 *     `think:false`. Low/Medium/High are identical on the wire, so showing three
 *     of them is misleading.
 *   - Dedicated reasoning models (deepseek-r1, QwQ, Magistral, any `-thinking` /
 *     `-reasoning` build) ALWAYS emit `<think>`. `think:false` doesn't disable
 *     them — it just stops Ollama parsing the tags, leaking the reasoning into
 *     `content`. So "Off" is a no-op and must not be offered.
 *
 * Source of truth: the CATALOG (`RecommendedOllamaModel.thinking`) — Ollama's
 * API doesn't expose this distinction, so we record what each curated model
 * actually supports there and match by base slug (any tag of `gpt-oss` shares
 * the entry's knowledge). The name-pattern heuristics below are only the
 * fallback for models the catalog doesn't know.
 *
 * The backend mirrors this split: `thinking_flag_for` (ollama_request.rs) sends
 * effort strings only for GPT-OSS, and forces `think:true` for always-on models.
 * Keep the pattern lists in sync with `model_uses_thinking_levels` /
 * `model_is_always_on_reasoning` there.
 */

import { RECOMMENDED_OLLAMA_MODELS } from "./recommended-models";

export type OllamaThinkingMode = "none" | "toggle" | "levels" | "always-on";

function baseSlug(model: string): string {
	const trimmed = model.trim().toLowerCase();
	const colon = trimmed.indexOf(":");
	return colon > 0 ? trimmed.slice(0, colon) : trimmed;
}

/** Catalog-recorded thinking support for the model's base slug (any tag of
 *  `gpt-oss` matches the curated `gpt-oss:20b` entry), or undefined when the
 *  catalog doesn't know this model. */
function catalogThinking(model: string): "levels" | "always-on" | undefined {
	const slug = baseSlug(model);
	return RECOMMENDED_OLLAMA_MODELS.find(
		(m) => m.thinking !== undefined && baseSlug(m.name) === slug,
	)?.thinking;
}

/** GPT-OSS is the one family that tunes reasoning by effort level rather than a
 *  boolean. Mirrors the backend `model_uses_thinking_levels`. */
export function ollamaUsesThinkingLevels(model: string): boolean {
	return model.toLowerCase().includes("gpt-oss");
}

/** Dedicated reasoning models whose template ALWAYS emits `<think>` — they can't
 *  be turned off via `think:false`. Mirrors the backend
 *  `model_is_always_on_reasoning`. */
export function isAlwaysOnReasoningModel(model: string): boolean {
	const m = model.toLowerCase();
	return (
		m.includes("-thinking") ||
		m.includes("-reasoning") ||
		m.includes("deepseek-r1") ||
		m.includes("qwq") ||
		m.includes("magistral")
	);
}

/**
 * Which thinking control (if any) to render for an Ollama model:
 *   - `"none"`      — no `thinking` capability; render nothing.
 *   - `"always-on"` — reasons unconditionally; show a read-only indicator, no Off.
 *   - `"levels"`    — GPT-OSS; Low/Medium/High (no Off — it can't stop reasoning).
 *   - `"toggle"`    — hybrid; only On/Off is meaningful.
 *
 * The catalog's recorded support wins over live capabilities: it exists
 * precisely because Ollama reports the same `thinking` capability for all
 * three behaviours (and reports nothing at all for un-pulled models).
 */
export function ollamaThinkingMode(
	model: string,
	capabilities: readonly string[] | null | undefined,
): OllamaThinkingMode {
	const fromCatalog = catalogThinking(model);
	if (fromCatalog !== undefined) {
		return fromCatalog;
	}
	if (!capabilities?.includes("thinking")) {
		return "none";
	}
	if (isAlwaysOnReasoningModel(model)) {
		return "always-on";
	}
	if (ollamaUsesThinkingLevels(model)) {
		return "levels";
	}
	return "toggle";
}
