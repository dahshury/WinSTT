import { useEffect, useRef } from "react";
import {
	isSelectableRealtimeModel,
	type ModelInfo,
	readLastLocalSttModelHistory,
} from "@/entities/model-catalog";
import { useSettingsStore } from "@/entities/setting";
import {
	canDeleteSttQuant,
	resolveSttDeleteRecovery,
	useQuantActions,
} from "@/features/model-download";
import type { SwapController } from "@/features/swap-model";
import type { OnnxQuantization } from "@/shared/config/defaults";
import {
	type CatalogModels,
	close,
	type QuantActions,
	type StatesById,
} from "../lib/picker-helpers";

type ModelSettings = ReturnType<
	typeof useSettingsStore.getState
>["settings"]["model"];
type GetModel = (id: string) => ModelInfo | undefined;

interface PickerActionsParams {
	catalogModels: CatalogModels;
	controller: SwapController;
	currentModel: string | undefined;
	currentModelCanNativeStream: boolean;
	currentModelStreamingKnown: boolean;
	currentQuantization: OnnxQuantization;
	currentRealtimeModel: string;
	fileQueueBusy: boolean;
	getModel: GetModel;
	mainSwapping: boolean;
	modelSettings: ModelSettings;
	realtimeSwapping: boolean;
	statesById: StatesById;
}

interface PickerActions {
	canDeleteQuant: (modelId: string, quantization: OnnxQuantization) => boolean;
	handleDeleteQuant: (modelId: string, quantization: OnnxQuantization) => void;
	handleDownloadAction: QuantActions["handleDownloadAction"];
	handleDownloadSnapshot: QuantActions["handleDownloadSnapshot"];
	handleRealtimeDownloadAction: QuantActions["handleDownloadAction"];
	selectModel: (modelId: string, quantization?: OnnxQuantization) => void;
	selectRealtimeModel: (
		modelId: string,
		quantization?: OnnxQuantization,
	) => void;
}

/**
 * All of the model-picker window's selection / download / delete handlers plus
 * the two cross-cutting effects (keep the realtime slot in sync with the main
 * model, and close the window once any swap starts). Extracted from
 * `ModelPickerWindow` so the component stays focused on rendering its panel.
 * Behavior is identical to the inlined version.
 */
export function usePickerActions(params: PickerActionsParams): PickerActions {
	const {
		catalogModels,
		controller,
		currentModel,
		currentModelCanNativeStream,
		currentModelStreamingKnown,
		currentQuantization,
		currentRealtimeModel,
		fileQueueBusy,
		getModel,
		mainSwapping,
		modelSettings,
		realtimeSwapping,
		statesById,
		// eslint-disable-next-line react-doctor/no-event-handler -- the effect below reconciles realtime-model settings from the externally-selected currentModel (chosen in the picker UI in another component), so the sync cannot live in a single local event handler.
	} = params;

	const update = useSettingsStore((s) => s.updateModelSettings);
	const quality = useSettingsStore((s) => s.settings.quality);
	const updateQuality = useSettingsStore((s) => s.updateQualitySettings);

	const { handleDeleteQuant, handleDownloadAction, handleDownloadSnapshot } =
		useQuantActions();

	useEffect(() => {
		if (!currentModelStreamingKnown) {
			return;
		}
		if (currentModelCanNativeStream) {
			if (modelSettings?.realtimeModel !== currentModel) {
				update({ realtimeModel: currentModel ?? "" });
			}
			if (!(quality?.useMainModelForRealtime ?? false)) {
				updateQuality({ useMainModelForRealtime: true });
			}
			return;
		}
		if (quality?.useMainModelForRealtime ?? false) {
			updateQuality({ useMainModelForRealtime: false });
		}
	}, [
		currentModel,
		currentModelCanNativeStream,
		currentModelStreamingKnown,
		modelSettings?.realtimeModel,
		quality?.useMainModelForRealtime,
		update,
		updateQuality,
	]);

	// Close the window when ANY swap (main or realtime) starts — the realtime
	// detached picker writes the realtime slot, whose swap only flips
	// `activeRealtime`, so the close trigger must watch both slots.
	const anySwapping = mainSwapping || realtimeSwapping;
	const wasSwappingRef = useRef(anySwapping);
	useEffect(() => {
		if (anySwapping && !wasSwappingRef.current) {
			close();
		}
		wasSwappingRef.current = anySwapping;
	}, [anySwapping]);

	const canDeleteQuant = (modelId: string, quantization: OnnxQuantization) =>
		canDeleteSttQuant(catalogModels, statesById, modelId, quantization);

	const handleGuardedDeleteQuant = (
		modelId: string,
		quantization: OnnxQuantization,
	) => {
		const recovery = resolveSttDeleteRecovery({
			currentMainModel: currentModel ?? "",
			currentQuantization,
			currentRealtimeModel: modelSettings?.realtimeModel,
			mainModelInfo: getModel(currentModel ?? "") ?? undefined,
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
		if (requiresRecovery && fileQueueBusy) {
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
				if (quality?.useMainModelForRealtime ?? false) {
					updateQuality({ useMainModelForRealtime: false });
				}
			} else {
				controller.handleRealtimeModelChange(
					recovery.realtimeTarget.modelId,
					recovery.realtimeTarget.quantization,
				);
				const nextMainId = recovery.mainTarget?.modelId ?? currentModel ?? "";
				const realtimeInfo = getModel(recovery.realtimeTarget.modelId);
				const shouldReuseMain =
					recovery.realtimeTarget.modelId === nextMainId &&
					realtimeInfo !== undefined &&
					isSelectableRealtimeModel(realtimeInfo);
				if (shouldReuseMain !== (quality?.useMainModelForRealtime ?? false)) {
					updateQuality({ useMainModelForRealtime: shouldReuseMain });
				}
			}
		}
		handleDeleteQuant(modelId, quantization);
	};

	const handleDownloadActionGated: QuantActions["handleDownloadAction"] = (
		action,
		modelId,
		quantization,
	) => {
		if (action === "start") {
			controller.promptDownload("main", modelId, quantization);
			return;
		}
		handleDownloadAction(action, modelId, quantization);
	};

	const handleRealtimeDownloadActionGated: QuantActions["handleDownloadAction"] =
		(action, modelId, quantization) => {
			if (action === "start") {
				controller.promptDownload("realtime", modelId, quantization);
				return;
			}
			handleDownloadAction(action, modelId, quantization);
		};

	const selectModel = (modelId: string, quantization?: OnnxQuantization) => {
		controller.handleModelChange(modelId, quantization);
		if (modelId === currentModel && quantization === undefined) {
			close();
		}
	};

	const selectRealtimeModel = (
		modelId: string,
		quantization?: OnnxQuantization,
	) => {
		// Mirrors `handleRealtimePick` in ModelSettingsPanel: ignore picks other
		// than the main model while the main model owns the realtime slot, route the
		// change through the swap controller, and keep `useMainModelForRealtime` in
		// sync. A real swap auto-closes via the swap effect; a no-op re-pick closes
		// here (a download-confirm keeps the window open until the user confirms).
		if (currentModelCanNativeStream && modelId !== currentModel) {
			return;
		}
		controller.handleRealtimeModelChange(modelId, quantization);
		const shouldReuseMain =
			modelId === currentModel && currentModelCanNativeStream;
		if (shouldReuseMain !== (quality?.useMainModelForRealtime ?? false)) {
			updateQuality({ useMainModelForRealtime: shouldReuseMain });
		}
		if (modelId === currentRealtimeModel && quantization === undefined) {
			close();
		}
	};

	return {
		canDeleteQuant,
		handleDeleteQuant: handleGuardedDeleteQuant,
		handleDownloadAction: handleDownloadActionGated,
		handleDownloadSnapshot,
		handleRealtimeDownloadAction: handleRealtimeDownloadActionGated,
		selectModel,
		selectRealtimeModel,
	};
}
