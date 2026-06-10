import {
	fetchOpenRouterTtsModels,
	type OpenRouterTtsModel,
} from "@/shared/api/ipc-client";
import { createOpenRouterCatalogStore } from "./create-openrouter-catalog-store";

/**
 * Dynamic catalog of OpenRouter speech (TTS) models
 * (`output_modalities=speech`) for the cloud TTS picker. The model and voice
 * rows come from the live OpenRouter model catalog; `force` refetches them.
 */
export const useOpenRouterTtsCatalogStore =
	createOpenRouterCatalogStore<OpenRouterTtsModel>({
		fetchModels: fetchOpenRouterTtsModels,
		normalizeModels: (models) =>
			models.map((model) => ({
				...model,
				quality_score:
					typeof model.quality_score === "number" ? model.quality_score : 0.5,
				speed_score:
					typeof model.speed_score === "number" ? model.speed_score : 0.5,
				supported_voices: Array.isArray(model.supported_voices)
					? model.supported_voices
					: [],
			})),
	});
