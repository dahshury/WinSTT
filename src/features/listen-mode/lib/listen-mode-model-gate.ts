import {
	isSelectableRealtimeModel,
	type ModelInfo,
} from "@/entities/model-catalog";
import type { ModelStateEntry } from "@/shared/api/ipc-client";
import type { AppSettingsOutput } from "@/shared/config/settings-schema";

type ModelSettings = AppSettingsOutput["model"];
type QualitySettings = AppSettingsOutput["quality"];

function isCachedNativeStreamingModel(
	modelId: string | null | undefined,
	models: readonly ModelInfo[],
	statesById: Record<string, ModelStateEntry>,
): boolean {
	if (!modelId) {
		return false;
	}
	const model = models.find((item) => item.id === modelId);
	return (
		model !== undefined &&
		isSelectableRealtimeModel(model) &&
		statesById[modelId]?.cache.state === "cached"
	);
}

export function hasCachedNativeStreamingModel(
	models: readonly ModelInfo[],
	statesById: Record<string, ModelStateEntry>,
): boolean {
	return models.some(
		(model) =>
			isSelectableRealtimeModel(model) &&
			statesById[model.id]?.cache.state === "cached",
	);
}

export function resolveListenStreamingModelId(
	model: ModelSettings | undefined,
	quality: QualitySettings | undefined,
	models: readonly ModelInfo[],
	statesById: Record<string, ModelStateEntry>,
): string | null {
	const mainModel = model?.model;
	const realtimeModel = model?.realtimeModel;
	if (
		quality?.useMainModelForRealtime &&
		isCachedNativeStreamingModel(mainModel, models, statesById)
	) {
		return mainModel ?? null;
	}
	if (isCachedNativeStreamingModel(realtimeModel, models, statesById)) {
		return realtimeModel ?? null;
	}
	if (isCachedNativeStreamingModel(mainModel, models, statesById)) {
		return mainModel ?? null;
	}
	return null;
}
