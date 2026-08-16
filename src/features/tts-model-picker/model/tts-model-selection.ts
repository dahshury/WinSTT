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

/** Canonical first usable voice for each local engine. Keep this aligned with
 * the backend voice catalogs: it is used both when switching models and by the
 * Settings reset button, so neither path can write a voice owned by a different
 * engine (for example Kokoro's `af_heart` into Piper). */
export function defaultVoiceForTtsModel(
	info: TtsModelInfo | undefined,
	modelId = info?.id ?? "",
): string {
	if (info?.voiceDesign) {
		return "";
	}
	switch (info?.engine) {
		case "kokoro":
			return "af_heart";
		case "kitten":
			return "expr-voice-5-m";
		case "piper":
			return "en_US-lessac-medium";
		case "supertonic":
			return SUPERTONIC_DEFAULT_VOICE;
		case "chatterbox":
			return "default";
		case "qwen3tts":
		case "qwen3-tts":
			return "vivian";
		case "orpheus":
			return "tara";
		case "spark":
			return "female";
		case "neutts":
			return "emily-neutral";
		case "omnivoice":
			return "default";
		case "audio8":
			return "default";
		default:
			return modelId === SUPERTONIC_TTS_MODEL_ID
				? SUPERTONIC_DEFAULT_VOICE
				: DEFAULT_SETTINGS.tts.voice;
	}
}

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
	/** Precision to load, mirroring STT's `model.onnxQuantization`. Persisted
	 *  onto `tts.quantization`; the backend rebuilds the engine when it changes
	 *  (only Qwen3-TTS ships a real ladder today). Omitted when the caller has no
	 *  explicit pick — the backend keeps the model's default precision. */
	quantization?: string;
}

/**
 * Resolve the settings patch for selecting a TTS voice model. Selecting a
 * model resets the voice to that engine's usable default. Supertonic also
 * resets its independent language and clamps speed into its supported range. An
 * explicit `quantization` (a precision picked from the model's quant shelf) is
 * threaded onto the patch so the backend can hot-swap the engine's precision.
 * Shared by the inline Settings selector (`TtsModelSection`) and the detached
 * model-picker window's TTS mode so both apply identical defaults.
 */
export function resolveTtsModelSelectionPatch(
	nextModel: string,
	models: readonly TtsModelInfo[],
	currentSpeed: number,
	quantization?: string,
): TtsModelSelectionPatch {
	const nextInfo = models.find((candidate) => candidate.id === nextModel);
	const quantPatch = quantization === undefined ? {} : { quantization };
	const voicePatch =
		nextInfo === undefined && nextModel !== SUPERTONIC_TTS_MODEL_ID
			? {}
			: { voice: defaultVoiceForTtsModel(nextInfo, nextModel) };
	if (
		nextInfo?.engine === "supertonic" ||
		nextModel === SUPERTONIC_TTS_MODEL_ID
	) {
		return {
			model: nextModel,
			...voicePatch,
			lang: SUPERTONIC_DEFAULT_LANG,
			speed: clampSupertonicSpeed(currentSpeed),
			...quantPatch,
		};
	}
	return { model: nextModel, ...voicePatch, ...quantPatch };
}
