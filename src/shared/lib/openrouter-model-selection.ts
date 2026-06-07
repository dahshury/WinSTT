/**
 * OpenRouter model-selection encoding/decoding.
 *
 * We persist the user's pick as a single string so it round-trips through the
 * settings store untouched:
 *   - `""`                                → OpenRouter Auto (no model pinned)
 *   - `"openai/gpt-4o"`                   → model id only (let OpenRouter route)
 *   - `"openai/gpt-4o@deepinfra"`         → model id + provider slug for routing
 *
 * The provider slug, when present, is forwarded as `provider.order=[slug]`
 * with `allow_fallbacks: false` in the OpenRouter request.
 */

export interface ParsedModelSelection {
	modelId: string;
	providerSlug?: string;
}

export function parseModelSelection(value: string): ParsedModelSelection {
	// Empty input flows naturally through this code: lastIndexOf("@") === -1
	// returns `{ modelId: "" }`, which is the same as the explicit guard
	// would have produced.
	const atIndex = value.lastIndexOf("@");
	if (atIndex === -1) {
		return { modelId: value };
	}
	const modelId = value.slice(0, atIndex);
	const providerSlug = value.slice(atIndex + 1);
	if (!providerSlug) {
		return { modelId };
	}
	return { modelId, providerSlug };
}

export function createModelSelection(
	modelId: string,
	providerSlug?: string,
): string {
	if (!modelId) {
		return "";
	}
	if (!providerSlug) {
		return modelId;
	}
	return `${modelId}@${providerSlug}`;
}
