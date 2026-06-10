import type { OpenRouterModel, OpenRouterTtsModel } from "@/shared/api/models";
import { CLOUD_TTS_MODELS } from "../config/cloud-tts-models";
import { ttsModelToOpenrouterPickerModel } from "./openrouter-tts-picker-model";

export type CloudTtsProvider = "elevenlabs" | "openrouter";

/** The shared picker groups models by `maker`; all ElevenLabs engine models sit
 *  under one author rail. Lowercase to match the OpenRouter maker convention
 *  (`hexgrad`, `google`, …). */
const ELEVENLABS_MAKER = "elevenlabs";

/** ElevenLabs model ids are a closed curated set (`eleven_*`, no `/`), disjoint
 *  from every OpenRouter `maker/slug` id — so a picked id alone tells us which
 *  provider owns it without a prefix. */
const ELEVENLABS_MODEL_IDS: ReadonlySet<string> = new Set(
	CLOUD_TTS_MODELS.map((m) => m.id),
);

/**
 * Adapt a curated ElevenLabs engine model into the shared picker's
 * `OpenRouterModel` shape — the ElevenLabs twin of
 * `ttsModelToOpenrouterPickerModel`. ElevenLabs voices are account-wide (NOT
 * per-model) and there's no published speed/quality benchmark, so no
 * `supported_voices` / perf-score fields — just the name + the latency/quality
 * blurb as the description.
 */
function elevenLabsModelToPickerModel(
	model: (typeof CLOUD_TTS_MODELS)[number],
): OpenRouterModel {
	return {
		id: model.id,
		name: model.displayName,
		model_name: model.displayName,
		maker: ELEVENLABS_MAKER,
		provider: ELEVENLABS_MAKER,
		supported_parameters: [],
		...(model.description ? { description: model.description } : {}),
	};
}

/**
 * Build the ONE merged picker model list from whichever cloud providers are
 * available: ElevenLabs engine models + OpenRouter speech models. With a single
 * key only that provider's rows show; with both, both groups appear in the same
 * rich picker (the user picks a model, which implies the provider).
 */
export function buildCloudPickerModels(opts: {
	elevenAvailable: boolean;
	openrouterAvailable: boolean;
	openrouterModels: readonly OpenRouterTtsModel[];
}): OpenRouterModel[] {
	const models: OpenRouterModel[] = [];
	if (opts.elevenAvailable) {
		models.push(...CLOUD_TTS_MODELS.map(elevenLabsModelToPickerModel));
	}
	if (opts.openrouterAvailable) {
		models.push(...opts.openrouterModels.map(ttsModelToOpenrouterPickerModel));
	}
	return models;
}

/** Which provider owns a picked model id (ElevenLabs ids are the closed curated
 *  set; everything else is an OpenRouter `maker/slug`). */
export function providerForModelId(modelId: string): CloudTtsProvider {
	return ELEVENLABS_MODEL_IDS.has(modelId) ? "elevenlabs" : "openrouter";
}

/**
 * Resolve the cloud provider to actually DISPLAY/route — mirrors the backend
 * `effective_cloud_provider`: honour the persisted choice while its provider is
 * available, else fall back to whichever IS available so the UI never strands on
 * an unkeyed provider (the "no ElevenLabs key" bug). Neither available → keep
 * the persisted value.
 */
export function resolveActiveCloudProvider(
	persisted: CloudTtsProvider,
	elevenAvailable: boolean,
	openrouterAvailable: boolean,
): CloudTtsProvider {
	if (persisted === "openrouter" && openrouterAvailable) {
		return "openrouter";
	}
	if (persisted === "elevenlabs" && elevenAvailable) {
		return "elevenlabs";
	}
	if (openrouterAvailable) {
		return "openrouter";
	}
	if (elevenAvailable) {
		return "elevenlabs";
	}
	return persisted;
}
