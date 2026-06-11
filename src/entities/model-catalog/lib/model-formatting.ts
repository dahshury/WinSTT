import type { ModelInfo } from "../model/catalog-store";

/**
 * Native STT formatting means the decoder itself emits normal written text:
 * sentence casing plus punctuation marks. This does not include explicit
 * dictated commands like "dash dash", "quote ... unquote", or URL separators.
 */
export function modelHasNativeBasicFormatting(
	model: ModelInfo | undefined,
): boolean {
	if (!model) {
		return false;
	}
	if (
		model.family === "whisper" ||
		model.family === "lite-whisper" ||
		model.family === "cohere" ||
		model.family === "granite"
	) {
		return true;
	}
	return model.family === "nemo" && model.id.toLowerCase().includes("canary");
}
