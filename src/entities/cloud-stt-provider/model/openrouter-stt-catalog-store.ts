import {
	fetchOpenRouterSttModels,
	type OpenRouterSttModel,
} from "@/shared/api/ipc-client";
import { createOpenRouterCatalogStore } from "@/entities/openrouter-catalog/@x/cloud-stt-provider";

/**
 * Dynamic catalog of OpenRouter transcription models
 * (`output_modalities=transcription`) for the cloud STT picker. Unlike the
 * curated OpenAI/ElevenLabs `CLOUD_CATALOG`, OpenRouter rows are fetched from
 * the live model catalog; `force` refetches them.
 */
export const useOpenRouterSttCatalogStore =
	createOpenRouterCatalogStore<OpenRouterSttModel>({
		fetchModels: fetchOpenRouterSttModels,
		normalizeModels: (models) =>
			models.map((model) => ({
				...model,
				accuracy_score:
					typeof model.accuracy_score === "number" ? model.accuracy_score : 0.5,
				speed_score:
					typeof model.speed_score === "number" ? model.speed_score : 0.5,
			})),
	});
