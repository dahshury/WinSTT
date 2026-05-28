import { STT_PICKER_WIDTH_PX, SttModelSelector } from "@picker";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { providerOf } from "@/entities/cloud-stt-provider";
import { useConnectionStore } from "@/entities/connection";
import { useCatalogStore, useModelStateStore, useModelSwapStore } from "@/entities/model-catalog";
import { useSettingsStore } from "@/entities/setting";
import { useSystemResourcesStore } from "@/entities/system-resources";
import { useConnectionListener } from "@/features/connect-server";
import {
	DownloadConfirmationDialog,
	useDownloadListener,
	useQuantActions,
} from "@/features/model-download";
import { CloudSttSection } from "@/features/select-cloud-stt-model";
import { useModelSwapController } from "@/features/swap-model";
import { useSyncSettings } from "@/features/update-settings";
import { IPC } from "@/shared/api/ipc-channels";
import { gpuGetInfo, ipcOn, ipcSend } from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";
import { ResourceWarningDialog } from "@/shared/ui/resource-warning-dialog";

// Desired footprint reported once to the main process. Main caps the height
// to whatever fits above the chip (never spilling over the screen top) and
// sends back the exact panel rect; the panel fills that absolutely-positioned
// box (h-full) and scrolls internally if it ends up shorter.
//
// Width comes from the shared `STT_PICKER_WIDTH_PX` constant so this window
// is sized to exactly the same pixel width the settings popup renders at —
// both surfaces always look identical.
const DESIRED_WIDTH = STT_PICKER_WIDTH_PX;
const DESIRED_HEIGHT = 560;
const PANEL_HEIGHT = "h-full";

// Window-local rect (CSS px) for the visible panel inside the full-screen
// backdrop window. Null until the main process reports it.
interface PanelRect {
	height: number;
	width: number;
	x: number;
	y: number;
}

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
	// the swap (and this close) only fire after the user confirms. Fire only
	// on the false→true edge so a remount while a swap is still running
	// doesn't re-send a redundant close.
	const wasSwappingRef = useRef(mainSwapping);
	useEffect(() => {
		if (mainSwapping && !wasSwappingRef.current) {
			close();
		}
		wasSwappingRef.current = mainSwapping;
	}, [mainSwapping]);

	// Same per-quant badge handlers the settings panel wires in — without
	// these props SttModelSelector renders the variants read-only (no
	// delete / download / pause controls). useDownloadListener (above) keeps
	// this window's download store hydrated, and the IPC delete/download sends
	// reach the main process regardless of which window fired them.
	const { handleDeleteQuant, handleDownloadAction, handleDownloadSnapshot } = useQuantActions();

	const selectModel = (modelId: string, quantization?: OnnxQuantization) => {
		controller.handleModelChange(modelId, quantization);
		// Re-selecting the loaded model is a no-op for the controller (no
		// swap, no dialog) — dismiss the window so the click still does
		// something sensible.
		if (modelId === currentModel && quantization === undefined) {
			close();
		}
	};

	// Main reports where to draw the panel inside the full-screen window
	// (recomputed on every open and on resize, so it always reflects the
	// current chip position / clamped height).
	const [panel, setPanel] = useState<PanelRect | null>(null);
	useEffect(() => ipcOn(IPC.MODEL_PICKER_ANCHOR, (rect) => setPanel(rect as PanelRect)), []);

	// Report the desired footprint once. Main clamps it to the room above
	// the chip and sends back the final panel rect via MODEL_PICKER_ANCHOR.
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
		// Full-screen transparent backdrop. A pointer-down that lands on the
		// backdrop itself (anything that isn't the panel — the visualizer, the
		// dictation text, the desktop) closes the picker. The panel is a child
		// so clicks on it never match `target === currentTarget`.
		<div
			className="fixed inset-0 overflow-hidden"
			onPointerDown={(e) => {
				if (e.target === e.currentTarget) {
					close();
				}
			}}
		>
			{panel && (
				<div
					// `[&>:last-child]:size-full` stretches the picker to fill the
					// panel rect, which is already sized to `STT_PICKER_WIDTH_PX`
					// (see `DESIRED_WIDTH` above) so the inline picker ends up at
					// exactly the same pixel width the settings popup uses.
					className="absolute flex flex-col gap-2 [&>:last-child]:size-full"
					style={{
						left: panel.x,
						top: panel.y,
						width: panel.width,
						height: panel.height,
					}}
				>
					<CloudSttSection onSelect={(id) => selectModel(id)} selectedId={currentModel ?? ""} />
					<SttModelSelector
						currentQuantization={currentQuantization}
						inline
						isLoading={!catalogLoaded}
						kind="main"
						models={catalogModels}
						onChange={selectModel}
						onDeleteQuant={handleDeleteQuant}
						onDownloadAction={handleDownloadAction}
						onDownloadSnapshot={handleDownloadSnapshot}
						popupHeightClass={PANEL_HEIGHT}
						statesById={statesById}
						systemInfo={systemInfo}
						value={providerOf(currentModel ?? "") === null ? (currentModel ?? "") : ""}
					/>
				</div>
			)}
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
