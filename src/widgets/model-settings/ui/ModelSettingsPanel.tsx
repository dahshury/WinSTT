import { useEffect } from "react";
import { useTranslations } from "use-intl";
import { providerOf } from "@/entities/cloud-stt-provider";
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

export function ModelSettingsPanel() {
	const global = useSettingsStore((s) => s.settings.global);
	const updateGlobal = useSettingsStore((s) => s.updateGlobalSettings);
	const settings = useSettingsStore((s) => s.settings.model);
	const update = useSettingsStore((s) => s.updateModelSettings);
	const quality = useSettingsStore((s) => s.settings.quality);
	const updateQuality = useSettingsStore((s) => s.updateQualitySettings);
	// Whether the LLM dictation "Translate" modifier is currently enabled — a
	// boolean selector so the panel only re-renders when it flips (not on every
	// preset edit). Drives the STT-translate ↔ LLM-translate lock below.
	const llmTranslateEnabled = useSettingsStore((s) =>
		s.settings.llm.dictation.presets.some((p) => p.key === "translate"),
	);
	const llmDictationEnabled = useSettingsStore(
		(s) => s.settings.llm.dictation.enabled,
	);
	// Local Kokoro TTS shares the Model-tab compute device (mirrored onto the
	// server's `--tts-device`), so the Device control must survive a cloud STT
	// selection while local TTS is still running. `tts` + the ElevenLabs key
	// status mirror TtsModelSection's effective-source gate.
	const tts = useSettingsStore((s) => s.settings.tts);
	const elevenlabs = useSettingsStore(
		(s) => s.settings.integrations.elevenlabs,
	);
	const recordingMode = useSettingsStore(
		(s) => s.settings.general?.recordingMode ?? "ptt",
	);
	const isListenMode = recordingMode === "listen";
	const showRecordingOverlay = useSettingsStore(
		(s) => s.settings.general?.showRecordingOverlay ?? true,
	);
	const liveTranscriptionDisplay = useSettingsStore(
		(s) => s.settings.general?.liveTranscriptionDisplay ?? "both",
	);
	const wordByWordPasting = useSettingsStore(
		(s) => s.settings.general?.wordByWordPasting ?? false,
	);
	// Realtime is fully derived from the display picker — the engine has no
	// observable output without a display surface, so there is no separate
	// on/off toggle. The realtime section here is hidden when this is false.
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

	// Model-state store — drives the inline cache badges and the ⚠ icon
	// in the dropdown labels. Refresh on mount so the server gets re-probed
	// each time the settings panel opens; live updates come through the
	// store's IPC subscriptions (model_cache_changed / swap_completed).
	const statesById = useModelStateStore((s) => s.statesById);
	const modelStatesLoaded = useModelStateStore((s) => s.isLoaded);
	const systemInfo = useModelStateStore((s) => s.systemInfo);
	const refreshModelState = useModelStateStore((s) => s.refresh);
	// Live download + swap snapshot lives in its own hook so the panel stays
	// at a reasonable cognitive-complexity score.
	const {
		mainDownloadProgress,
		realtimeDownloadProgress,
		mainSwapping,
		realtimeSwapping,
	} = useSwapProgress();

	// Live host resource snapshot (RAM available, free VRAM, CPU%) for the
	// resource-aware warning modal. Refreshed when the panel mounts; the snapshot
	// itself is read inside `useModelFitAssessment`.
	const refreshLive = useSystemResourcesStore((s) => s.refresh);

	useEffect(() => {
		refreshModelState();
		refreshLive();
	}, [refreshModelState, refreshLive]);

	// Fallback matches the bundled offline base seeded into the HF cache by
	// PyInstaller (see `seed_models.py` + `project_offline_base_and_tts_pack`
	// memory). The legacy "large-v2" fallback resolved to a catalog id the
	// picker no longer surfaces and produced a desync between the main
	// window header ("large-v2") and the picker selection (vosk-russian as
	// the first catalog row).
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
	const languageAutoDetect = languageAutoDetectEnabled(settings);
	// Stale-model fallback for both slots lives in its own hook. Keep it after
	// selectedInfo is known so realtime fallback uses the user's source-language
	// constraints instead of broad catalog overlap.
	useStaleModelFallback(
		catalogLoaded,
		catalogModels,
		statesById,
		modelStatesLoaded,
		settings?.model,
		settings?.realtimeModel,
		update,
		settings,
	);
	const languageAutoDetectSupported =
		languageControlMode === "auto" || languageControlMode === "candidate-auto";
	const effectiveLanguageAutoDetect =
		languageAutoDetectSupported && languageAutoDetect;
	// Remember the active local model so flipping the source switch Cloud→Local
	// restores the user's last choice instead of resetting to the catalog
	// default. Only local ids are recorded — a cloud selection delegates to the
	// provider and must not overwrite the remembered local pick.
	useEffect(() => {
		if (!selectedIsCloud) {
			recordLastLocalSttModel(selectedModel);
		}
	}, [selectedIsCloud, selectedModel]);
	// Translate-to-English is honored on multilingual Whisper exports
	// (via the ``<|translate|>`` prompt token) AND on NeMo Canary (via
	// the ``target_language`` recognize kwarg). Anything else silently
	// no-ops server-side, so we hide the toggle there to avoid lying
	// to the user. ``.en`` Whisper variants are filtered by the
	// language-detection capability — they advertise English only and
	// have no need for translate-to-English. We likewise hide it when the
	// user pins the source language to English: an en→en translate pass is
	// a no-op, so the toggle would be just as misleading there.
	const translateSupported =
		!selectedIsCloud &&
		selectedInfo !== undefined &&
		supportsTranslateToEnglish(selectedInfo) &&
		sourceMayNeedEnglishTranslation(
			effectiveLanguageAutoDetect,
			languageCandidates,
		);
	// When the STT decoder itself translates to English, force the LLM dictation
	// "Translate" modifier off so the transcript isn't translated twice. The LLM
	// panel additionally disables the row while this holds.
	useLockLlmTranslate(
		translateSupported && (settings?.translateToEnglish ?? false),
		llmTranslateEnabled,
	);
	const currentQuantization = (settings?.onnxQuantization ??
		"") as OnnxQuantization;
	// Resource-aware fit assessor for both model sections — owns the live host
	// snapshot subscription so the panel stays a thin composition root.
	const getFitAssessment = useModelFitAssessment({
		currentQuantization,
		deviceValue,
		realtimeEnabled,
		selectedIsCloud,
		selectedModel,
		settings,
		statesById,
	});

	// Which Model-tab controls stay visible. A cloud main hides the local-only
	// knobs (language, idle-unload-timeout, device) — except Device, which
	// local Kokoro TTS also rides on (`model.device` → `--tts-device`). The
	// derivation lives in pure helpers to keep this component under the
	// cognitive-complexity cap.
	const { showDevice, showLanguage } = resolveModelControlVisibility(
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

	// Block model switching while files are transcribing — the swap would reload
	// the shared transcriber mid-queue. The detached picker also disables its
	// selector; the reference main enforces the same block as a final safety net.
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

	// Per-quant badge handlers (delete + the shared download snapshot/action
	// handlers). The guarded delete reconciles the main/realtime selection to a
	// safe fallback before dropping the bytes — extracted into its own hook.
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

	// Gate a precision-badge "download this variant" click into the confirmation
	// dialog for the right slot (Electron parity); pause/resume/cancel still
	// dispatch straight to the server.
	const { handleMainDownloadAction, handleRealtimeDownloadAction } =
		useDownloadGating({ controller, handleDownloadAction });

	return (
		<div className="flex flex-col gap-2">
			{isListenMode ? null : (
				<MainModelSection
					catalogLoaded={catalogLoaded}
					catalogModels={catalogModels}
					currentQuantization={currentQuantization}
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
			)}
			{realtimeEnabled && !selectedIsCloud && (
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
			)}
			{/* Speaker diarization - gated to Listen mode (plain cross-tab read of
			    `general.recordingMode`), matching the original General-tab gate.
			    Persists to `general.speakerDiarization`; the runtime toggle wiring
			    lives in the diarization toggle store. */}
			{isListenMode ? <SpeakerDiarizationSection /> : null}
			{/* Compute device — standalone, shared by local STT + local TTS.
			    Shown only when a GPU exists AND a local model needs a device
			    (`showDevice`). With no GPU there is no choice to make (Auto
			    resolves to CPU), so the toggle is hidden rather than shown as a
			    dead single-option switch; it's also hidden when STT and TTS are
			    both cloud. Rendered outside the STT/TTS sections so it doesn't
			    read as belonging to either. */}
			{showDevice && gpuAvailable && (
				<DeviceSection
					deviceOpts={deviceOpts}
					deviceValue={deviceValue}
					t={t}
					update={update}
				/>
			)}
			<ModelLifetimeSection global={global} t={t} update={updateGlobal} />
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
