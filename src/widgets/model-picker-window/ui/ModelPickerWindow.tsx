import {
	resolveEffectiveQuant,
	STT_PICKER_WIDTH_PX,
	SttModelSelector,
} from "@picker";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { providerOf } from "@/entities/cloud-stt-provider";
import { useConnectionStore } from "@/entities/connection";
import {
	isSelectableRealtimeModel,
	isVisibleSttModel,
	readLastLocalSttModelHistory,
	useCatalogStore,
	useModelStateStore,
	useModelSwapStore,
} from "@/entities/model-catalog";
import { useSettingsStore } from "@/entities/setting";
import { useSystemResourcesStore } from "@/entities/system-resources";
import { assessDictationFitClient } from "@/entities/system-resources/lib/fit-assessor";
import { useConnectionListener } from "@/features/connect-server";
import {
	DownloadConfirmationDialog,
	canDeleteSttQuant,
	isQuantDownloading,
	resolveSttDeleteRecovery,
	useDownloadListener,
	useQuantActions,
} from "@/features/model-download";
import { CloudModelSelect } from "@/features/select-cloud-stt-model";
import { useModelSwapController } from "@/features/swap-model";
import { useSyncSettings } from "@/features/update-settings";
import { IPC } from "@/shared/api/ipc-channels";
import {
	fileQueueGetActive,
	type FitAssessmentEntry,
	gpuGetInfo,
	ipcOn,
	ipcSend,
	onFileQueueActive,
} from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";
import { useEscapeToClose } from "@/shared/lib/window-effects";
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
// Keep in sync with `MODEL_PICKER_CLOSE_MS` in `src-tauri/.../windows.rs`.
const MODEL_PICKER_CLOSE_MS = 150;

function isPrimaryInlineModelList(element: HTMLElement): boolean {
	return (
		element.getAttribute("role") === "listbox" &&
		element.closest('[data-slot="model-picker-inline"]') !== null
	);
}

// Window-local rect (CSS px) for the visible panel inside the full-screen
// backdrop window. Null until the main process reports it.
interface PanelRect {
	height: number;
	width: number;
	x: number;
	y: number;
}

type PanelPhase = "hidden" | "open" | "closing";

function close(): void {
	ipcSend(IPC.MODEL_PICKER_CLOSE);
}

type CatalogModels = ReturnType<typeof useCatalogStore.getState>["models"];
type StatesById = ReturnType<typeof useModelStateStore.getState>["statesById"];
type SystemInfo = ReturnType<typeof useModelStateStore.getState>["systemInfo"];
type QuantActions = ReturnType<typeof useQuantActions>;
type GetFitAssessment = (modelId: string) => FitAssessmentEntry | null;

function localModelIdOrNull(modelId: string | undefined): string | null {
	if (!modelId || providerOf(modelId) !== null) {
		return null;
	}
	return modelId;
}

function quantForFit(
	statesById: StatesById,
	modelId: string | null,
	currentQuantization: OnnxQuantization,
): string {
	return modelId
		? resolveEffectiveQuant(statesById[modelId], currentQuantization)
		: "";
}

function requestedDeviceForFit(deviceValue: "auto" | "cpu"): string | null {
	return deviceValue === "cpu" ? "cpu" : null;
}

interface PickerBodyProps {
	catalogLoaded: boolean;
	catalogModels: CatalogModels;
	currentModel: string;
	currentQuantization: OnnxQuantization;
	fileQueueBusy: boolean;
	getFitAssessment: GetFitAssessment;
	hasAnyCloudKey: boolean;
	onDeleteQuant: QuantActions["handleDeleteQuant"];
	canDeleteQuant: (modelId: string, quantization: OnnxQuantization) => boolean;
	onDownloadAction: QuantActions["handleDownloadAction"];
	onDownloadSnapshot: QuantActions["handleDownloadSnapshot"];
	onSelect: (modelId: string, quantization?: OnnxQuantization) => void;
	statesById: StatesById;
	systemInfo: SystemInfo;
}

/**
 * The picker surface: the local STT grid, or the cloud picker when the active
 * model is a cloud provider's. There is NO Local/Cloud switch here — choosing
 * the source is a Settings-only control (`SourceArea` in ModelSettingsPanel);
 * this window just browses the models for whatever source the persisted model
 * already uses. The host mounts it with `key={effectiveSourceIsCloud}` so a
 * persisted-source flip cleanly re-mounts the right sub-picker.
 */
function PickerBody({
	catalogLoaded,
	catalogModels,
	currentModel,
	currentQuantization,
	fileQueueBusy,
	getFitAssessment,
	hasAnyCloudKey,
	onDeleteQuant,
	canDeleteQuant,
	onDownloadAction,
	onDownloadSnapshot,
	onSelect,
	statesById,
	systemInfo,
}: PickerBodyProps) {
	// Which sub-picker shows is derived purely from the active model — there is
	// NO Local/Cloud switch in this window. The source toggle is a Settings-only
	// control (see `SourceArea` in ModelSettingsPanel); this detached picker just
	// browses the models for whatever source the persisted model already uses.
	// A persisted cloud model whose key was removed falls back to the local list
	// (the key-removal banner explains why), matching the Settings behaviour.
	const isCloud = providerOf(currentModel) !== null;
	const showCloud = isCloud && hasAnyCloudKey;

	return (
		// Bottom-aligned so the short Cloud panel hugs the chip instead of
		// floating at the top of the (chip-height-capped) window. In Cloud mode
		// the empty area above the control is the flex container itself — a
		// pointer-down on it (not a child) closes the picker, same as the
		// backdrop. In Local mode the grid fills via `flex-1`, leaving no gap.
		<div
			className="flex h-full flex-col justify-end gap-2"
			onPointerDown={(e) => {
				if (e.target === e.currentTarget) {
					close();
				}
			}}
		>
			{showCloud ? (
				// Auto-open: the detached window exists only to show the picker, so a
				// closed combobox would force a pointless second click.
				<CloudModelSelect
					defaultOpen
					onSelect={onSelect}
					selectedId={currentModel}
				/>
			) : (
				<div className="min-h-0 flex-1 [&>*]:size-full">
					<SttModelSelector
						currentQuantization={currentQuantization}
						disabled={fileQueueBusy}
						getFitAssessment={getFitAssessment}
						inline
						isLoading={!catalogLoaded}
						kind="main"
						models={catalogModels}
						onChange={onSelect}
						canDeleteQuant={canDeleteQuant}
						onDeleteQuant={onDeleteQuant}
						onDownloadAction={onDownloadAction}
						onDownloadSnapshot={onDownloadSnapshot}
						popupHeightClass={PANEL_HEIGHT}
						prefilter={isVisibleSttModel}
						statesById={statesById}
						systemInfo={systemInfo}
						value={isCloud ? "" : currentModel}
					/>
				</div>
			)}
		</div>
	);
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
			setGpuInfo(info);
		});
	}, [setGpuInfo]);

	const modelSettings = useSettingsStore((s) => s.settings.model);
	const currentModel = modelSettings?.model;
	const update = useSettingsStore((s) => s.updateModelSettings);
	const integrations = useSettingsStore((s) => s.settings.integrations);
	// Cloud is only reachable with a configured key; a persisted cloud model
	// whose key was removed falls back to the local picker (the key-removal
	// banner already explains why).
	const hasAnyCloudKey =
		integrations.openai.apiKey.trim().length > 0 ||
		integrations.elevenlabs.apiKey.trim().length > 0;
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
	const getFitAssessment = useCallback<GetFitAssessment>(
		(modelId) => {
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
					realtimeQuant: quantForFit(
						statesById,
						realtimeId,
						currentQuantization,
					),
				},
				requestedDevice: requestedDeviceForFit(deviceValue),
				statesById,
			});
		},
		[
			currentModel,
			currentQuantization,
			deviceValue,
			liveResources,
			modelSettings?.realtimeModel,
			statesById,
		],
	);
	// This detached window doesn't mount the global IPC listener, so subscribe
	// directly: disable model switching while the file-transcription queue is
	// busy (the swap would reload the shared transcriber mid-queue). The
	// broadcast is edge-triggered, so also pull the current value on mount —
	// the window is created lazily and may open mid-transcription.
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
		currentModel === undefined || currentModelIsCloud || currentModelInfo !== undefined;
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
					if (
						shouldReuseMain !==
						(quality?.useMainModelForRealtime ?? false)
					) {
						updateQuality({ useMainModelForRealtime: shouldReuseMain });
					}
				}
			}
			handleDeleteQuant(modelId, quantization);
		},
		[
			catalogModels,
			controller,
			currentModel,
			currentQuantization,
			fileQueueBusy,
			getModel,
			handleDeleteQuant,
			modelSettings?.realtimeModel,
			quality?.useMainModelForRealtime,
			statesById,
			updateQuality,
		],
	);

	// A precision-badge "download this variant" click opens the confirmation
	// dialog (size + hardware-fit + Download/Cancel) instead of silently starting
	// a background fetch — Electron parity. Pause / resume / cancel on an already
	// in-flight download still dispatch straight through to the server.
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
	const [panel, setPanelState] = useState<PanelRect | null>(null);
	const [panelPhase, setPanelPhaseState] = useState<PanelPhase>("hidden");
	const panelRef = useRef<PanelRect | null>(null);
	const panelPhaseRef = useRef<PanelPhase>("hidden");
	const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const openGenerationRef = useRef(0);
	const setPanel = useCallback((next: PanelRect | null) => {
		panelRef.current = next;
		setPanelState(next);
	}, []);
	const setPanelPhase = useCallback((next: PanelPhase) => {
		panelPhaseRef.current = next;
		setPanelPhaseState(next);
	}, []);
	const clearCloseTimer = useCallback(() => {
		if (closeTimerRef.current !== null) {
			clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
	}, []);
	useEffect(() => clearCloseTimer, [clearCloseTimer]);
	// A real rect positions + reveals. Legacy/null anchors can still arrive from
	// an older hidden-window close path; ignore them once a fresh open is active
	// so a stale close cannot blank the panel while the backdrop is visible.
	useEffect(
		() =>
			ipcOn(IPC.MODEL_PICKER_ANCHOR, (rect) => {
				if (rect) {
					openGenerationRef.current += 1;
					clearCloseTimer();
					setPanel(rect as PanelRect);
					setPanelPhase("open");
					return;
				}
				if (panelPhaseRef.current === "open") {
					return;
				}
				clearCloseTimer();
				setPanel(null);
				setPanelPhase("hidden");
			}),
		[clearCloseTimer, setPanel, setPanelPhase],
	);
	useEffect(
		() =>
			ipcOn(IPC.MODEL_PICKER_CLOSING, () => {
				if (panelRef.current !== null) {
					const closeGeneration = openGenerationRef.current;
					clearCloseTimer();
					setPanelPhase("closing");
					closeTimerRef.current = setTimeout(() => {
						closeTimerRef.current = null;
						if (
							openGenerationRef.current !== closeGeneration ||
							panelPhaseRef.current !== "closing"
						) {
							return;
						}
						setPanel(null);
						setPanelPhase("hidden");
					}, MODEL_PICKER_CLOSE_MS);
				}
			}),
		[clearCloseTimer, setPanel, setPanelPhase],
	);

	// Report the desired footprint once. Main clamps it to the room above
	// the chip and sends back the final panel rect via MODEL_PICKER_ANCHOR.
	useEffect(() => {
		ipcSend(IPC.MODEL_PICKER_RESIZE, {
			width: DESIRED_WIDTH,
			height: DESIRED_HEIGHT,
		});
	}, []);

	// Esc dismisses the window. The picker is force-open in inline mode, so
	// Base UI's own open/close events are NOT a reliable dismiss signal
	// (clicking the author rail or a filter also fires them) — only an
	// explicit Escape or an outside-the-window click (window blur) closes.
	useEscapeToClose(close, { ignoreLayer: isPrimaryInlineModelList });

	// Pre-warm the (heavy) picker body during the window's idle pre-create
	// rather than on first open. The detached picker window is created hidden +
	// parked off-screen at app startup, but `PickerBody` — a force-open inline
	// combobox that mounts EVERY model card — used to be gated entirely behind
	// `panel`, which the main process only sends on the first open. So the
	// expensive first mount (Base UI's collection build + the full grouped-list
	// layout) landed during the 150ms open fade and the user saw it lag.
	//
	// Mount it as soon as the catalog has hydrated (which happens in the
	// background a beat after launch), laid out at the default footprint and held
	// invisible (`opacity: 0`, `pointer-events: none`) until the real anchor
	// lands. The window stays parked off-screen the whole time, so this warm
	// render is never visible; the first real open then just repositions an
	// already-warm tree (a cheap re-render) instead of mounting the whole picker.
	const panelRevealed = panel !== null;
	const panelInteractive = panelRevealed && panelPhase === "open";
	const warmPanel = panel ?? {
		x: 0,
		y: 0,
		width: DESIRED_WIDTH,
		height: DESIRED_HEIGHT,
	};
	const shouldMountBody = panelRevealed || catalogLoaded;
	const dropdownStateClass =
		panelPhase === "closing" ? "is-closing" : panelRevealed ? "is-open" : "";

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
			{shouldMountBody && (
				<div
					// Sized to `STT_PICKER_WIDTH_PX` (see `DESIRED_WIDTH`) so the inline
					// picker matches the settings popup width. `PickerBody` fills the
					// rect (`h-full`) and routes between the local grid and the cloud
					// combobox via the Local/Cloud switcher.
					//
					// Until the main process reports the real anchor (`panel`), this is
					// the off-screen PRE-WARM mount (see `warmPanel` above): laid out at
					// the default footprint but held invisible + non-interactive so the
					// heavy first render happens during the window's idle pre-create
					// instead of during the open fade.
					className={["absolute flex flex-col t-dropdown", dropdownStateClass]
						.filter(Boolean)
						.join(" ")}
					data-origin="bottom-right"
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
						// Re-mount so `source` re-initialises when the persisted model's
						// source flips (or a key is added/removed) — no derived effect.
						key={effectiveSourceIsCloud ? "cloud" : "local"}
						canDeleteQuant={canDeleteQuant}
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
