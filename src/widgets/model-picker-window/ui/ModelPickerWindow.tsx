import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { providerOf } from "@/entities/cloud-stt-provider";
import { useConnectionStore } from "@/entities/connection";
import {
	isSelectableRealtimeModel,
	readLastLocalSttModelHistory,
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
	DownloadConfirmationDialog,
	canDeleteSttQuant,
	isQuantDownloading,
	resolveSttDeleteRecovery,
	useDownloadListener,
	useQuantActions,
} from "@/features/model-download";
import { useModelSwapController } from "@/features/swap-model";
import { useSyncSettings } from "@/features/update-settings";
import {
	fileQueueGetActive,
	gpuGetInfo,
	onFileQueueActive,
} from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";
import { useEscapeToClose } from "@/shared/lib/window-effects";
import { ResourceWarningDialog } from "@/shared/ui/resource-warning-dialog";
import {
	close,
	type GetFitAssessment,
	isPrimaryInlineModelList,
	localModelIdOrNull,
	type QuantActions,
	quantForFit,
	requestedDeviceForFit,
} from "../lib/picker-helpers";
import { usePanelRect } from "../model/usePanelRect";
import { PickerBody } from "./PickerBody";

function pickerBodyKey(
	mode: ReturnType<typeof usePanelRect>["mode"],
	effectiveSourceIsCloud: boolean,
): string {
	return mode.kind === "stt"
		? effectiveSourceIsCloud
			? "cloud"
			: "local"
		: `${mode.kind}:${mode.feature}:${"target" in mode ? mode.target : ""}`;
}

export function ModelPickerWindow() {
	useSyncSettings();
	useConnectionListener();
	useDownloadListener();

	const setGpuInfo = useConnectionStore((s) => s.setGpuInfo);
	useEffect(() => {
		gpuGetInfo().then((info) => {
			setGpuInfo(info);
		});
	}, [setGpuInfo]);

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
	const quality = useSettingsStore((s) => s.settings.quality);
	const updateQuality = useSettingsStore((s) => s.updateQualitySettings);

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

	const wasSwappingRef = useRef(mainSwapping);
	useEffect(() => {
		if (mainSwapping && !wasSwappingRef.current) {
			close();
		}
		wasSwappingRef.current = mainSwapping;
	}, [mainSwapping]);

	const { handleDeleteQuant, handleDownloadAction, handleDownloadSnapshot } =
		useQuantActions();
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

	const selectModel = (modelId: string, quantization?: OnnxQuantization) => {
		controller.handleModelChange(modelId, quantization);
		if (modelId === currentModel && quantization === undefined) {
			close();
		}
	};

	useEscapeToClose(close, { ignoreLayer: isPrimaryInlineModelList });

	const {
		panelInteractive,
		panelRevealed,
		warmPanel,
		mode,
		shouldMountBody,
		dropdownStateClass,
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
						key={pickerBodyKey(mode, effectiveSourceIsCloud)}
						canDeleteQuant={canDeleteQuant}
						mode={mode}
						onDeleteQuant={handleGuardedDeleteQuant}
						onDownloadAction={handleDownloadActionGated}
						onDownloadSnapshot={handleDownloadSnapshot}
						onSelect={selectModel}
						statesById={statesById}
						systemInfo={systemInfo}
					/>
				</div>
			)}
			<DownloadConfirmationDialog
				getModel={getModel}
				onCancel={controller.cancelPendingDownload}
				pending={controller.pendingDownload}
				statesById={statesById}
				systemInfo={systemInfo}
			/>
			<ResourceWarningDialog
				assessment={controller.pendingFitWarning?.assessment ?? null}
				cancelLabel={tModel("resourceWarning.cancel")}
				candidateName={controller.pendingFitWarning?.candidateName ?? ""}
				confirmLabel={tModel("resourceWarning.proceedAnyway")}
				kind="dictation"
				onCancel={() => controller.setPendingFitWarning(null)}
				onConfirm={() => {
					const next = controller.pendingFitWarning?.next;
					controller.setPendingFitWarning(null);
					if (next) {
						next();
					}
				}}
				onOpenChange={(open) => {
					if (!open) {
						controller.setPendingFitWarning(null);
					}
				}}
				open={controller.pendingFitWarning !== null}
				t={(key, vars) =>
					tModel(`resourceWarning.${key}` as Parameters<typeof tModel>[0], vars)
				}
			/>
		</div>
	);
}
