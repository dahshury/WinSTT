import { create } from "zustand";
import {
	fetchOpenRouterTtsModels,
	type OpenRouterTtsModel,
} from "@/shared/api/ipc-client";

/**
 * Dynamic catalog of OpenRouter speech (TTS) models
 * (`output_modalities=speech`) for the cloud TTS picker. The model and voice
 * rows come from the live OpenRouter model catalog; `force` refetches them.
 */
interface OpenRouterTtsCatalogState {
	error: string | null;
	isLoaded: boolean;
	isReachable: boolean;
	isScanning: boolean;
	models: OpenRouterTtsModel[];
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
	models: OpenRouterTtsModel[];
	reachable: boolean;
	error?: string;
}) {
	return {
		models: result.models.map((model) => ({
			...model,
			quality_score:
				typeof model.quality_score === "number" ? model.quality_score : 0.5,
			speed_score:
				typeof model.speed_score === "number" ? model.speed_score : 0.5,
			supported_voices: Array.isArray(model.supported_voices)
				? model.supported_voices
				: [],
		})),
		isReachable: result.reachable,
		error: result.error ?? null,
		isLoaded: true as const,
		isScanning: false as const,
	};
}

export const useOpenRouterTtsCatalogStore = create<OpenRouterTtsCatalogState>()(
	(set, get) => ({
		models: [],
		isLoaded: false,
		isScanning: false,
		isReachable: false,
		error: null,
		scanModels: async (force = false) => {
			if (get().isScanning || (!force && get().isLoaded)) {
				return;
			}
			set({ isScanning: true, error: null });
			try {
				const result = await fetchOpenRouterTtsModels();
				set(makeScanSuccessState(result));
			} catch (err) {
				set(makeScanErrorState(err));
			}
		},
	}),
);
