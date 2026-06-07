import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { useSettingsStore } from "@/entities/setting";
import { useLoopbackDevices } from "@/features/listen-mode";
import {
  wakewordCancelModelDownload,
  wakewordPauseModelDownload,
  wakewordResumeModelDownload,
  wakewordStartModelDownload,
} from "@/shared/api/ipc-client";
import { isRealtimeEnabled } from "@/shared/lib/realtime-enabled";
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
  wakewordStatusWithRuntimeFallback,
} from "./WakewordDownload";

export function RecordingSettingsPanel() {
  const general = useSettingsStore((s) => s.settings.general);
  const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
  const audio = useSettingsStore((s) => s.settings.audio);
  const updateAudio = useSettingsStore((s) => s.updateAudioSettings);
  const q = useSettingsStore((s) => s.settings.quality);
  const update = useSettingsStore((s) => s.updateQualitySettings);
  const updateLlmDictation = useSettingsStore((s) => s.updateLlmDictation);
  const recordingMode = general?.recordingMode ?? "ptt";
  const rawWakewordStatus = useWakewordModelStatus();
  const wakewordStatus = wakewordStatusWithRuntimeFallback(
    rawWakewordStatus,
    general?.wakeWord,
  );
  const [wakewordDialogOpen, setWakewordDialogOpen] = useState(false);
  const [wakewordEnablePending, setWakewordEnablePending] = useState(false);
  const llmDictationEnabled = useSettingsStore(
    (s) => s.settings.llm?.dictation?.enabled ?? false,
  );

  const t = useTranslations("general");
  const ta = useTranslations("audio");
  const tc = useTranslations("common");
  const tq = useTranslations("quality");
  const ts = useTranslations("settings");

  const {
    options: loopbackOpts,
    currentId: currentLoopbackId,
    handleChange: handleLoopbackChange,
  } = useLoopbackDevices();

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
    setWakewordEnablePending(true);
    setWakewordDialogOpen(true);
    void wakewordStartModelDownload();
  };

  const pauseWakewordDownload = () => {
    void wakewordPauseModelDownload();
  };

  const resumeWakewordDownload = () => {
    setWakewordEnablePending(true);
    setWakewordDialogOpen(true);
    void wakewordResumeModelDownload();
  };

  const cancelWakewordDownload = () => {
    setWakewordEnablePending(false);
    void wakewordCancelModelDownload();
  };

  useEffect(() => {
    if (!wakewordEnablePending || !wakewordStatus.available) {
      return;
    }
    updateGeneral(recordingModePatch("wakeword", general?.wakeWord));
    setWakewordEnablePending(false);
    setWakewordDialogOpen(false);
  }, [
    general?.wakeWord,
    updateGeneral,
    wakewordEnablePending,
    wakewordStatus.available,
  ]);

  return (
    <div className="flex flex-col gap-2">
      <RecordingModeSection
        audio={audio}
        currentLoopbackId={currentLoopbackId}
        general={general}
        handleLoopbackChange={handleLoopbackChange}
        loopbackOpts={loopbackOpts}
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
