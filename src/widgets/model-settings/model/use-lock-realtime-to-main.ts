import { useEffect } from "react";
import type { useSettingsStore } from "@/entities/setting";
import type { OnnxQuantization } from "@/shared/config/defaults";

type UpdateQualityFn = ReturnType<typeof useSettingsStore.getState>["updateQualitySettings"];

/**
 * When the active main model is itself small enough to drive the live
 * preview, the dedicated realtime slot has no job — a second small model
 * would just duplicate work without improving quality. Force the realtime
 * slot to mirror the main model and flip the server flag so the realtime
 * worker reuses the already-loaded main transcriber.
 */
export function useLockRealtimeToMain(
	lockRealtimeToMain: boolean,
	selectedModel: string,
	currentRealtimeModel: string | undefined,
	useMainModelFlag: boolean,
	realtimeChange: (modelId: string, quantization?: OnnxQuantization) => void,
	updateQuality: UpdateQualityFn
): void {
	useEffect(() => {
		if (!lockRealtimeToMain) {
			return;
		}
		if (currentRealtimeModel !== selectedModel) {
			realtimeChange(selectedModel);
		}
		if (!useMainModelFlag) {
			updateQuality({ useMainModelForRealtime: true });
		}
	}, [
		lockRealtimeToMain,
		selectedModel,
		currentRealtimeModel,
		useMainModelFlag,
		realtimeChange,
		updateQuality,
	]);
}
