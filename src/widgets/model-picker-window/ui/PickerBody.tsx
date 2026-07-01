import {
	computeModelExclusionConfig,
	OllamaModelSelector,
	type OllamaModelSelectorProps,
	OpenRouterModelSelector,
	SttModelSelector,
} from "@/widgets/model-picker";
import { TtsModelSelector } from "@/widgets/model-picker/tts";
import { type KeyboardEvent, type ReactNode, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { providerOf } from "@/entities/cloud-stt-provider";
import {
	assessOllamaFit,
	RECOMMENDED_OLLAMA_MODELS,
	useLlmCatalogStore,
	useOllamaLibraryStore,
	useOpenRouterCatalogStore,
} from "@/entities/llm-catalog";
import {
	isSelectableRealtimeModel,
	isVisibleSttModel,
	type ModelInfo,
	modelsHaveLanguageOverlap,
	modelSupportsSelectedSourceLanguages,
	type SourceLanguageSelection,
} from "@/entities/model-catalog";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import {
	useTtsCatalogStore,
	useTtsModelStateStore,
} from "@/entities/tts-catalog";
import { CloudModelSelect } from "@/features/select-cloud-stt-model";
import {
	resolveTtsModelSelectionPatch,
	useTtsModelDownloads,
} from "@/features/tts-model-picker";
import { ttsDeleteModel } from "@/shared/api/ipc-client";
import type { OllamaPullProgress } from "@/shared/api/models";
import type { OnnxQuantization } from "@/shared/config/defaults";
import { fireAndForget } from "@/shared/lib/fire-and-forget";
import {
	ollamaLlmSelectorUiStorageKey,
	openRouterLlmSelectorUiStorageKey,
} from "@/shared/lib/model-picker-ui-storage-keys";
import {
	type CatalogModels,
	close,
	type DetachedModelPickerMode,
	type GetFitAssessment,
	PANEL_HEIGHT,
	type QuantActions,
	type StatesById,
	type SystemInfo,
} from "../lib/picker-helpers";

/** Realtime-slot wiring, supplied by the host for the `stt-realtime` mode. The
 *  realtime select handler, download gating, main-model context, and source
 *  languages are all owned by `ModelPickerWindow` (same controller the main
 *  picker uses) so the detached realtime picker matches `RealtimeModelSection`. */
interface RealtimePickerBundle {
	value: string;
	onSelect: (modelId: string, quantization?: OnnxQuantization) => void;
	onDownloadAction: QuantActions["handleDownloadAction"];
	mainModelInfo: ModelInfo | undefined;
	sourceLanguageSelection: SourceLanguageSelection | undefined;
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
	mode: DetachedModelPickerMode;
	onDownloadAction: QuantActions["handleDownloadAction"];
	onDownloadSnapshot: QuantActions["handleDownloadSnapshot"];
	onSelect: (modelId: string, quantization?: OnnxQuantization) => void;
	realtime: RealtimePickerBundle;
	statesById: StatesById;
	systemInfo: SystemInfo;
}

type DetachedLlmFeature = Extract<
	DetachedModelPickerMode,
	{ kind: "llm-ollama" }
>["feature"];
type DetachedOllamaMode = Extract<
	DetachedModelPickerMode,
	{ kind: "llm-ollama" }
>;
type DetachedOpenRouterMode = Extract<
	DetachedModelPickerMode,
	{ kind: "llm-openrouter" }
>;

function useFeatureSnapshot(feature: DetachedLlmFeature) {
	return useSettingsStore((s) =>
		feature === "transforms"
			? s.settings.llm.transforms
			: s.settings.llm.dictation,
	);
}

function useFeatureUpdaters() {
	const updateDictation = useSettingsStore((s) => s.updateLlmDictation);
	const updateTransforms = useSettingsStore((s) => s.updateLlmTransforms);
	return { updateDictation, updateTransforms };
}

function useOllamaPulls() {
	const pullsRaw = useLlmCatalogStore((s) => s.pulls);
	const pulls: Record<string, OllamaPullProgress> = {};
	for (const [name, state] of Object.entries(pullsRaw)) {
		pulls[name] = state.progress;
	}
	return pulls;
}

const handleKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
	if (event.key !== "Escape") {
		return;
	}
	event.preventDefault();
	event.stopPropagation();
	close();
};

function DetachedPickerFrame({ children }: { children: ReactNode }) {
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: backdrop only dismisses on a direct click (target===currentTarget); keyboard dismissal is the onKeyDownCapture Escape handler — interactive controls live in {children}
		// biome-ignore lint/a11y/noStaticElementInteractions: backdrop surface, not itself an interaction target; the onClick is a click-outside dismiss, interactive controls live in {children}
		<div
			className="flex h-full min-h-0 flex-col"
			onKeyDownCapture={handleKeyDownCapture}
			onPointerDown={(event) => {
				if (event.target === event.currentTarget) {
					close();
				}
			}}
		>
			{children}
		</div>
	);
}

function useLibrarySearchProps(): OllamaModelSelectorProps["librarySearch"] {
	const libraryState = useOllamaLibraryStore(
		useShallow((s) => ({
			catalog: s.catalog,
			error: s.error,
			isLoaded: s.isLoaded,
			isLoading: s.isLoading,
			tagsByModel: s.tagsByModel,
			loadCatalog: s.loadCatalog,
			fetchTags: s.fetchTags,
		})),
	);
	return {
		catalog: libraryState.catalog,
		error: libraryState.error,
		isLoaded: libraryState.isLoaded,
		isLoading: libraryState.isLoading,
		tagsByModel: libraryState.tagsByModel,
		loadCatalog: () => {
			fireAndForget(libraryState.loadCatalog(), "PickerBody.loadCatalog");
		},
		fetchTags: (model) => {
			fireAndForget(libraryState.fetchTags(model), "PickerBody.fetchTags");
		},
	};
}

function DetachedOllamaPicker({
	mode,
	systemInfo,
}: {
	mode: DetachedOllamaMode;
	systemInfo: SystemInfo;
}) {
	const featureSnapshot = useFeatureSnapshot(mode.feature);
	const { updateDictation, updateTransforms } = useFeatureUpdaters();
	const {
		cancelPull,
		deleteModel,
		discardPausedPull,
		isLoaded,
		isScanning,
		models,
		pausedPulls,
		pullModel,
		resumePull,
		scanModels,
	} = useLlmCatalogStore(
		useShallow((s) => ({
			cancelPull: s.cancelPull,
			deleteModel: s.deleteModel,
			discardPausedPull: s.discardPausedPull,
			isLoaded: s.isLoaded,
			isScanning: s.isScanning,
			models: s.models,
			pausedPulls: s.pausedPulls,
			pullModel: s.pullModel,
			resumePull: s.resumePull,
			scanModels: s.scanModels,
		})),
	);
	const pulls = useOllamaPulls();
	const librarySearch = useLibrarySearchProps();
	useEffect(() => {
		if (!isLoaded) {
			fireAndForget(scanModels(), "PickerBody.scanModels");
		}
	}, [isLoaded, scanModels]);
	const setModel = (modelName: string) => {
		if (mode.feature === "transforms") {
			updateTransforms({ provider: "ollama", model: modelName });
		} else {
			updateDictation({ provider: "ollama", model: modelName });
		}
		close();
	};
	const getFit = (sizeBytes: number) => {
		const fit = assessOllamaFit(sizeBytes, systemInfo);
		return {
			availableBytes: fit.availableBytes,
			fits: fit.fits,
			requiredBytes: fit.requiredBytes,
			shortfall: fit.shortfall,
		};
	};
	return (
		<div className="min-h-0 flex-1 [&>*]:size-full">
			<OllamaModelSelector
				inline
				isLoading={isScanning}
				librarySearch={librarySearch}
				models={models}
				onChange={setModel}
				onDelete={(name) => {
					fireAndForget(deleteModel(name), "PickerBody.deleteModel");
				}}
				onDiscardPull={discardPausedPull}
				onOpen={() => {
					fireAndForget(scanModels(), "PickerBody.scanModels");
				}}
				onPull={(name) => {
					fireAndForget(pullModel(name), "PickerBody.pullModel");
				}}
				onResumePull={(name) => {
					fireAndForget(resumePull(name), "PickerBody.resumePull");
				}}
				onStopPull={(name) => {
					fireAndForget(cancelPull(name), "PickerBody.cancelPull");
				}}
				pausedPulls={pausedPulls}
				popupHeightClass={PANEL_HEIGHT}
				popupWidthClass="w-full max-w-none"
				pulls={pulls}
				recommendedModels={RECOMMENDED_OLLAMA_MODELS}
				swap={null}
				systemFit={getFit}
				uiStorageKey={ollamaLlmSelectorUiStorageKey(mode.feature)}
				value={featureSnapshot.model}
			/>
		</div>
	);
}

function DetachedOpenRouterPicker({ mode }: { mode: DetachedOpenRouterMode }) {
	const featureSnapshot = useFeatureSnapshot(mode.feature);
	const { updateDictation, updateTransforms } = useFeatureUpdaters();
	const openrouterApiKey = useSettingsStore(
		(s) => s.settings.llm.openrouterApiKey,
	);
	const { isLoaded, isScanning, models, warmModels } =
		useOpenRouterCatalogStore(
			useShallow((s) => ({
				isLoaded: s.isLoaded,
				isScanning: s.isScanning,
				models: s.models,
				warmModels: s.warmModels,
			})),
		);
	useEffect(() => {
		if (openrouterApiKey.trim().length > 0 && !isLoaded) {
			fireAndForget(warmModels(), "PickerBody.warmModels");
		}
	}, [isLoaded, openrouterApiKey, warmModels]);
	const value =
		mode.target === "fallback"
			? featureSnapshot.openrouterFallbackModel
			: featureSnapshot.openrouterModel;
	const setModel = (modelName: string) => {
		if (mode.feature === "transforms") {
			updateTransforms(
				mode.target === "fallback"
					? {
							provider: "openrouter",
							openrouterFallbackModel: modelName,
						}
					: { provider: "openrouter", openrouterModel: modelName },
			);
		} else {
			updateDictation(
				mode.target === "fallback"
					? {
							provider: "openrouter",
							openrouterFallbackModel: modelName,
						}
					: { provider: "openrouter", openrouterModel: modelName },
			);
		}
		close();
	};
	return (
		<div className="min-h-0 flex-1 [&>*]:size-full">
			<OpenRouterModelSelector
				disabled={openrouterApiKey.trim().length === 0}
				exclusionConfig={
					mode.target === "fallback"
						? computeModelExclusionConfig(featureSnapshot.openrouterModel)
						: undefined
				}
				inline
				isLoading={isScanning}
				models={[...models]}
				onChange={setModel}
				placeholder={
					mode.target === "fallback"
						? "Select fallback model"
						: "Select a model"
				}
				popupHeightClass={PANEL_HEIGHT}
				popupWidthClass="w-full max-w-none"
				uiStorageKey={openRouterLlmSelectorUiStorageKey(
					mode.feature,
					mode.target,
				)}
				value={value}
			/>
		</div>
	);
}

/** Realtime-slot pre-filter — ports `RealtimeModelSection`'s prefilter so the
 *  detached realtime picker shows the same native-streaming, language-compatible
 *  subset the inline settings picker did. */
function realtimeModelPrefilter(
	mainModelInfo: ModelInfo | undefined,
	sourceLanguageSelection: SourceLanguageSelection | undefined,
): (model: ModelInfo) => boolean {
	return (model) =>
		isSelectableRealtimeModel(model) &&
		(mainModelInfo === undefined
			? modelSupportsSelectedSourceLanguages(
					model,
					sourceLanguageSelection,
					mainModelInfo,
				)
			: modelsHaveLanguageOverlap(mainModelInfo, model) &&
				modelSupportsSelectedSourceLanguages(
					model,
					sourceLanguageSelection,
					mainModelInfo,
				));
}

/** Read-aloud (TTS) voice-model picker hosted in the detached window. Mirrors the
 *  inline `TtsModelSection` selector: selecting a cached/uncached model writes
 *  `settings.tts` (applying Supertonic defaults via the shared helper) and closes
 *  the window; per-quant download/delete reuse the same TTS download wiring. The
 *  TTS catalog + state stores self-hydrate on import (see `tts-catalog-store`). */
function DetachedTtsPicker() {
	const models = useTtsCatalogStore((s) => s.models);
	const isLoaded = useTtsCatalogStore((s) => s.isLoaded);
	const statesById = useTtsModelStateStore((s) => s.statesById);
	const refresh = useTtsModelStateStore((s) => s.refresh);
	const currentModel = useSettingsStore((s) => s.settings.tts?.model ?? "");
	const currentSpeed = useSettingsStore(
		(s) => s.settings.tts?.speed ?? DEFAULT_SETTINGS.tts.speed,
	);
	const updateTts = useSettingsStore((s) => s.updateTtsSettings);
	const currentQuant = statesById[currentModel]?.effectiveQuantization ?? "";
	const { getSnapshot, onDownloadAction } = useTtsModelDownloads();

	// `refresh()` fetches BOTH the catalog model list and the per-model cache
	// state in one round-trip. The detached window doesn't bootstrap the TTS
	// catalog at startup (unlike STT), so populate it when this picker mounts —
	// mirrors `TtsModelPickerHost`'s on-open refresh.
	useEffect(() => {
		refresh();
	}, [refresh]);

	const handleChange = (nextModel: string): void => {
		updateTts(resolveTtsModelSelectionPatch(nextModel, models, currentSpeed));
		close();
	};

	return (
		<DetachedPickerFrame>
			<div className="min-h-0 flex-1 [&>*]:size-full">
				<TtsModelSelector
					currentQuantization={currentQuant}
					inline
					isLoading={!isLoaded}
					models={models}
					onChange={handleChange}
					onDeleteQuant={(modelId, quant) => ttsDeleteModel(modelId, quant)}
					onDownloadAction={onDownloadAction}
					onDownloadSnapshot={getSnapshot}
					popupHeightClass={PANEL_HEIGHT}
					popupWidthClass="w-full max-w-none"
					statesById={statesById}
					value={currentModel}
				/>
			</div>
		</DetachedPickerFrame>
	);
}

/**
 * The picker surface: the local STT grid, or the cloud picker when the active
 * model is a cloud provider's. There is NO Local/Cloud switch here — choosing
 * the source is a Settings-only control (`SourceArea` in ModelSettingsPanel);
 * this window just browses the models for whatever source the persisted model
 * already uses. The host mounts it with `key={effectiveSourceIsCloud}` so a
 * persisted-source flip cleanly re-mounts the right sub-picker.
 */
export function PickerBody({
	catalogLoaded,
	catalogModels,
	currentModel,
	currentQuantization,
	fileQueueBusy,
	getFitAssessment,
	hasAnyCloudKey,
	mode,
	onDeleteQuant,
	canDeleteQuant,
	onDownloadAction,
	onDownloadSnapshot,
	onSelect,
	realtime,
	statesById,
	systemInfo,
}: PickerBodyProps) {
	// Which sub-picker shows is derived purely from the active model — there is
	// NO Local/Cloud switch in this window. The source toggle is a Settings-only
	// control (see `SourceArea` in ModelSettingsPanel); this detached picker just
	// browses the models for whatever source the persisted model already uses.
	// A persisted cloud model whose key was removed falls back to the local list
	// (the key-removal banner explains why), matching the Settings behaviour.
	if (mode.kind === "llm-ollama") {
		return (
			<DetachedPickerFrame>
				<DetachedOllamaPicker mode={mode} systemInfo={systemInfo} />
			</DetachedPickerFrame>
		);
	}
	if (mode.kind === "llm-openrouter") {
		return (
			<DetachedPickerFrame>
				<DetachedOpenRouterPicker mode={mode} />
			</DetachedPickerFrame>
		);
	}
	if (mode.kind === "tts") {
		return <DetachedTtsPicker />;
	}
	if (mode.kind === "stt-realtime") {
		return (
			<DetachedPickerFrame>
				<div className="min-h-0 flex-1 [&>*]:size-full">
					<SttModelSelector
						currentQuantization={currentQuantization}
						disabled={fileQueueBusy}
						getFitAssessment={getFitAssessment}
						inline
						isLoading={!catalogLoaded}
						kind="realtime"
						models={catalogModels}
						onChange={realtime.onSelect}
						canDeleteQuant={canDeleteQuant}
						onDeleteQuant={onDeleteQuant}
						onDownloadAction={realtime.onDownloadAction}
						onDownloadSnapshot={onDownloadSnapshot}
						popupHeightClass={PANEL_HEIGHT}
						popupWidthClass="w-full max-w-none"
						prefilter={realtimeModelPrefilter(
							realtime.mainModelInfo,
							realtime.sourceLanguageSelection,
						)}
						statesById={statesById}
						systemInfo={systemInfo}
						value={realtime.value}
					/>
				</div>
			</DetachedPickerFrame>
		);
	}

	const isCloud = providerOf(currentModel) !== null;
	// `stt-cloud` mode forces the cloud sub-picker (opened from the Settings
	// Local/Cloud toggle); plain `stt` mode derives it from the persisted model so
	// the main trigger / footer chip browse whatever source is already active.
	const showCloud = mode.kind === "stt-cloud" || (isCloud && hasAnyCloudKey);

	return (
		// Bottom-aligned so the short Cloud panel hugs the chip instead of
		// floating at the top of the (chip-height-capped) window. In Cloud mode
		// the empty area above the control is the flex container itself — a
		// completed click on it (not a child) closes the picker, same as the
		// backdrop, without passing the click through to the selector underneath.
		// In Local mode the grid fills via `flex-1`, leaving no gap.
		// biome-ignore lint/a11y/useKeyWithClickEvents: backdrop only dismisses on a direct click (target===currentTarget); Escape dismissal is handled at the window level — interactive controls live in {children}
		// biome-ignore lint/a11y/noStaticElementInteractions: backdrop surface, not itself an interaction target; the onClick is a click-outside dismiss, interactive controls live in {children}
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
					selectedId={isCloud ? currentModel : ""}
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
						popupWidthClass="w-full max-w-none"
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
