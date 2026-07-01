import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { providerOf } from "@/entities/cloud-stt-provider";
import { useConnectionStore, useGpuInfo } from "@/entities/connection";
import {
	isSelectableRealtimeModel,
	useCatalogStore,
	useModelStateStore,
	useModelSwapStore,
} from "@/entities/model-catalog";
import { useSettingsStore } from "@/entities/setting";
import {
	assessDictationFitClient,
	useSystemResourcesStore,
} from "@/entities/system-resources";
import { useConnectionListener } from "@/features/connect-server";
import {
	isQuantDownloading,
	useDownloadListener,
} from "@/features/model-download";
import { useModelSwapController } from "@/features/swap-model";
import { useSyncSettings } from "@/features/update-settings";
import { fileQueueGetActive, onFileQueueActive } from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";
import { useEscapeToClose } from "@/shared/lib/window-effects";
import {
	close,
	type GetFitAssessment,
	isPrimaryInlineModelList,
	localModelIdOrNull,
	quantForFit,
	requestedDeviceForFit,
} from "../lib/picker-helpers";
import { usePanelRect } from "../model/usePanelRect";
import { usePickerActions } from "../model/usePickerActions";
import { PickerBody } from "./PickerBody";
import { PickerDialogs } from "./PickerDialogs";

function pickerBodyKey(
	mode: ReturnType<typeof usePanelRect>["mode"],
	effectiveSourceIsCloud: boolean,
): string {
	if (mode.kind === "stt") {
		return effectiveSourceIsCloud ? "cloud" : "local";
	}
	if (
		mode.kind === "stt-realtime" ||
		mode.kind === "stt-cloud" ||
		mode.kind === "tts"
	) {
		return mode.kind;
	}
	return `${mode.kind}:${mode.feature}:${"target" in mode ? mode.target : ""}`;
}

export function ModelPickerWindow() {
	useSyncSettings();
	useConnectionListener();
	useDownloadListener();

	useGpuInfo();

	const modelSettings = useSettingsStore((s) => s.settings.model);
	const currentModel = modelSettings?.model;
	const update = useSettingsStore((s) => s.updateModelSettings);
	const integrations = useSettingsStore((s) => s.settings.integrations);
	const openrouterKey = useSettingsStore(
		(s) => s.settings.llm.openrouterApiKey,
	);
	const hasAnyCloudKey =
		integrations.elevenlabs.apiKey.trim().length > 0 ||
		openrouterKey.trim().length > 0;
	const effectiveSourceIsCloud =
		providerOf(currentModel ?? "") !== null && hasAnyCloudKey;
	const gpuInfo = useConnectionStore((s) => s.gpuInfo);
	const tModel = useTranslations("model");

	const catalogModels = useCatalogStore((s) => s.models);
	const catalogLoaded = useCatalogStore((s) => s.isLoaded);
	const getModel = useCatalogStore((s) => s.getModel);
	const statesById = useModelStateStore((s) => s.statesById);
	const systemInfo = useModelStateStore((s) => s.systemInfo);
	const refreshModelState = useModelStateStore((s) => s.refresh);
	const liveResources = useSystemResourcesStore((s) => s.liveResources);
	const refreshLive = useSystemResourcesStore((s) => s.refresh);
	const mainSwapping = useModelSwapStore((s) => s.activeMain !== null);
	const realtimeSwapping = useModelSwapStore((s) => s.activeRealtime !== null);

	useEffect(() => {
		refreshModelState();
		refreshLive();
	}, [refreshModelState, refreshLive]);

	const gpuAvailable = gpuInfo.length > 0;
	const currentQuantization = (modelSettings?.onnxQuantization ??
		"") as OnnxQuantization;
	const deviceValue = gpuAvailable ? (modelSettings?.device ?? "auto") : "cpu";
	const getFitAssessment: GetFitAssessment = (modelId) => {
		if (liveResources === null) {
			return null;
		}
		const mainId = localModelIdOrNull(currentModel);
		const realtimeId = localModelIdOrNull(modelSettings?.realtimeModel);
		return assessDictationFitClient(modelId, {
			candidateQuant: quantForFit(statesById, modelId, currentQuantization),
			live: liveResources,
			loaded: {
				mainId,
				mainQuant: quantForFit(statesById, mainId, currentQuantization),
				realtimeId,
				realtimeQuant: quantForFit(statesById, realtimeId, currentQuantization),
			},
			requestedDevice: requestedDeviceForFit(deviceValue),
			statesById,
		});
	};
	const [fileQueueBusy, setFileQueueBusy] = useState(false);
	useEffect(
		() => onFileQueueActive((data) => setFileQueueBusy(data.active)),
		[],
	);
	useEffect(() => {
		fileQueueGetActive().then(setFileQueueBusy);
	}, []);

	const controller = useModelSwapController(
		modelSettings,
		currentModel ?? "",
		currentQuantization,
		deviceValue,
		getModel,
		statesById,
		update,
		isQuantDownloading,
		() => fileQueueBusy,
	);
	const currentModelIsCloud = providerOf(currentModel ?? "") !== null;
	const currentModelInfo = currentModel ? getModel(currentModel) : undefined;
	const currentModelStreamingKnown =
		currentModel === undefined ||
		currentModelIsCloud ||
		currentModelInfo !== undefined;
	const currentModelCanNativeStream =
		!currentModelIsCloud &&
		currentModelInfo !== undefined &&
		isSelectableRealtimeModel(currentModelInfo);

	const currentRealtimeModel = modelSettings?.realtimeModel ?? "";
	const {
		canDeleteQuant,
		handleDeleteQuant,
		handleDownloadAction,
		handleDownloadSnapshot,
		handleRealtimeDownloadAction,
		selectModel,
		selectRealtimeModel,
	} = usePickerActions({
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
	});

	useEscapeToClose(close, { ignoreLayer: isPrimaryInlineModelList });

	const {
		panelInteractive,
		panelRevealed,
		warmPanel,
		mode,
		shouldMountBody,
		dropdownStateClass,
		openGeneration,
	} = usePanelRect(catalogLoaded);

	return (
		<div
			className="fixed inset-0 overflow-hidden"
			onPointerDown={(e) => {
				if (e.target === e.currentTarget) {
					close();
				}
			}}
		>
			{shouldMountBody && (
				<div
					className={["absolute flex flex-col t-dropdown", dropdownStateClass]
						.filter(Boolean)
						.join(" ")}
					data-origin={warmPanel.origin ?? "bottom-right"}
					style={{
						left: warmPanel.x,
						top: warmPanel.y,
						width: warmPanel.width,
						height: warmPanel.height,
						opacity: panelRevealed ? undefined : 0,
						pointerEvents: panelInteractive ? undefined : "none",
					}}
				>
					<PickerBody
						catalogLoaded={catalogLoaded}
						catalogModels={catalogModels}
						currentModel={currentModel ?? ""}
						currentQuantization={currentQuantization}
						fileQueueBusy={fileQueueBusy}
						getFitAssessment={getFitAssessment}
						hasAnyCloudKey={hasAnyCloudKey}
						key={`${pickerBodyKey(mode, effectiveSourceIsCloud)}:${openGeneration}`}
						canDeleteQuant={canDeleteQuant}
						mode={mode}
						onDeleteQuant={handleDeleteQuant}
						onDownloadAction={handleDownloadAction}
						onDownloadSnapshot={handleDownloadSnapshot}
						onSelect={selectModel}
						realtime={{
							value: currentRealtimeModel,
							onSelect: selectRealtimeModel,
							onDownloadAction: handleRealtimeDownloadAction,
							mainModelInfo: currentModelInfo,
							sourceLanguageSelection: modelSettings,
						}}
						statesById={statesById}
						systemInfo={systemInfo}
					/>
				</div>
			)}
			<PickerDialogs
				controller={controller}
				getModel={getModel}
				statesById={statesById}
				systemInfo={systemInfo}
				tModel={tModel}
			/>
		</div>
	);
}
