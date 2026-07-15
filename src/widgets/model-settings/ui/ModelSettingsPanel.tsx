import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import {
	CLOUD_PROVIDERS,
	defaultCloudModelId,
	providerOf,
} from "@/entities/cloud-stt-provider";
import { useConnectionStore } from "@/entities/connection";
import {
	isSelectableRealtimeModel,
	recordLastLocalSttModel,
	supportsTranslateToEnglish,
	useCatalogStore,
	useModelStateStore,
} from "@/entities/model-catalog";
import { useSettingsStore } from "@/entities/setting";
import { useSystemResourcesStore } from "@/entities/system-resources";
import { useFileTranscriptionStore } from "@/features/file-transcription";
import { isQuantDownloading } from "@/features/model-download";
import { useSttSuggestions } from "@/features/suggested-models";
import { resolveRealtimeLanguageGuardPatch } from "@/features/realtime-preview-fallback";
import { useModelSwapController } from "@/features/swap-model";
import type { OnnxQuantization } from "@/shared/config/defaults";
import {
	isRealtimeEnabled,
	realtimeMasterTogglePatch,
} from "@/shared/lib/realtime-enabled";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import {
	buildLanguageOptions,
	deriveLanguageCandidates,
	fixedLanguageValue,
	languageAutoDetectEnabled,
	resolveLanguageControlMode,
	translateTargetOptions,
} from "../lib/language-controls";
import {
	buildDeviceOpts,
	isLocalTtsActive,
	resolveModelControlVisibility,
} from "../lib/model-controls";
import type { DeviceValue } from "../lib/types";
import { useDownloadGating } from "../model/use-download-gating";
import { useLockLlmTranslate } from "../model/use-lock-llm-translate";
import { useModelFitAssessment } from "../model/use-model-fit-assessment";
import { useQuantDeletion } from "../model/use-quant-deletion";
import { useStaleModelFallback } from "../model/use-stale-model-fallback";
import { useSwapProgress } from "../model/use-swap-progress";
import { MainModelSection } from "./MainModelSection";
import {
	DeviceSection,
	ModelLifetimeSection,
	SpeakerDiarizationSection,
	SwapDialogs,
} from "./model-settings-sections";
import { RealtimeModelSection } from "./RealtimeModelSection";

// Hardcoded English like the sibling listen-mode tooltip below and the
// language-guard copy in DisplayControls — these operational tooltips aren't
// in the i18n catalog yet.
const REALTIME_LISTEN_TOOLTIP =
	"Listen mode always transcribes with the realtime streaming model, so it can't be turned off here.";
const REALTIME_LANGUAGE_TOOLTIP =
	"The selected realtime model cannot stream the current source language.";

function useModelSettingsPanelRender() {
	const global = useSettingsStore((s) => s.settings.global);
	const updateGlobal = useSettingsStore((s) => s.updateGlobalSettings);
	const settings = useSettingsStore((s) => s.settings.model);
	const update = useSettingsStore((s) => s.updateModelSettings);
	const quality = useSettingsStore((s) => s.settings.quality);
	const updateQuality = useSettingsStore((s) => s.updateQualitySettings);
	const llmTranslateEnabled = useSettingsStore((s) =>
		s.settings.llm.dictation.presets.some((p) => p.key === "translate"),
	);
	const llmDictationEnabled = useSettingsStore(
		(s) => s.settings.llm.dictation.enabled,
	);
	const tts = useSettingsStore((s) => s.settings.tts);
	const elevenlabs = useSettingsStore(
		(s) => s.settings.integrations.elevenlabs,
	);
	const openrouterKey = useSettingsStore(
		(s) => s.settings.llm.openrouterApiKey,
	);
	const recordingMode = useSettingsStore(
		(s) => s.settings.general?.recordingMode ?? "ptt",
	);
	const isListenMode = recordingMode === "listen";
	const listenModeMainModelTooltip =
		"Listen mode uses the streaming realtime model below; the main dictation model is preserved for other recording modes.";
	const showRecordingOverlay = useSettingsStore(
		(s) => s.settings.general?.showRecordingOverlay ?? true,
	);
	const liveTranscriptionDisplay = useSettingsStore(
		(s) => s.settings.general?.liveTranscriptionDisplay ?? "both",
	);
	const wordByWordPasting = useSettingsStore(
		(s) => s.settings.general?.wordByWordPasting ?? false,
	);
	const realtimeEnabled = isRealtimeEnabled({
		showRecordingOverlay,
		liveTranscriptionDisplay,
		llmDictationEnabled,
		wordByWordPasting,
	});
	// Listen mode ALWAYS transcribes through the realtime streaming model, so
	// the section stays usable (and the master switch pinned ON) regardless of
	// the display settings the derived state reads.
	const realtimeSectionActive = realtimeEnabled || isListenMode;
	const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
	const [confirmRealtimeOffOpen, setConfirmRealtimeOffOpen] = useState(false);
	const gpuInfo = useConnectionStore((s) => s.gpuInfo);
	const gpuAvailable = gpuInfo.length > 0;
	const t = useTranslations("model");
	const tCommon = useTranslations("common");
	const deviceOpts = buildDeviceOpts(t);
	const deviceValue: DeviceValue = gpuAvailable
		? (settings?.device ?? "auto")
		: "cpu";

	const catalogModels = useCatalogStore((s) => s.models);
	const catalogLoaded = useCatalogStore((s) => s.isLoaded);
	const getModel = useCatalogStore((s) => s.getModel);

	const statesById = useModelStateStore((s) => s.statesById);
	const modelStatesLoaded = useModelStateStore((s) => s.isLoaded);
	const systemInfo = useModelStateStore((s) => s.systemInfo);
	const refreshModelState = useModelStateStore((s) => s.refresh);
	const {
		mainDownloadProgress,
		realtimeDownloadProgress,
		mainSwapping,
		realtimeSwapping,
	} = useSwapProgress();

	const refreshLive = useSystemResourcesStore((s) => s.refresh);

	// Gate the stale-model fallback on THIS mount's fresh model-state refresh. The global
	// `useModelStateStore.isLoaded` latches to `true` on the first success anywhere (footer chip,
	// detached picker, an earlier probe) and never resets, so a warm mount can hand the fallback a
	// STALE `statesById` snapshot — one taken before the selected model finished downloading, or a
	// transient HF-cache-probe miss — that momentarily reports the (actually-cached) selection as
	// not-cached. On that stale read the fallback silently switched the persisted selection to the
	// smallest cached model (= the first list item, vosk russian). Waiting for the mount refresh to
	// resolve means the fallback only ever decides on freshly-read cache state, closing the race
	// WITHOUT changing its deliberate behavior (empty/removed-id repair, deprecated-variant
	// migration, cloud fallback). Display still shows a model immediately — this only gates the
	// selection-mutating effect, not the rendered value.
	const [statesFreshSinceMount, setStatesFreshSinceMount] = useState(false);
	useEffect(() => {
		let cancelled = false;
		void refreshModelState().then(() => {
			if (!cancelled) {
				setStatesFreshSinceMount(true);
			}
		});
		refreshLive();
		return () => {
			cancelled = true;
		};
	}, [refreshModelState, refreshLive]);

	// Mirrors AppearanceSettingsPanel: when no cached realtime path can serve
	// the selected source languages, enabling realtime would be instantly
	// reverted by the language guard — disable the master switch instead of
	// letting it fight the guard.
	const realtimeLanguageUnavailable =
		resolveRealtimeLanguageGuardPatch({
			catalogLoaded,
			catalogModels,
			currentMainModel: settings?.model,
			currentRealtimeModel: settings?.realtimeModel,
			liveTranscriptionDisplay: "both",
			realtimeEnabled: true,
			sourceLanguageSelection: settings,
			statesById,
			statesLoaded: modelStatesLoaded,
			wordByWordPasting: false,
		}) !== null;
	const realtimeToggleDisabled = isListenMode || realtimeLanguageUnavailable;
	const realtimeToggleDisabledTooltip = isListenMode
		? REALTIME_LISTEN_TOOLTIP
		: realtimeLanguageUnavailable
			? REALTIME_LANGUAGE_TOOLTIP
			: undefined;
	const handleRealtimeMasterToggle = (next: boolean): void => {
		if (!next && wordByWordPasting) {
			// Turning realtime off also turns off word-by-word pasting (it is a
			// realtime consumer) — confirm before silently changing paste behavior.
			setConfirmRealtimeOffOpen(true);
			return;
		}
		updateGeneral(realtimeMasterTogglePatch(next));
	};
	const confirmRealtimeOff = (): void => {
		updateGeneral(realtimeMasterTogglePatch(false));
		setConfirmRealtimeOffOpen(false);
	};

	const selectedModel = settings?.model ?? "tiny";
	const selectedIsCloud = providerOf(selectedModel) !== null;
	const selectedInfo = selectedIsCloud ? undefined : getModel(selectedModel);
	const supportedLanguages = selectedInfo?.languages;
	const langOpts = buildLanguageOptions(supportedLanguages);
	const languageCandidates = deriveLanguageCandidates(settings, langOpts);
	const languageControlMode = resolveLanguageControlMode(
		selectedInfo,
		selectedIsCloud,
	);
	const keyedCloudProvider = CLOUD_PROVIDERS.find((provider) =>
		provider === "openrouter"
			? openrouterKey.trim().length > 0
			: elevenlabs.apiKey.trim().length > 0,
	);
	const cloudFallbackModel = keyedCloudProvider
		? defaultCloudModelId(keyedCloudProvider)
		: null;
	const languageAutoDetect = languageAutoDetectEnabled(settings);
	useStaleModelFallback(
		catalogLoaded,
		catalogModels,
		statesById,
		modelStatesLoaded && statesFreshSinceMount,
		settings?.model,
		settings?.realtimeModel,
		settings,
		cloudFallbackModel,
	);
	const languageAutoDetectSupported =
		languageControlMode === "auto" || languageControlMode === "candidate-auto";
	const effectiveLanguageAutoDetect =
		languageAutoDetectSupported && languageAutoDetect;
	useEffect(() => {
		if (!selectedIsCloud) {
			recordLastLocalSttModel(selectedModel);
		}
		// react-doctor-disable-next-line react-doctor/exhaustive-deps -- `selectedModel`/`selectedIsCloud` are synchronous derivations of `settings.model` that recompute every render; react-doctor unwraps them to the raw store field, but the derived deps already track it 1:1, so there is no staleness.
	}, [selectedIsCloud, selectedModel]);
	// Target languages the active model can natively translate INTO, minus the
	// selected source (translating a language into itself is a no-op). Empty when
	// the model can't translate, is cloud, or the only target equals the source
	// (e.g. English-source Whisper) — which is exactly when the picker should hide.
	const translateTargetOpts =
		!selectedIsCloud &&
		selectedInfo !== undefined &&
		supportsTranslateToEnglish(selectedInfo)
			? translateTargetOptions(
					selectedInfo,
					effectiveLanguageAutoDetect ? [] : languageCandidates,
				)
			: [];
	const translateSupported = translateTargetOpts.length > 0;
	useLockLlmTranslate(
		translateSupported && (settings?.translateTargetLanguage ?? "") !== "",
		llmTranslateEnabled,
	);
	const currentQuantization = (settings?.onnxQuantization ??
		"") as OnnxQuantization;
	const getFitAssessment = useModelFitAssessment({
		currentQuantization,
		deviceValue,
		realtimeEnabled,
		selectedIsCloud,
		selectedModel,
		settings,
		statesById,
	});
	// Suggested (spec-based recommender) verdicts for the STT pickers hosted
	// here — same threading pattern as `getFitAssessment`. `undefined` until
	// system info arrives, which keeps the pickers' Suggested filter inert.
	const getSuggestion = useSttSuggestions({
		models: catalogModels,
		statesById,
		sourceLanguageSelection: settings,
		mainModel: selectedInfo,
	});

	const { showDevice, showLanguage, showLifetime } =
		resolveModelControlVisibility(
			selectedIsCloud,
			languageControlMode,
			isLocalTtsActive(tts, elevenlabs),
		);

	useEffect(() => {
		if (!showLanguage) {
			return;
		}
		const rawCandidates = settings?.languageCandidates ?? [];
		if (languageControlMode === "single") {
			if (!languageAutoDetect && rawCandidates.length === 0) {
				return;
			}
			update({
				autoDetectLanguage: false,
				language: fixedLanguageValue(settings, languageCandidates, langOpts),
				languageCandidates: [],
			});
			return;
		}
		if (languageControlMode === "auto") {
			if (rawCandidates.length === 0) {
				return;
			}
			update({ languageCandidates: [] });
		}
	}, [
		langOpts,
		languageAutoDetect,
		languageCandidates,
		languageControlMode,
		settings,
		showLanguage,
		update,
	]);

	const controller = useModelSwapController(
		settings,
		selectedModel,
		currentQuantization,
		deviceValue,
		getModel,
		statesById,
		isQuantDownloading,
		() => useFileTranscriptionStore.getState().queueActive,
	);

	const useMainModelFlag = quality?.useMainModelForRealtime ?? false;
	const mainModelStreamingKnown = selectedIsCloud || selectedInfo !== undefined;
	const mainModelCanNativeStream =
		!selectedIsCloud &&
		selectedInfo !== undefined &&
		isSelectableRealtimeModel(selectedInfo);
	// A native-streaming main model normally OWNS the realtime slot (auto-reuse):
	// the realtime picker is frozen and pinned to the main model. In listen mode
	// that lock is wrong — the main picker is frozen (listen preserves the main
	// dictation model) and the realtime slot is the ONLY control for the listen
	// streaming model, so it must unlock so the user can diverge it from main.
	const realtimeSlotLockedToMain = mainModelCanNativeStream && !isListenMode;
	const selectedRealtimeInfo = settings?.realtimeModel
		? getModel(settings.realtimeModel)
		: undefined;
	const effectiveRealtimeInfo = mainModelCanNativeStream
		? selectedInfo
		: selectedRealtimeInfo;
	const updateIntervalApplies =
		isListenMode || effectiveRealtimeInfo?.nativeStreaming !== true;
	const handleRealtimePick = (v: string, quantization?: OnnxQuantization) => {
		if (realtimeSlotLockedToMain && v !== selectedModel) {
			return;
		}
		controller.handleRealtimeModelChange(v, quantization);
		// Picking the main model (only possible while it can native-stream) reuses
		// it; any other pick — reachable in listen mode — is a separate realtime
		// model, so the reuse flag must clear.
		const shouldReuseMain = v === selectedModel && mainModelCanNativeStream;
		if (shouldReuseMain !== useMainModelFlag) {
			updateQuality({ useMainModelForRealtime: shouldReuseMain });
		}
	};

	useEffect(() => {
		if (!mainModelStreamingKnown) {
			return;
		}
		// Only auto-reuse (and pin the realtime slot to the main model) while the
		// slot is actually locked — i.e. NOT in listen mode, where the realtime
		// slot is independently editable and must not be snapped back to main.
		if (realtimeSlotLockedToMain) {
			if (settings?.realtimeModel !== selectedModel) {
				update({ realtimeModel: selectedModel });
			}
			if (!useMainModelFlag) {
				updateQuality({ useMainModelForRealtime: true });
			}
			return;
		}
		// The main model can't back the realtime slot (cloud / non-streaming), so a
		// stale reuse flag must clear. In listen mode the slot is unlocked but the
		// main model may still be streaming-capable — leave the flag alone there so
		// the user's separate-vs-reuse choice for listen survives.
		if (!mainModelCanNativeStream && useMainModelFlag) {
			updateQuality({ useMainModelForRealtime: false });
		}
		// react-doctor-disable-next-line react-doctor/exhaustive-deps -- `selectedModel` and `useMainModelFlag` are synchronous derivations of `settings.model` and `quality.useMainModelForRealtime`; react-doctor unwraps them to the raw store fields, but the derived deps recompute every render and track those fields 1:1, so there is no staleness.
	}, [
		mainModelCanNativeStream,
		realtimeSlotLockedToMain,
		mainModelStreamingKnown,
		selectedModel,
		settings?.realtimeModel,
		update,
		updateQuality,
		useMainModelFlag,
	]);

	const {
		canDeleteQuant,
		handleDownloadAction,
		handleDownloadSnapshot,
		handleGuardedDeleteQuant,
	} = useQuantDeletion({
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
	});

	const { handleMainDownloadAction, handleRealtimeDownloadAction } =
		useDownloadGating({ controller, handleDownloadAction });

	return (
		<div className="flex flex-col">
			<MainModelSection
				catalogLoaded={catalogLoaded}
				catalogModels={catalogModels}
				currentQuantization={currentQuantization}
				disabled={isListenMode}
				disabledTooltip={isListenMode ? listenModeMainModelTooltip : undefined}
				downloadProgress={mainDownloadProgress}
				getFitAssessment={getFitAssessment}
				getSuggestion={getSuggestion}
				handleModelChange={controller.handleModelChange}
				isSwapping={mainSwapping}
				languageAutoDetect={languageAutoDetect}
				languageAutoDetectSupported={languageAutoDetectSupported}
				languageCandidates={languageCandidates}
				languageControlMode={languageControlMode}
				langOpts={langOpts}
				canDeleteQuant={canDeleteQuant}
				onDeleteQuant={handleGuardedDeleteQuant}
				onDownloadAction={handleMainDownloadAction}
				onDownloadSnapshot={handleDownloadSnapshot}
				sections={{
					language: showLanguage,
				}}
				selectedModel={selectedModel}
				settings={settings}
				statesById={statesById}
				systemInfo={systemInfo}
				t={t}
				translateSupported={translateSupported}
				translateTargetOpts={translateTargetOpts}
				update={update}
			/>
			<RealtimeModelSection
				catalogLoaded={catalogLoaded}
				catalogModels={catalogModels}
				currentQuantization={currentQuantization}
				disabled={!realtimeSectionActive}
				disabledTooltip={t("realtimeDisabledTooltip")}
				onToggle={handleRealtimeMasterToggle}
				toggleDisabled={realtimeToggleDisabled}
				toggleDisabledTooltip={realtimeToggleDisabledTooltip}
				downloadProgress={realtimeDownloadProgress}
				getFitAssessment={getFitAssessment}
				getSuggestion={getSuggestion}
				handleRealtimeModelChange={handleRealtimePick}
				isSwapping={realtimeSwapping}
				realtimeSlotLockedToMain={realtimeSlotLockedToMain}
				mainModelId={selectedModel}
				mainModelInfo={selectedInfo}
				updateIntervalApplies={updateIntervalApplies}
				canDeleteQuant={canDeleteQuant}
				onDeleteQuant={handleGuardedDeleteQuant}
				onDownloadAction={handleRealtimeDownloadAction}
				onDownloadSnapshot={handleDownloadSnapshot}
				quality={quality}
				sourceLanguageSelection={settings}
				langOpts={langOpts}
				realtimeLanguage={settings?.realtimeLanguage ?? ""}
				onRealtimeLanguageChange={(realtimeLanguage) =>
					update({ realtimeLanguage })
				}
				settings={settings}
				statesById={statesById}
				systemInfo={systemInfo}
				t={t}
				updateQuality={updateQuality}
			/>
			{isListenMode ? <SpeakerDiarizationSection /> : null}
			{showDevice && gpuAvailable && (
				<DeviceSection
					deviceOpts={deviceOpts}
					deviceValue={deviceValue}
					t={t}
					update={update}
				/>
			)}
			{showLifetime && (
				<ModelLifetimeSection
					forceNever={isListenMode}
					global={global}
					t={t}
					update={updateGlobal}
				/>
			)}
			<SwapDialogs
				controller={controller}
				getModel={getModel}
				statesById={statesById}
				systemInfo={systemInfo}
				t={t}
			/>
			<ConfirmDialog
				cancelLabel={tCommon("cancel")}
				confirmLabel={t("realtimeOffWordByWordConfirm")}
				description={t("realtimeOffWordByWordDescription")}
				onConfirm={confirmRealtimeOff}
				onOpenChange={setConfirmRealtimeOffOpen}
				open={confirmRealtimeOffOpen}
				title={t("realtimeOffWordByWordTitle")}
			/>
		</div>
	);
}

export function ModelSettingsPanel() {
	return useModelSettingsPanelRender();
}
