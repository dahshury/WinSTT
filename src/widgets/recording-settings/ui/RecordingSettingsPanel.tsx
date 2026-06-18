import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { useCatalogStore, useModelStateStore } from "@/entities/model-catalog";
import { useSettingsStore, useSettingsTabStore } from "@/entities/setting";
import {
	hasCachedNativeStreamingModel,
	resolveListenStreamingModelId,
} from "@/features/listen-mode";
import {
	wakewordCancelModelDownload,
	type WakewordModelStatusPayload,
	wakewordPauseModelDownload,
	wakewordResumeModelDownload,
	wakewordStartModelDownload,
} from "@/shared/api/ipc-client";
import { isRealtimeEnabled } from "@/shared/lib/realtime-enabled";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { recordingModePatch } from "../lib/recording-settings-helpers";
import {
	InputDeviceSection,
	RecordingSoundSection,
	VadSection,
} from "./CaptureSections";
import {
	AdvancedSection,
	SentencePauseSection,
	SmartEndpointSection,
} from "./EndpointingSections";
import { RecordingModeSection } from "./RecordingModeSection";
import {
	useWakewordModelStatus,
	WakewordDownloadDialog,
} from "./WakewordDownload";
import { wakewordStatusWithRuntimeFallback } from "./wakeword-status";

const pauseWakewordDownload = () => {
	void wakewordPauseModelDownload();
};

export function RecordingSettingsPanel() {
	const general = useSettingsStore((s) => s.settings.general);
	const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
	const audio = useSettingsStore((s) => s.settings.audio);
	const updateAudio = useSettingsStore((s) => s.updateAudioSettings);
	const q = useSettingsStore((s) => s.settings.quality);
	const update = useSettingsStore((s) => s.updateQualitySettings);
	const model = useSettingsStore((s) => s.settings.model);
	const updateLlmDictation = useSettingsStore((s) => s.updateLlmDictation);
	const setActiveSettingsTab = useSettingsTabStore((s) => s.setActiveTab);
	const recordingMode = general?.recordingMode ?? "ptt";
	const wakewordEnablePendingRef = useRef(false);
	const [wakewordDialogOpen, setWakewordDialogOpen] = useState(false);
	const [wakewordEnablePending, setWakewordEnablePending] = useState(false);
	const [listenModelDialogOpen, setListenModelDialogOpen] = useState(false);
	const finalizeWakewordEnable = (next: WakewordModelStatusPayload): void => {
		if (
			!wakewordEnablePendingRef.current ||
			!wakewordStatusWithRuntimeFallback(next, general?.wakeWord).available
		) {
			return;
		}
		updateGeneral(recordingModePatch("wakeword", general?.wakeWord));
		wakewordEnablePendingRef.current = false;
		setWakewordEnablePending(false);
		setWakewordDialogOpen(false);
	};
	const rawWakewordStatus = useWakewordModelStatus(finalizeWakewordEnable);
	const wakewordStatus = wakewordStatusWithRuntimeFallback(
		rawWakewordStatus,
		general?.wakeWord,
	);
	const llmDictationEnabled = useSettingsStore(
		(s) => s.settings.llm?.dictation?.enabled ?? false,
	);
	const catalogModels = useCatalogStore((s) => s.models);
	const statesById = useModelStateStore((s) => s.statesById);
	const refreshModelState = useModelStateStore((s) => s.refresh);
	const listenModelId = resolveListenStreamingModelId(
		model,
		q,
		catalogModels,
		statesById,
	);
	const cachedStreamingModelAvailable = hasCachedNativeStreamingModel(
		catalogModels,
		statesById,
	);

	const t = useTranslations("general");
	const ta = useTranslations("audio");
	const tc = useTranslations("common");
	const tq = useTranslations("quality");
	const ts = useTranslations("settings");

	useEffect(() => {
		void refreshModelState();
	}, [refreshModelState]);

	// Smart Endpoint and LLM dictation cleanup make conflicting decisions about
	// when to finalise speech — enabling either auto-disables the other. The LLM
	// dictation feature lives on the Processing tab; this stays a plain store
	// read/write of llm.dictation.enabled.
	const handleSmartEndpointToggle = (next: boolean): void => {
		update({ smartEndpoint: next });
		if (next && llmDictationEnabled) {
			updateLlmDictation({ enabled: false });
		}
	};

	const prepareListenMode = (): boolean => {
		if (listenModelId !== null) {
			return true;
		}
		setListenModelDialogOpen(true);
		return false;
	};

	// Smart Endpoint only makes sense in modes where silence ends the utterance.
	// PTT defines the boundary via key release; Listen runs continuous loopback
	// capture where endpoint tuning is more noise than signal.
	const smartEndpointApplicable =
		recordingMode === "toggle" || recordingMode === "wakeword";

	// Sentence-pause sliders are only relevant when silence_timing is driving
	// post_speech_silence_duration — that's toggle mode with manual-stop off
	// (or wakeword which never opts out). PTT, Listen, and toggle+manualStop
	// all bypass the heuristic so the sliders would have no effect.
	const manualToggleStop = general?.manualToggleStop ?? false;
	const recordingSoundEnabled = general?.recordingSound ?? true;
	const sentencePausesApplicable =
		(recordingMode === "toggle" && !manualToggleStop) ||
		recordingMode === "wakeword";

	const startWakewordDownload = () => {
		wakewordEnablePendingRef.current = true;
		setWakewordEnablePending(true);
		setWakewordDialogOpen(true);
		void wakewordStartModelDownload().then(finalizeWakewordEnable);
	};

	const resumeWakewordDownload = () => {
		wakewordEnablePendingRef.current = true;
		setWakewordEnablePending(true);
		setWakewordDialogOpen(true);
		void wakewordResumeModelDownload().then(finalizeWakewordEnable);
	};

	const cancelWakewordDownload = () => {
		wakewordEnablePendingRef.current = false;
		setWakewordEnablePending(false);
		void wakewordCancelModelDownload();
	};

	return (
		<div className="flex flex-col gap-2">
			<RecordingModeSection
				audio={audio}
				general={general}
				prepareListenMode={prepareListenMode}
				recordingMode={recordingMode}
				requestWakewordDownload={() => setWakewordDialogOpen(true)}
				ta={ta}
				t={t}
				update={updateGeneral}
				updateAudio={updateAudio}
				wakewordEnablePending={wakewordEnablePending}
				wakewordStatus={wakewordStatus}
			/>
			<WakewordDownloadDialog
				enablePending={wakewordEnablePending}
				onCancelDownload={cancelWakewordDownload}
				onOpenChange={setWakewordDialogOpen}
				onPause={pauseWakewordDownload}
				onResume={resumeWakewordDownload}
				onStart={startWakewordDownload}
				open={wakewordDialogOpen}
				status={wakewordStatus}
			/>
			<ConfirmDialog
				cancelLabel="Keep current mode"
				confirmLabel="Open Model tab"
				description={
					cachedStreamingModelAvailable
						? "Choose a downloaded realtime STT model before enabling Listen mode. The recording mode was left unchanged."
						: "Download a realtime STT model before enabling Listen mode. The recording mode was left unchanged."
				}
				onConfirm={() => setActiveSettingsTab("model")}
				onOpenChange={setListenModelDialogOpen}
				open={listenModelDialogOpen}
				title="Listen mode needs a realtime model"
			/>

			{/* ── Input Device (hidden in Listen mode — loopback device is used instead) */}
			{recordingMode !== "listen" && (
				<InputDeviceSection audio={audio} t={ta} update={updateAudio} />
			)}
			{recordingMode !== "listen" && (
				<RecordingSoundSection
					enabled={recordingSoundEnabled}
					general={general}
					t={t}
					tCommon={tc}
					tSettings={ts}
					update={updateGeneral}
				/>
			)}

			{/* ── Voice Activity Detection (only meaningful when VAD drives endpoints) */}
			{(recordingMode === "listen" || recordingMode === "wakeword") && (
				<VadSection audio={audio} ta={ta} updateAudio={updateAudio} />
			)}

			{/* ── Smart Endpoint (Toggle / Wake Word only, realtime required).
			   Realtime is derived from the live-transcription display picker
			   (see `isRealtimeEnabled`); when no display surface is active
			   the engine isn't running, so Smart Endpoint has nothing to gate.
			   showRecordingOverlay + liveTranscriptionDisplay live on the
			   Appearance tab — read as plain store values here. */}
			{isRealtimeEnabled({
				showRecordingOverlay: general?.showRecordingOverlay ?? true,
				liveTranscriptionDisplay: general?.liveTranscriptionDisplay ?? "both",
				llmDictationEnabled,
				wordByWordPasting: general?.wordByWordPasting ?? false,
			}) &&
				smartEndpointApplicable && (
					<SmartEndpointSection
						onToggle={handleSmartEndpointToggle}
						q={q}
						t={tq}
						update={update}
					/>
				)}

			{/* ── Sentence pauses (toggle/wakeword only, hidden when smart endpoint
			   handles them automatically or manual-toggle bypasses silence detection) */}
			{sentencePausesApplicable && !(q?.smartEndpoint ?? false) && (
				<SentencePauseSection q={q} t={tq} update={update} />
			)}

			{/* ── Advanced — mic-release behavior */}
			<AdvancedSection audio={audio} t={ta} update={updateAudio} />
		</div>
	);
}
