import {
	type ComponentProps,
	memo,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
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
	DEFAULT_MODEL_PICKER_MODE,
	type DetachedModelPickerMode,
	desiredSizeForMode,
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
	mode: DetachedModelPickerMode,
	effectiveSourceIsCloud: boolean,
): string {
	if (mode.kind === "stt") {
		return effectiveSourceIsCloud ? "cloud" : "local";
	}
	if (
		mode.kind === "stt-realtime" ||
		mode.kind === "stt-cloud" ||
		mode.kind === "tts" ||
		mode.kind === "output-device"
	) {
		return mode.kind;
	}
	return `${mode.kind}:${mode.feature}:${"target" in mode ? mode.target : ""}`;
}

interface WarmPickerSlot {
	active: boolean;
	generation: number;
	key: string;
	mode: DetachedModelPickerMode;
}

/**
 * The picker bodies kept mounted in this (normally hidden) window. Mounting a
 * body is the bulk of an open's cost (the STT body: ~100–160ms of main-thread
 * work), so two stay warm and switching between them is just a reveal:
 *   - the STT picker — the default and most-opened kind, and the priciest
 *     body to mount — always;
 *   - the most recently opened other kind (LLM, TTS, realtime, cloud, output
 *     device), so reopening the selector the user is working in is warm too.
 * A full close remounts only the body that was open (its `generation` bumps),
 * clearing transient UI like the search query; the standby body is untouched.
 */
function useWarmPickerSlots(
	mode: DetachedModelPickerMode,
	effectiveSourceIsCloud: boolean,
	openGeneration: number,
): WarmPickerSlot[] {
	const activeKey = pickerBodyKey(mode, effectiveSourceIsCloud);
	const [secondary, setSecondary] = useState<DetachedModelPickerMode | null>(
		null,
	);
	if (
		mode.kind !== "stt" &&
		(secondary === null ||
			pickerBodyKey(secondary, effectiveSourceIsCloud) !== activeKey)
	) {
		setSecondary(mode);
	}
	// `openGeneration` bumps once per full close, while `mode` still names the
	// picker that just closed — attribute the bump to that body only.
	const [generations, setGenerations] = useState<{
		byKey: Readonly<Record<string, number>>;
		openGeneration: number;
	}>({ byKey: {}, openGeneration });
	if (generations.openGeneration !== openGeneration) {
		setGenerations({
			byKey: {
				...generations.byKey,
				[activeKey]: (generations.byKey[activeKey] ?? 0) + 1,
			},
			openGeneration,
		});
	}
	const modes: DetachedModelPickerMode[] = [DEFAULT_MODEL_PICKER_MODE];
	const otherMode = mode.kind === "stt" ? secondary : mode;
	if (otherMode !== null) {
		modes.push(otherMode);
	}
	return modes.map((slotMode) => {
		const key = pickerBodyKey(slotMode, effectiveSourceIsCloud);
		const active = key === activeKey;
		return {
			active,
			generation: generations.byKey[key] ?? 0,
			key,
			mode: active ? mode : slotMode,
		};
	});
}

/**
 * A standby body is hidden and inert, so re-rendering it whenever the host
 * does (every anchor and open/close phase change) is pure cost — the STT grid
 * alone costs tens of ms per render. It stays frozen until it becomes the
 * active body again, then re-renders with the latest props. Its own store
 * subscriptions still update it.
 */
const SlotPickerBody = memo(
	function SlotPickerBody({
		active: _active,
		...props
	}: ComponentProps<typeof PickerBody> & { active: boolean }) {
		return <PickerBody {...props} />;
	},
	(prev, next) => !(prev.active || next.active),
);

export function ModelPickerWindow() {
	useSyncSettings();
	useConnectionListener();
	useDownloadListener();

	useGpuInfo();

	const modelSettings = useSettingsStore((s) => s.settings.model);
	const currentModel = modelSettings?.model;
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
		completeCloseTransition,
		openGeneration,
	} = usePanelRect(catalogLoaded);

	const slots = useWarmPickerSlots(
		mode,
		effectiveSourceIsCloud,
		openGeneration,
	);
	const activeKey = pickerBodyKey(mode, effectiveSourceIsCloud);
	const activePanelRef = useRef<HTMLDivElement>(null);
	// The inline picker focuses its search box when it MOUNTS. A warm body that
	// mounted earlier (possibly before the standby body took focus) must be
	// re-focused when it is revealed, or typing would land in the hidden body.
	useLayoutEffect(() => {
		if (!panelRevealed) {
			return;
		}
		activePanelRef.current
			?.querySelector<HTMLInputElement>('[data-slot="model-picker-search"]')
			?.focus({ preventScroll: true });
	}, [activeKey, panelRevealed]);

	const fitAssessmentFor =
		(freesRealtimeSlot: boolean): GetFitAssessment =>
		(modelId) => {
			if (liveResources === null) {
				return null;
			}
			const mainId = localModelIdOrNull(currentModel);
			const realtimeId = localModelIdOrNull(modelSettings?.realtimeModel);
			// The slot this picker edits is unloaded first on swap, so treat its
			// resident model as freed: the realtime picker frees the realtime slot,
			// every other STT picker frees the main dictation slot.
			const replacedId = freesRealtimeSlot ? realtimeId : mainId;
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
				replacedId,
				requestedDevice: requestedDeviceForFit(deviceValue),
				statesById,
			});
		};
	// Body props are built here, not per slot inside the render map below, so
	// the React Compiler memoizes them: a fresh closure or object per render
	// would re-render every model card on every anchor and phase change.
	const getMainFitAssessment = fitAssessmentFor(false);
	const getRealtimeFitAssessment = fitAssessmentFor(true);
	const realtime = {
		value: currentRealtimeModel,
		onSelect: selectRealtimeModel,
		onDownloadAction: handleRealtimeDownloadAction,
		mainModelInfo: currentModelInfo,
		sourceLanguageSelection: modelSettings,
	};

	return (
		<div
			className="fixed inset-0 overflow-hidden"
			onPointerDown={(e) => {
				if (e.target === e.currentTarget) {
					close();
				}
			}}
		>
			{shouldMountBody &&
				slots.map((slot) => {
					const standbySize = desiredSizeForMode(slot.mode);
					// Same element whether active or standby (keyed by body), so a
					// body never remounts when it moves between the two roles.
					return (
						<div
							aria-hidden={slot.active ? undefined : true}
							className={[
								"absolute flex flex-col",
								slot.active && "t-dropdown",
								slot.active && dropdownStateClass,
							]
								.filter(Boolean)
								.join(" ")}
							data-origin={
								slot.active ? (warmPanel.origin ?? "bottom-right") : undefined
							}
							inert={!slot.active}
							key={slot.key}
							onAnimationEnd={(event) => {
								if (
									slot.active &&
									event.target === event.currentTarget &&
									event.animationName === "dropdown-out"
								) {
									completeCloseTransition();
								}
							}}
							ref={slot.active ? activePanelRef : undefined}
							style={
								slot.active
									? {
											left: warmPanel.x,
											top: warmPanel.y,
											width: warmPanel.width,
											height: warmPanel.height,
											opacity: panelRevealed ? undefined : 0,
											pointerEvents: panelInteractive ? undefined : "none",
										}
									: {
											left: 0,
											top: 0,
											width: standbySize.width,
											height: standbySize.height,
											// Skip style/layout/paint for the hidden body while
											// keeping its rendering state, so a reveal is cheap.
											contentVisibility: "hidden",
											visibility: "hidden",
											pointerEvents: "none",
										}
							}
						>
							<SlotPickerBody
								active={slot.active}
								catalogLoaded={catalogLoaded}
								catalogModels={catalogModels}
								currentModel={currentModel ?? ""}
								currentQuantization={currentQuantization}
								fileQueueBusy={fileQueueBusy}
								getFitAssessment={
									slot.mode.kind === "stt-realtime"
										? getRealtimeFitAssessment
										: getMainFitAssessment
								}
								hasAnyCloudKey={hasAnyCloudKey}
								key={slot.generation}
								canDeleteQuant={canDeleteQuant}
								mode={slot.mode}
								onDeleteQuant={handleDeleteQuant}
								onDownloadAction={handleDownloadAction}
								onDownloadSnapshot={handleDownloadSnapshot}
								onSelect={selectModel}
								panelOpen={slot.active && panelRevealed}
								realtime={realtime}
								statesById={statesById}
								systemInfo={systemInfo}
							/>
						</div>
					);
				})}
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
