import { useCallback } from "react";
import {
	isSelectableRealtimeModel,
	readLastLocalSttModelHistory,
	type useCatalogStore,
} from "@/entities/model-catalog";
import { useFileTranscriptionStore } from "@/features/file-transcription";
import {
	canDeleteSttQuant,
	resolveSttDeleteRecovery,
	useQuantActions,
} from "@/features/model-download";
import type { useModelSwapController } from "@/features/swap-model";
import type { OnnxQuantization } from "@/shared/config/defaults";
import type {
	CatalogModels,
	ModelSettings,
	StatesById,
	UpdateQualityFn,
} from "../lib/types";

type CatalogModelInfo = ReturnType<
	ReturnType<typeof useCatalogStore.getState>["getModel"]
>;
type GetModelFn = ReturnType<typeof useCatalogStore.getState>["getModel"];
type SwapController = ReturnType<typeof useModelSwapController>;

interface UseQuantDeletionArgs {
	catalogModels: CatalogModels;
	controller: SwapController;
	currentQuantization: OnnxQuantization;
	getModel: GetModelFn;
	selectedInfo: CatalogModelInfo;
	selectedModel: string;
	settings: ModelSettings;
	statesById: StatesById;
	updateQuality: UpdateQualityFn;
	useMainModelFlag: boolean;
}

interface QuantDeletion {
	canDeleteQuant: (modelId: string, quantization: OnnxQuantization) => boolean;
	handleDownloadSnapshot: ReturnType<
		typeof useQuantActions
	>["handleDownloadSnapshot"];
	handleDownloadAction: ReturnType<
		typeof useQuantActions
	>["handleDownloadAction"];
	handleGuardedDeleteQuant: (
		modelId: string,
		quantization: OnnxQuantization,
	) => void;
}

/**
 * Per-quant badge controls (delete + the shared download snapshot/action
 * handlers). The delete is "guarded": before dropping the bytes it resolves the
 * recovery move for whichever slot referenced the deleted model — switching the
 * main/realtime selection to a safe fallback (and reconciling the
 * use-main-for-realtime flag) so the user is never left pointing at a model
 * whose files just vanished. Extracted verbatim from the panel.
 */
export function useQuantDeletion({
	catalogModels,
	controller,
	currentQuantization,
	getModel,
	selectedInfo,
	selectedModel,
	settings,
	statesById,
	updateQuality,
	useMainModelFlag,
}: UseQuantDeletionArgs): QuantDeletion {
	// Per-quant badge handlers (delete + byte-level pause/resume/cancel) live
	// in one shared feature-layer hook so the settings panel and the detached
	// footer picker wire the exact same controls into SttModelSelector.
	const { handleDeleteQuant, handleDownloadAction, handleDownloadSnapshot } =
		useQuantActions();
	const canDeleteQuant = useCallback(
		(modelId: string, quantization: OnnxQuantization) =>
			canDeleteSttQuant(catalogModels, statesById, modelId, quantization),
		[catalogModels, statesById],
	);
	const handleGuardedDeleteQuant = useCallback(
		(modelId: string, quantization: OnnxQuantization) => {
			const recovery = resolveSttDeleteRecovery({
				currentMainModel: selectedModel,
				currentQuantization,
				currentRealtimeModel: settings?.realtimeModel,
				mainModelInfo: selectedInfo,
				modelId,
				models: catalogModels,
				previousModelIds: readLastLocalSttModelHistory(),
				quantization,
				statesById,
			});
			if (!recovery.canDelete) {
				return;
			}
			const requiresRecovery =
				recovery.mainTarget !== undefined ||
				recovery.realtimeTarget !== undefined;
			if (
				requiresRecovery &&
				useFileTranscriptionStore.getState().queueActive
			) {
				return;
			}
			if (recovery.mainTarget) {
				controller.handleModelChange(
					recovery.mainTarget.modelId,
					recovery.mainTarget.quantization,
				);
			}
			if (recovery.realtimeTarget !== undefined) {
				if (recovery.realtimeTarget === null) {
					controller.handleRealtimeModelChange("");
					if (useMainModelFlag) {
						updateQuality({ useMainModelForRealtime: false });
					}
				} else {
					controller.handleRealtimeModelChange(
						recovery.realtimeTarget.modelId,
						recovery.realtimeTarget.quantization,
					);
					const nextMainId = recovery.mainTarget?.modelId ?? selectedModel;
					const realtimeInfo = getModel(recovery.realtimeTarget.modelId);
					const shouldReuseMain =
						recovery.realtimeTarget.modelId === nextMainId &&
						realtimeInfo !== undefined &&
						isSelectableRealtimeModel(realtimeInfo);
					if (shouldReuseMain !== useMainModelFlag) {
						updateQuality({ useMainModelForRealtime: shouldReuseMain });
					}
				}
			}
			handleDeleteQuant(modelId, quantization);
		},
		[
			catalogModels,
			controller,
			currentQuantization,
			getModel,
			handleDeleteQuant,
			selectedInfo,
			selectedModel,
			settings?.realtimeModel,
			statesById,
			updateQuality,
			useMainModelFlag,
		],
	);
	return {
		canDeleteQuant,
		handleDownloadSnapshot,
		handleDownloadAction,
		handleGuardedDeleteQuant,
	};
}
