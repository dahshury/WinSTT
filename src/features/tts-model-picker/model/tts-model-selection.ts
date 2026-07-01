import { DEFAULT_SETTINGS } from "@/entities/setting";
import type { TtsModelInfo } from "@/entities/tts-catalog";
import {
	SUPERTONIC_TTS_MODEL_ID,
	ttsSpeedRange,
} from "@/shared/config/tts-speed";

// Supertonic ships a fixed style-voice set and its own speech-language axis, so
// switching TO it must seed a valid voice/lang (and clamp the speed into its
// narrower range) rather than carry over the previous model's voice. Mirrors the
// `clampSupertonicSpeed` / defaults in `tts-settings/lib/voice-groups`.
const SUPERTONIC_DEFAULT_VOICE = "M3";
const SUPERTONIC_DEFAULT_LANG = "en";
const SUPERTONIC_SPEED_RANGE = ttsSpeedRange(SUPERTONIC_TTS_MODEL_ID);

function clampSupertonicSpeed(speed: number): number {
	if (!Number.isFinite(speed)) {
		return DEFAULT_SETTINGS.tts.speed;
	}
	return Math.min(
		SUPERTONIC_SPEED_RANGE.max,
		Math.max(SUPERTONIC_SPEED_RANGE.min, speed),
	);
}

export interface TtsModelSelectionPatch {
	model: string;
	voice?: string;
	lang?: string;
	speed?: number;
}

/**
 * Resolve the settings patch for selecting a TTS voice model. Selecting a
 * Supertonic model also resets the voice/lang to its defaults and clamps the
 * speed into its supported range; any other model just changes `model`. Shared by
 * the inline Settings selector (`TtsModelSection`) and the detached model-picker
 * window's TTS mode so both apply identical defaults.
 */
export function resolveTtsModelSelectionPatch(
	nextModel: string,
	models: readonly TtsModelInfo[],
	currentSpeed: number,
): TtsModelSelectionPatch {
	const nextInfo = models.find((candidate) => candidate.id === nextModel);
	if (
		nextInfo?.engine === "supertonic" ||
		nextModel === SUPERTONIC_TTS_MODEL_ID
	) {
		return {
			model: nextModel,
			voice: SUPERTONIC_DEFAULT_VOICE,
			lang: SUPERTONIC_DEFAULT_LANG,
			speed: clampSupertonicSpeed(currentSpeed),
		};
	}
	return { model: nextModel };
}
