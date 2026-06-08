import { create } from "zustand";
import {
	fetchOpenRouterSttModels,
	type OpenRouterSttModel,
} from "@/shared/api/ipc-client";

/**
 * Dynamic catalog of OpenRouter transcription models
 * (`output_modalities=transcription`) for the cloud STT picker. Unlike the
 * curated OpenAI/ElevenLabs `CLOUD_CATALOG`, OpenRouter rows are fetched from
 * the live model catalog; `force` refetches them.
 */
interface OpenRouterSttCatalogState {
	error: string | null;
	isLoaded: boolean;
	isReachable: boolean;
	isScanning: boolean;
	models: OpenRouterSttModel[];
	scanModels: (force?: boolean) => Promise<void>;
}

function makeScanErrorState(err: unknown) {
	return {
		error: String(err),
		isReachable: false as const,
		isScanning: false as const,
		isLoaded: true as const,
	};
}

function makeScanSuccessState(result: {
	models: OpenRouterSttModel[];
	reachable: boolean;
	error?: string;
}) {
	return {
		models: result.models.map((model) => ({
			...model,
			accuracy_score:
				typeof model.accuracy_score === "number" ? model.accuracy_score : 0.5,
			speed_score:
				typeof model.speed_score === "number" ? model.speed_score : 0.5,
		})),
		isReachable: result.reachable,
		error: result.error ?? null,
		isLoaded: true as const,
		isScanning: false as const,
	};
}

export const useOpenRouterSttCatalogStore = create<OpenRouterSttCatalogState>()(
	(set, get) => ({
		models: [],
		isLoaded: false,
		isScanning: false,
		isReachable: false,
		error: null,
		scanModels: async (force = false) => {
			// Opening the combobox calls this with no args; `force` (e.g. right
			// after the API key is saved) refreshes the live provider list.
			if (get().isScanning || (!force && get().isLoaded)) {
				return;
			}
			set({ isScanning: true, error: null });
			try {
				const result = await fetchOpenRouterSttModels();
				set(makeScanSuccessState(result));
			} catch (err) {
				set(makeScanErrorState(err));
			}
		},
	}),
);
