import { useEffect } from "react";
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
import { useModelSwapController } from "@/features/swap-model";
import type { OnnxQuantization } from "@/shared/config/defaults";
import { isRealtimeEnabled } from "@/shared/lib/realtime-enabled";
import {
	buildLanguageOptions,
	deriveLanguageCandidates,
	fixedLanguageValue,
	languageAutoDetectEnabled,
	resolveLanguageControlMode,
	sourceMayNeedEnglishTranslation,
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
	const gpuInfo = useConnectionStore((s) => s.gpuInfo);
	const gpuAvailable = gpuInfo.length > 0;
	const t = useTranslations("model");
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

	useEffect(() => {
		refreshModelState();
		refreshLive();
	}, [refreshModelState, refreshLive]);

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
		modelStatesLoaded,
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
	}, [selectedIsCloud, selectedModel]);
	const translateSupported =
		!selectedIsCloud &&
		selectedInfo !== undefined &&
		supportsTranslateToEnglish(selectedInfo) &&
		sourceMayNeedEnglishTranslation(
			effectiveLanguageAutoDetect,
			languageCandidates,
		);
	useLockLlmTranslate(
		translateSupported && (settings?.translateToEnglish ?? false),
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
			return;
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
		update,
		isQuantDownloading,
		() => useFileTranscriptionStore.getState().queueActive,
	);

	const useMainModelFlag = quality?.useMainModelForRealtime ?? false;
	const mainModelStreamingKnown = selectedIsCloud || selectedInfo !== undefined;
	const mainModelCanNativeStream =
		!selectedIsCloud &&
		selectedInfo !== undefined &&
		isSelectableRealtimeModel(selectedInfo);
	const selectedRealtimeInfo = settings?.realtimeModel
		? getModel(settings.realtimeModel)
		: undefined;
	const effectiveRealtimeInfo = mainModelCanNativeStream
		? selectedInfo
		: selectedRealtimeInfo;
	const updateIntervalApplies =
		isListenMode || effectiveRealtimeInfo?.nativeStreaming !== true;
	const handleRealtimePick = (v: string, quantization?: OnnxQuantization) => {
		if (mainModelCanNativeStream && v !== selectedModel) {
			return;
		}
		controller.handleRealtimeModelChange(v, quantization);
		const shouldReuseMain = v === selectedModel && mainModelCanNativeStream;
		if (shouldReuseMain !== useMainModelFlag) {
			updateQuality({ useMainModelForRealtime: shouldReuseMain });
		}
	};

	useEffect(() => {
		if (!mainModelStreamingKnown) {
			return;
		}
		if (mainModelCanNativeStream) {
			if (settings?.realtimeModel !== selectedModel) {
				update({ realtimeModel: selectedModel });
			}
			if (!useMainModelFlag) {
				updateQuality({ useMainModelForRealtime: true });
			}
			return;
		}
		if (useMainModelFlag) {
			updateQuality({ useMainModelForRealtime: false });
		}
	}, [
		mainModelCanNativeStream,
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
		<div className="flex flex-col gap-2">
			<MainModelSection
				catalogLoaded={catalogLoaded}
				catalogModels={catalogModels}
				currentQuantization={currentQuantization}
				disabled={isListenMode}
				disabledTooltip={isListenMode ? listenModeMainModelTooltip : undefined}
				downloadProgress={mainDownloadProgress}
				getFitAssessment={getFitAssessment}
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
				update={update}
			/>
			<RealtimeModelSection
				catalogLoaded={catalogLoaded}
				catalogModels={catalogModels}
				currentQuantization={currentQuantization}
				downloadProgress={realtimeDownloadProgress}
				getFitAssessment={getFitAssessment}
				handleRealtimeModelChange={handleRealtimePick}
				isSwapping={realtimeSwapping}
				mainModelCanNativeStream={mainModelCanNativeStream}
				mainModelId={selectedModel}
				mainModelInfo={selectedInfo}
				updateIntervalApplies={updateIntervalApplies}
				canDeleteQuant={canDeleteQuant}
				onDeleteQuant={handleGuardedDeleteQuant}
				onDownloadAction={handleRealtimeDownloadAction}
				onDownloadSnapshot={handleDownloadSnapshot}
				quality={quality}
				sourceLanguageSelection={settings}
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
		</div>
	);
}

export function ModelSettingsPanel() {
	return useModelSettingsPanelRender();
}
