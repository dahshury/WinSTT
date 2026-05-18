"use client";

import { SttModelSelector } from "@picker";
import { useTranslations } from "next-intl";
import { useCallback, useEffect } from "react";
import { useConnectionStore } from "@/entities/connection";
import { useCatalogStore, useModelStateStore, useModelSwapStore } from "@/entities/model-catalog";
import { useSettingsStore } from "@/entities/setting";
import { useSystemResourcesStore } from "@/entities/system-resources";
import { useConnectionListener } from "@/features/connect-server";
import { DownloadConfirmationDialog, useDownloadListener } from "@/features/model-download";
import { useModelSwapController } from "@/features/swap-model";
import { useSyncSettings } from "@/features/update-settings";
import { IPC } from "@/shared/api/ipc-channels";
import { gpuGetInfo, ipcSend } from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";
import { ResourceWarningDialog } from "@/shared/ui/resource-warning-dialog";

// Desired footprint reported once to the main process. Main caps the height
// to whatever fits above the chip (never spilling over the screen top), then
// the panel fills the actual OS window via h-screen/w-screen — its internal
// list scrolls when the window ends up shorter than this.
const DESIRED_WIDTH = 600;
const DESIRED_HEIGHT = 560;
const PANEL_HEIGHT = "h-screen";
const PANEL_WIDTH = "w-screen";

function close(): void {
	ipcSend(IPC.MODEL_PICKER_CLOSE);
}

/**
 * Renderer half of the detached model-picker window. Hosts the full STT
 * picker in inline mode, hydrates the stores it needs over IPC (the same
 * subscriptions the main window uses), drives the real swap pipeline, and
 * reports its content size back to the main process so the OS window hugs
 * the panel.
 */
export function ModelPickerWindow() {
	// IPC subscriptions so this window's stores mirror the main window's.
	useSyncSettings();
	useConnectionListener();
	useDownloadListener();

	const setGpuInfo = useConnectionStore((s) => s.setGpuInfo);
	useEffect(() => {
		gpuGetInfo().then((info) => {
			if (info) {
				setGpuInfo(info);
			}
		});
	}, [setGpuInfo]);

	const modelSettings = useSettingsStore((s) => s.settings.model);
	const currentModel = modelSettings?.model;
	const update = useSettingsStore((s) => s.updateModelSettings);
	const gpuInfo = useConnectionStore((s) => s.gpuInfo);
	const tModel = useTranslations("model");

	const catalogModels = useCatalogStore((s) => s.models);
	const catalogLoaded = useCatalogStore((s) => s.isLoaded);
	const getModel = useCatalogStore((s) => s.getModel);
	const statesById = useModelStateStore((s) => s.statesById);
	const systemInfo = useModelStateStore((s) => s.systemInfo);
	const refreshModelState = useModelStateStore((s) => s.refresh);
	const refreshLive = useSystemResourcesStore((s) => s.refresh);
	const mainSwapping = useModelSwapStore((s) => s.activeMain !== null);

	useEffect(() => {
		refreshModelState();
		refreshLive();
	}, [refreshModelState, refreshLive]);

	const gpuAvailable = gpuInfo?.available ?? true;
	const currentQuantization = (modelSettings?.onnxQuantization ?? "") as OnnxQuantization;
	const deviceValue = gpuAvailable ? (modelSettings?.device ?? "auto") : "cpu";
	const controller = useModelSwapController(
		modelSettings,
		currentModel ?? "",
		currentQuantization,
		deviceValue,
		getModel,
		statesById,
		update
	);

	// Close once a swap actually starts (server emitted model_swap_started →
	// activeMain set). Selecting a model that needs a download/resource
	// confirmation keeps the window open so its dialog stays interactive;
	// the swap (and this close) only fire after the user confirms.
	useEffect(() => {
		if (mainSwapping) {
			close();
		}
	}, [mainSwapping]);

	const handleChange = useCallback(
		(modelId: string, quantization?: OnnxQuantization) => {
			controller.handleModelChange(modelId, quantization);
			// Re-selecting the loaded model is a no-op for the controller (no
			// swap, no dialog) — dismiss the window so the click still does
			// something sensible.
			if (modelId === currentModel && quantization === undefined) {
				close();
			}
		},
		[controller, currentModel]
	);

	// Report the desired footprint once. Main clamps it to the room above
	// the chip; a ResizeObserver here would fight that clamp (panel is
	// h-screen → it always equals the window), so this is intentionally a
	// single fixed report, not a measured/observed one.
	useEffect(() => {
		ipcSend(IPC.MODEL_PICKER_RESIZE, { width: DESIRED_WIDTH, height: DESIRED_HEIGHT });
	}, []);

	// Esc dismisses the window. The picker is force-open in inline mode, so
	// Base UI's own open/close events are NOT a reliable dismiss signal
	// (clicking the author rail or a filter also fires them) — only an
	// explicit Escape or an outside-the-window click (electron blur) closes.
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				close();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	return (
		<div className="h-screen w-screen overflow-hidden">
			<SttModelSelector
				currentQuantization={currentQuantization}
				inline
				isLoading={!catalogLoaded}
				kind="main"
				models={catalogModels}
				onChange={handleChange}
				popupHeightClass={PANEL_HEIGHT}
				popupWidthClass={PANEL_WIDTH}
				statesById={statesById}
				systemInfo={systemInfo}
				value={currentModel ?? ""}
			/>
			<DownloadConfirmationDialog
				getModel={getModel}
				onCancel={controller.cancelPendingDownload}
				onConfirm={controller.confirmPendingDownload}
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
				t={(key, vars) => tModel(`resourceWarning.${key}` as Parameters<typeof tModel>[0], vars)}
			/>
		</div>
	);
}
