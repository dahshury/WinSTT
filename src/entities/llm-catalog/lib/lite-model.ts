/**
 * Lite-tier detection for local Ollama post-processing models.
 *
 * Models below `LITE_MODEL_MAX_PARAMS_B` effective parameters run the LITE
 * request shape in the backend (see `is_lite_ollama_model` in
 * `src-tauri/src/winstt/llm/ollama_request.rs` — keep the two in sync): a
 * `{text}`-only structured-output schema, a compact system-prompt base, and
 * greedy decoding. That trades the side-channel capabilities the full
 * six-field envelope powers — dictionary auto-learning, learned snippets,
 * suggested modifiers, history tags, privacy markers — for reliable
 * instruction-following on the text itself, which is all a sub-4B model can
 * carry. The UI uses this predicate to disable those capabilities and badge
 * lite models in the picker.
 *
 * The threshold is deliberately `< 4`, not `<= 4`: gemma4:e4b (effective 4B)
 * is the smallest model verified to handle the full envelope.
 */

const LITE_MODEL_MAX_PARAMS_B = 4;

// Param-size token inside a tag's variant part: `2b`, `0.8b`, `135m`, and
// Gemma MatFormer "effective" sizes (`e2b` → 2B). The token must sit between
// `-`/`_` boundaries (or the variant edges) so quant markers like `q8_0`
// never parse as sizes. Mirrors PARAM_FROM_VARIANT_RE in the Rust twin (which
// consumes the trailing boundary — the regex crate lacks lookahead — so this
// lookahead form matches the same names).
const PARAM_FROM_VARIANT_RE = /(?:^|[-_])e?(\d+(?:\.\d+)?)([bmk])(?=$|[-_])/i;

/**
 * Effective parameter count parsed from an Ollama tag name, in billions.
 * `null` when the name carries no param token (bare bases like `gemma4` or
 * alias tags like `phi3:mini`) — such models are treated as full-tier.
 */
export function ollamaEffectiveParamsBillions(model: string): number | null {
	const colonIdx = model.indexOf(":");
	if (colonIdx < 0) {
		return null;
	}
	const variant = model.slice(colonIdx + 1);
	const match = PARAM_FROM_VARIANT_RE.exec(variant);
	if (!(match?.[1] && match[2])) {
		return null;
	}
	const value = Number.parseFloat(match[1]);
	if (!Number.isFinite(value)) {
		return null;
	}
	switch (match[2].toLowerCase()) {
		case "m":
			return value / 1000;
		case "k":
			return value / 1_000_000;
		default:
			return value;
	}
}

/**
 * True when this Ollama model runs the LITE request shape (see module note).
 * Unknown sizes are full-tier so behavior for bare/alias names is unchanged.
 */
export function isLiteOllamaModel(model: string): boolean {
	const params = ollamaEffectiveParamsBillions(model);
	return params !== null && params < LITE_MODEL_MAX_PARAMS_B;
}
