import type { ModelInfo } from "../model/catalog-store";

export interface ModelNativeFormatting {
	basicPunctuationCasing: boolean;
	fillerRepeatCleanup: boolean;
	spokenCommands: boolean;
}

export type ModelNativeFormattingKey = keyof ModelNativeFormatting;

const NO_NATIVE_FORMATTING = {
	basicPunctuationCasing: false,
	fillerRepeatCleanup: false,
	spokenCommands: false,
} as const satisfies ModelNativeFormatting;

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

/**
 * Formatting coverage provided by the selected STT model itself. Most native
 * dictation models cover only written-text punctuation/casing; deterministic
 * command conversion and filler/repeat cleanup remain WinSTT-owned unless a
 * model is explicitly known to cover those promises too.
 */
export function getModelNativeFormatting(
	model: ModelInfo | undefined,
): ModelNativeFormatting {
	return {
		...NO_NATIVE_FORMATTING,
		basicPunctuationCasing: modelHasNativeBasicFormatting(model),
	};
}
