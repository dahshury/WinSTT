import {
  Clock01Icon,
  FlashIcon,
  HourglassIcon,
  InfinityIcon,
  Mic02Icon,
  MicOff01Icon,
  PauseCircleIcon,
  Radar02Icon,
  RecordIcon,
  SlidersHorizontalIcon,
  Timer01Icon,
  VoiceIdIcon,
} from "@hugeicons/core-free-icons";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "use-intl";
import {
  buildInputDeviceOptions,
  useInputDevices,
} from "@/entities/audio-device";
import {
  DEFAULT_SETTINGS,
  SettingField,
  SettingSection,
  useSettingsStore,
} from "@/entities/setting";
import { useLoopbackDevices } from "@/features/listen-mode";
import {
  onWakewordModelStatus,
  wakewordCancelModelDownload,
  wakewordModelStatus,
  wakewordPauseModelDownload,
  wakewordResumeModelDownload,
  wakewordStartModelDownload,
  type WakewordModelStatusPayload,
} from "@/shared/api/ipc-client";
import { isRealtimeEnabled } from "@/shared/lib/realtime-enabled";
import { CreatableCombobox } from "@/shared/ui/creatable-combobox";
import { DialogActionButton } from "@/shared/ui/dialog";
import { DialogShell } from "@/shared/ui/dialog-shell";
import { DownloadActions, DownloadProgressBar } from "@/shared/ui/download";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { Select, type SelectOption } from "@/shared/ui/select";
import { Slider } from "@/shared/ui/slider";
import { Switcher } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";
import {
  buildWakeWordItems,
  buildRecordingModeOptions,
  isLowerAccuracyWakeWord,
  normalizeWakeWordPhrase,
  presetIdForWakePhrase,
  reconcileCustomWakeWords,
  recordingModePatch,
  SENSITIVITY_STEPS,
  sensitivityFromIndex,
  sensitivityToIndex,
  wakeWordFromItemId,
  wakeWordValueToItemId,
} from "../lib/recording-settings-helpers";

type GeneralT = ReturnType<typeof useTranslations<"general">>;
type AudioT = ReturnType<typeof useTranslations<"audio">>;
type QualityT = ReturnType<typeof useTranslations<"quality">>;
type GeneralSettings = NonNullable<
  ReturnType<typeof useSettingsStore.getState>["settings"]["general"]
>;
type AudioSettings = NonNullable<
  ReturnType<typeof useSettingsStore.getState>["settings"]["audio"]
>;
type QualitySettings = NonNullable<
  ReturnType<typeof useSettingsStore.getState>["settings"]["quality"]
>;
type UpdateGeneralFn = (patch: Partial<GeneralSettings>) => void;
type UpdateAudioFn = (patch: Partial<AudioSettings>) => void;
type UpdateQualityFn = (patch: Partial<QualitySettings>) => void;

const SILENCE_STOP_MIN_SECONDS = 0.1;
const SILENCE_STOP_MAX_SECONDS = 10;
const SILENCE_STOP_STEP_SECONDS = 0.1;
const WAKEWORD_DOWNLOAD_SIZE_LABEL = "about 17 MB";
const WAKEWORD_MODEL_DISABLED_REASON = "wake word model download";
const WAKEWORD_MODEL_STATUS_DEFAULT: WakewordModelStatusPayload = {
  available: false,
  downloading: false,
  phase: "idle",
};

function roundSilenceStopSeconds(value: number): number {
  return Number(
    (
      Math.round(value / SILENCE_STOP_STEP_SECONDS) * SILENCE_STOP_STEP_SECONDS
    ).toFixed(1),
  );
}

function useWakewordModelStatus(): WakewordModelStatusPayload {
  const [status, setStatus] = useState<WakewordModelStatusPayload>(
    WAKEWORD_MODEL_STATUS_DEFAULT,
  );

  useEffect(() => {
    let mounted = true;
    wakewordModelStatus().then((next) => {
      if (mounted) {
        setStatus(next);
      }
    });
    const unsubscribe = onWakewordModelStatus((next) => setStatus(next));
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  return status;
}

function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes == null) {
    return null;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

function formatBytesPerSecond(bytes: number | null | undefined): string | null {
  const formatted = formatBytes(bytes);
  return formatted ? `${formatted}/s` : null;
}

function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  if (seconds < 60) {
    return `${Math.max(1, Math.round(seconds))}s left`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return remainder === 0 ? `${minutes}m left` : `${minutes}m ${remainder}s left`;
}

function wakewordProgressPercent(
  status: WakewordModelStatusPayload,
): number | null {
  return status.progress == null ? null : Math.round(status.progress * 100);
}

function wakewordDownloadStatsLabel(
  status: WakewordModelStatusPayload,
): string {
  const downloaded = formatBytes(status.downloadedBytes);
  const total = formatBytes(status.totalBytes);
  const speed = formatBytesPerSecond(status.speedBps);
  const eta = formatDuration(status.etaSeconds);
  const byteLabel =
    downloaded && total
      ? `${downloaded} / ${total}`
      : (downloaded ?? status.downloadSizeLabel ?? WAKEWORD_DOWNLOAD_SIZE_LABEL);
  return [byteLabel, speed, eta].filter(Boolean).join(" · ");
}

function wakewordDownloadPhase(
  status: WakewordModelStatusPayload,
): "idle" | "active" | "paused" {
  if (status.downloading || status.phase === "downloading") {
    return "active";
  }
  if (status.phase === "paused") {
    return "paused";
  }
  return "idle";
}

function WakewordDownloadProgress({
  status,
}: {
  status: WakewordModelStatusPayload;
}): ReactNode {
  if (status.available) {
    return null;
  }
  if (status.downloading) {
    const percent = wakewordProgressPercent(status);
    const engineLabel = status.engineLabel ?? "wake word model";
    return (
      <div className="py-3">
        <DownloadProgressBar
          label={
            percent == null
              ? `Preparing ${engineLabel}`
              : `${percent}% - downloading ${engineLabel}`
          }
          percent={percent}
          statsLabel={wakewordDownloadStatsLabel(status)}
          variant="active"
        />
      </div>
    );
  }
  if (status.phase === "paused") {
    return (
      <div className="py-3">
        <DownloadProgressBar
          label={`Paused - ${status.artifactLabel ?? "wake word files"}`}
          percent={wakewordProgressPercent(status)}
          statsLabel={wakewordDownloadStatsLabel(status)}
          variant="paused"
        />
      </div>
    );
  }
  if (status.error) {
    return (
      <div className="py-3 text-body-sm text-error">
        Wake word model download failed: {status.error}
      </div>
    );
  }
  return null;
}

interface WakewordDownloadDialogProps {
  enablePending: boolean;
  onCancelDownload: () => void;
  onOpenChange: (open: boolean) => void;
  onPause: () => void;
  onResume: () => void;
  onStart: () => void;
  open: boolean;
  status: WakewordModelStatusPayload;
}

function WakewordDownloadDialog({
  enablePending,
  onCancelDownload,
  onOpenChange,
  onPause,
  onResume,
  onStart,
  open,
  status,
}: WakewordDownloadDialogProps): ReactNode {
  const phase = wakewordDownloadPhase(status);
  const flowStarted =
    enablePending || phase !== "idle" || !!status.error || status.phase === "failed";
  const engineLabel = status.engineLabel ?? "wake word detection";
  const artifactLabel = status.artifactLabel ?? "wake word files";
  const description = flowStarted ? (
    <div className="flex flex-col gap-2">
      <p>
        Downloading {artifactLabel} for {engineLabel}. Your current recording
        mode stays active while this runs.
      </p>
      <p>
        Wake Word mode will be enabled automatically after the files are ready.
      </p>
    </div>
  ) : (
    <div className="flex flex-col gap-2">
      <p>
        Wake Word mode needs a one-time local download for {engineLabel} (
        {status.downloadSizeLabel ?? WAKEWORD_DOWNLOAD_SIZE_LABEL}). The files
        stay on this device and are used to listen for the selected wake word.
      </p>
      {status.qualityLabel ? (
        <p className="text-warning">{status.qualityLabel}</p>
      ) : null}
      <p>
        Your current recording mode will stay active during the download, then
        Wake Word mode will turn on automatically.
      </p>
    </div>
  );
  const handleCancelDownload = () => {
    onCancelDownload();
    onOpenChange(false);
  };

  return (
    <DialogShell
      body={flowStarted ? <WakewordDownloadProgress status={status} /> : null}
      description={description}
      onOpenChange={onOpenChange}
      open={open}
      title={flowStarted ? "Downloading wake word files" : "Download wake word files?"}
      width={500}
    >
      {flowStarted ? (
        <>
          <DialogActionButton onClick={() => onOpenChange(false)} variant="neutral">
            Hide
          </DialogActionButton>
          {phase === "active" ? (
            <DialogActionButton onClick={handleCancelDownload} variant="danger">
              Cancel download
            </DialogActionButton>
          ) : null}
          <DownloadActions
            labels={{
              discard: "Cancel download",
              download: status.error ? "Retry" : "Download",
              resume: "Resume",
              stop: "Pause",
            }}
            onDiscard={handleCancelDownload}
            onDownload={onStart}
            onResume={onResume}
            onStop={onPause}
            phase={phase}
          />
        </>
      ) : (
        <>
          <DialogActionButton onClick={() => onOpenChange(false)} variant="neutral">
            Cancel
          </DialogActionButton>
          <DialogActionButton onClick={onStart} variant="accent">
            Download and enable
          </DialogActionButton>
        </>
      )}
    </DialogShell>
  );
}

interface WakewordRuntimeFallback {
  artifactLabel: string;
  downloadSizeLabel: string;
  engine: string;
  engineLabel: string;
  qualityLabel: string;
}

function wakewordRuntimeFallback(
  wakeWord: string | undefined,
): WakewordRuntimeFallback {
  const lowerAccuracy = isLowerAccuracyWakeWord(wakeWord);
  return lowerAccuracy
    ? {
        artifactLabel: "sherpa-onnx KWS archive",
        downloadSizeLabel: WAKEWORD_DOWNLOAD_SIZE_LABEL,
        engine: "sherpa-kws",
        engineLabel: "sherpa-onnx custom wake words",
        qualityLabel: "Lower accuracy custom",
      }
    : {
        artifactLabel: "pvporcupine 1.9.5 wheel",
        downloadSizeLabel: "about 2 MB",
        engine: "porcupine-legacy",
        engineLabel: "Porcupine built-in wake words",
        qualityLabel: "High accuracy built-in",
      };
}

function wakewordStatusWithRuntimeFallback(
  status: WakewordModelStatusPayload,
  wakeWord: string | undefined,
): WakewordModelStatusPayload {
  const fallback = wakewordRuntimeFallback(wakeWord);
  return {
    ...status,
    artifactLabel: status.artifactLabel ?? fallback.artifactLabel,
    downloadSizeLabel: status.downloadSizeLabel ?? fallback.downloadSizeLabel,
    engine: status.engine ?? fallback.engine,
    engineLabel: status.engineLabel ?? fallback.engineLabel,
    phase:
      status.phase ??
      (status.available ? "complete" : status.downloading ? "downloading" : "idle"),
    qualityLabel: status.qualityLabel ?? fallback.qualityLabel,
  };
}

// ─────────────────────────── Recording mode sub-controls ───────────────────────────

interface LoopbackControlProps {
  currentLoopbackId: string;
  handleLoopbackChange: (value: string) => void;
  loopbackOpts: SelectOption[];
  t: GeneralT;
}

function LoopbackControl({
  t,
  currentLoopbackId,
  loopbackOpts,
  handleLoopbackChange,
}: LoopbackControlProps): ReactNode {
  return (
    <SettingField
      isDefault={currentLoopbackId === "default"}
      label={t("loopbackDevice")}
      layout="row"
      onReset={() => handleLoopbackChange("default")}
      tooltip={t("loopbackDeviceTooltip")}
    >
      <ElevatedSurface className="w-52" inline>
        <Select
          onChange={handleLoopbackChange}
          options={loopbackOpts}
          value={currentLoopbackId}
        />
      </ElevatedSurface>
    </SettingField>
  );
}

interface ManualToggleStopControlProps {
  enabled: boolean;
  t: GeneralT;
  update: UpdateGeneralFn;
}

// "Stop only on hotkey press" — surfaces under the toggle-mode option only.
// Flips silence_endpoint_enabled and silence_timing off on the server so a
// toggle-mode session runs continuously from first press to second press,
// fixing the mid-speech cutoff users hit when their voice goes soft.
function ManualToggleStopControl({
  enabled,
  t,
  update,
}: ManualToggleStopControlProps): ReactNode {
  return (
    <SettingField
      isDefault={enabled === DEFAULT_SETTINGS.general.manualToggleStop}
      label={t("manualToggleStop")}
      labelAddon={
        <Toggle
          aria-label={t("manualToggleStop")}
          checked={enabled}
          onCheckedChange={(v) => update({ manualToggleStop: v })}
        />
      }
      onReset={() =>
        update({ manualToggleStop: DEFAULT_SETTINGS.general.manualToggleStop })
      }
      tooltip={t("manualToggleStopTooltip")}
    />
  );
}

interface ToggleSilenceStopControlProps {
  audio: AudioSettings | undefined;
  t: AudioT;
  update: UpdateAudioFn;
}

function ToggleSilenceStopControl({
  audio,
  t,
  update,
}: ToggleSilenceStopControlProps): ReactNode {
  const value =
    audio?.postSpeechSilenceDuration ??
    DEFAULT_SETTINGS.audio.postSpeechSilenceDuration;
  return (
    <SettingField
      isDefault={value === DEFAULT_SETTINGS.audio.postSpeechSilenceDuration}
      label={t("postSpeechSilence")}
      onReset={() =>
        update({
          postSpeechSilenceDuration:
            DEFAULT_SETTINGS.audio.postSpeechSilenceDuration,
        })
      }
      tooltip={t("postSpeechSilenceTooltip")}
    >
      <ElevatedSurface inline>
        <Slider
          aria-label={t("postSpeechSilence")}
          formatValue={(v) => `${v.toFixed(1)}s`}
          max={SILENCE_STOP_MAX_SECONDS}
          min={SILENCE_STOP_MIN_SECONDS}
          onChange={(v) =>
            update({ postSpeechSilenceDuration: roundSilenceStopSeconds(v) })
          }
          step={SILENCE_STOP_STEP_SECONDS}
          value={value}
        />
      </ElevatedSurface>
    </SettingField>
  );
}

interface WakeWordControlProps {
  customWakeWords: readonly string[];
  disabled?: boolean;
  t: GeneralT;
  update: UpdateGeneralFn;
  value: string;
}

function WakeWordControl({
  customWakeWords,
  disabled = false,
  t,
  value,
  update,
}: WakeWordControlProps): ReactNode {
  const savedCustomWakeWords = reconcileCustomWakeWords(value, customWakeWords);
  const selectedItemId = wakeWordValueToItemId(value);
  const lowerAccuracy = isLowerAccuracyWakeWord(value);
  const handleSelect = (id: string) => {
    const nextWakeWord = wakeWordFromItemId(id);
    update({
      wakeWord: nextWakeWord,
      customWakeWords: reconcileCustomWakeWords(
        nextWakeWord,
        savedCustomWakeWords,
      ),
    });
  };
  const handleCreate = (raw: string) => {
    const phrase = normalizeWakeWordPhrase(raw);
    if (!phrase) {
      return;
    }
    const preset = presetIdForWakePhrase(phrase);
    if (preset) {
      update({ wakeWord: preset, customWakeWords: savedCustomWakeWords });
      return;
    }
    update({
      wakeWord: phrase,
      customWakeWords: reconcileCustomWakeWords(phrase, [
        ...savedCustomWakeWords,
        phrase,
      ]),
    });
  };
  const handleDelete = (id: string) => {
    const phrase = wakeWordFromItemId(id);
    const nextCustomWakeWords = savedCustomWakeWords.filter(
      (word) => word !== phrase,
    );
    update({
      customWakeWords: nextCustomWakeWords,
      ...(normalizeWakeWordPhrase(value) === phrase
        ? { wakeWord: DEFAULT_SETTINGS.general.wakeWord }
        : {}),
    });
  };
  const isDefault =
    value === DEFAULT_SETTINGS.general.wakeWord &&
    savedCustomWakeWords.length === 0;
  return (
    <SettingField
      isDefault={isDefault}
      label={t("wakeWord")}
      layout="row"
      onReset={() =>
        update({
          wakeWord: DEFAULT_SETTINGS.general.wakeWord,
          customWakeWords: DEFAULT_SETTINGS.general.customWakeWords,
        })
      }
      disabled={disabled}
      disabledReason={WAKEWORD_MODEL_DISABLED_REASON}
      tooltip={t("wakeWordTooltip")}
    >
      <CreatableCombobox
        className="w-full sm:w-64"
        createLabel={(phrase) => `Save "${phrase}"`}
        deleteAriaLabel="Delete custom wake word"
        disabled={disabled}
        emptyLabel="Type to save a custom wake word"
        items={buildWakeWordItems(savedCustomWakeWords, value)}
        onCreate={handleCreate}
        onDelete={handleDelete}
        onSelect={handleSelect}
        placeholder="Select or type wake word"
        value={selectedItemId}
      />
      {lowerAccuracy ? (
        <p className="mt-1 text-body-sm text-warning">
          Custom/flexible wake phrases use sherpa-onnx and are lower accuracy than
          built-in Porcupine phrases.
        </p>
      ) : null}
    </SettingField>
  );
}

interface WakeWordSensitivityControlProps {
  disabled?: boolean;
  t: GeneralT;
  update: UpdateGeneralFn;
  value: number;
}

function WakeWordSensitivityControl({
  disabled = false,
  t,
  value,
  update,
}: WakeWordSensitivityControlProps): ReactNode {
  return (
    <SettingField
      isDefault={value === DEFAULT_SETTINGS.general.wakeWordSensitivity}
      label={t("wakeWordSensitivity")}
      onReset={() =>
        update({
          wakeWordSensitivity: DEFAULT_SETTINGS.general.wakeWordSensitivity,
        })
      }
      disabled={disabled}
      disabledReason={WAKEWORD_MODEL_DISABLED_REASON}
      tooltip={t("wakeWordSensitivityTooltip")}
    >
      <ElevatedSurface inline>
        <Slider
          aria-label={t("wakeWordSensitivity")}
          disabled={disabled}
          formatValue={(idx) => sensitivityFromIndex(idx).toFixed(2)}
          max={SENSITIVITY_STEPS}
          min={0}
          onChange={(idx) =>
            update({ wakeWordSensitivity: sensitivityFromIndex(idx) })
          }
          step={1}
          value={sensitivityToIndex(value)}
        />
      </ElevatedSurface>
    </SettingField>
  );
}

interface WakeWordTimeoutControlProps {
  disabled?: boolean;
  t: GeneralT;
  update: UpdateGeneralFn;
  value: number;
}

function WakeWordTimeoutControl({
  disabled = false,
  t,
  value,
  update,
}: WakeWordTimeoutControlProps): ReactNode {
  return (
    <SettingField
      isDefault={value === DEFAULT_SETTINGS.general.wakeWordTimeout}
      label={t("wakeWordTimeout")}
      onReset={() =>
        update({ wakeWordTimeout: DEFAULT_SETTINGS.general.wakeWordTimeout })
      }
      disabled={disabled}
      disabledReason={WAKEWORD_MODEL_DISABLED_REASON}
      tooltip={t("wakeWordTimeoutTooltip")}
    >
      <ElevatedSurface inline>
        <Slider
          aria-label={t("wakeWordTimeout")}
          disabled={disabled}
          formatValue={(v) => `${v}s`}
          max={30}
          min={1}
          onChange={(v) => update({ wakeWordTimeout: v })}
          step={1}
          value={value}
        />
      </ElevatedSurface>
    </SettingField>
  );
}

interface RecordingModeSectionProps {
  audio: AudioSettings | undefined;
  currentLoopbackId: string;
  general: GeneralSettings | undefined;
  handleLoopbackChange: (value: string) => void;
  loopbackOpts: SelectOption[];
  recordingMode: "ptt" | "toggle" | "listen" | "wakeword";
  requestWakewordDownload: () => void;
  ta: AudioT;
  t: GeneralT;
  update: UpdateGeneralFn;
  updateAudio: UpdateAudioFn;
  wakewordEnablePending: boolean;
  wakewordStatus: WakewordModelStatusPayload;
}

// Recording mode is the hero control: the four-way switcher that decides how a
// hotkey starts/stops a session, plus the mode-conditional sub-controls
// (Stop-only-on-hotkey for Toggle, Loopback device for Listen, Wake word +
// Sensitivity + Follow-up timeout for Wake Word). Diarization, mute-system-audio
// and the recording-sound chime moved to Model/Output tabs respectively.
function RecordingModeSection({
  audio,
  t,
  ta,
  general,
  recordingMode,
  update,
  updateAudio,
  loopbackOpts,
  currentLoopbackId,
  handleLoopbackChange,
  requestWakewordDownload,
  wakewordEnablePending,
  wakewordStatus,
}: RecordingModeSectionProps): ReactNode {
  const recordingModeOptions = buildRecordingModeOptions(t);
  const manualToggleStop = general?.manualToggleStop ?? false;
  const wakewordControlsLocked =
    !wakewordStatus.available &&
    (wakewordStatus.downloading || recordingMode === "wakeword");
  const showWakewordDownloadProgress =
    !wakewordStatus.available &&
    (wakewordEnablePending ||
      wakewordStatus.downloading ||
      wakewordStatus.phase === "paused" ||
      !!wakewordStatus.error);
  const handleRecordingModeChange = (
    value: "ptt" | "toggle" | "listen" | "wakeword",
  ) => {
    if (
      value === "wakeword" &&
      !wakewordStatus.available &&
      !wakewordStatus.downloading
    ) {
      requestWakewordDownload();
      return;
    }
    update(recordingModePatch(value, general?.wakeWord));
  };
  return (
    <SettingSection icon={RecordIcon} title={t("recording")}>
      <div className="flex flex-col divide-y divide-surface-1">
        <SettingField
          isDefault={recordingMode === DEFAULT_SETTINGS.general.recordingMode}
          label={t("recordingMode")}
          onReset={() =>
            update(
              recordingModePatch(
                DEFAULT_SETTINGS.general.recordingMode,
                general?.wakeWord,
              ),
            )
          }
          tooltip={t("recordingModeTooltip")}
        >
          {/* Hero control — sets the design template for every other
					    interactive group on the tab. Same ElevatedSurface wraps
					    them all so the tab reads as one consistent language. */}
          <ElevatedSurface>
            <Switcher
              fullWidth
              onChange={handleRecordingModeChange}
              options={recordingModeOptions}
              value={recordingMode}
            />
          </ElevatedSurface>
        </SettingField>
        {recordingMode !== "wakeword" && showWakewordDownloadProgress ? (
          <WakewordDownloadProgress status={wakewordStatus} />
        ) : null}
        {recordingMode === "toggle" ? (
          <>
            <ManualToggleStopControl
              enabled={manualToggleStop}
              t={t}
              update={update}
            />
            {!manualToggleStop ? (
              <ToggleSilenceStopControl
                audio={audio}
                t={ta}
                update={updateAudio}
              />
            ) : null}
          </>
        ) : null}
        {recordingMode === "listen" ? (
          <LoopbackControl
            currentLoopbackId={currentLoopbackId}
            handleLoopbackChange={handleLoopbackChange}
            loopbackOpts={loopbackOpts}
            t={t}
          />
        ) : null}
        {recordingMode === "wakeword" ? (
          <>
            <WakeWordControl
              customWakeWords={general?.customWakeWords ?? []}
              disabled={wakewordControlsLocked}
              t={t}
              update={update}
              value={general?.wakeWord ?? ""}
            />
            <WakewordDownloadProgress status={wakewordStatus} />
            <WakeWordSensitivityControl
              disabled={wakewordControlsLocked}
              t={t}
              update={update}
              value={general?.wakeWordSensitivity ?? 0.6}
            />
            <WakeWordTimeoutControl
              disabled={wakewordControlsLocked}
              t={t}
              update={update}
              value={general?.wakeWordTimeout ?? 5}
            />
          </>
        ) : null}
      </div>
    </SettingSection>
  );
}

// ─────────────────────────── Input device ───────────────────────────

interface InputDeviceSectionProps {
  audio: AudioSettings | undefined;
  t: AudioT;
  update: UpdateAudioFn;
}

// Input + clamshell mic. Hidden entirely in Listen mode — there the loopback
// device (above) is captured instead of a microphone.
function InputDeviceSection({
  audio,
  t,
  update,
}: InputDeviceSectionProps): ReactNode {
  const { devices, defaultDevice } = useInputDevices();
  const defaultLabel = defaultDevice
    ? `${t("systemDefault")} (${defaultDevice.name})`
    : t("systemDefault");
  const { deviceOptions, currentDeviceId } = buildInputDeviceOptions(
    devices,
    audio?.inputDeviceIndex ?? null,
    defaultLabel,
    defaultDevice?.name,
  );

  // Clamshell picker shares the device list but uses a "disabled" sentinel
  // instead of "default" — null = feature off (don't poll), whereas a
  // configured index = mic to swap to when the lid closes.
  const { deviceOptions: clamshellDeviceOptions } = buildInputDeviceOptions(
    devices,
    audio?.clamshellMicrophone ?? null,
    defaultLabel,
    defaultDevice?.name,
  );
  const clamshellOptions: SelectOption[] = (() => {
    const opts: SelectOption[] = [
      { id: "disabled", label: t("clamshellDisabled"), icon: MicOff01Icon },
    ];
    opts.push(...clamshellDeviceOptions.filter((o) => o.id !== "default"));
    return opts;
  })();

  const currentClamshellId =
    audio?.clamshellMicrophone == null
      ? "disabled"
      : String(audio.clamshellMicrophone);

  return (
    <SettingSection icon={Mic02Icon} title={t("inputDevice")}>
      <div className="flex flex-col divide-y divide-surface-1">
        <SettingField
          isDefault={currentDeviceId === "default"}
          label={t("device")}
          layout="row"
          onReset={() => update({ inputDeviceIndex: null })}
          tooltip={t("deviceTooltip")}
        >
          <ElevatedSurface className="w-52" inline>
            <Select
              onChange={(v) =>
                update({
                  inputDeviceIndex:
                    v === "default" ? null : Number.parseInt(v, 10),
                })
              }
              options={deviceOptions}
              value={currentDeviceId}
            />
          </ElevatedSurface>
        </SettingField>
        {/* Clamshell mic: auto-swap when the laptop lid closes. The
				    backend watches lid state on supported platforms, and the
				    setting persists across launches. */}
        <SettingField
          isDefault={currentClamshellId === "disabled"}
          label={t("clamshellLabel")}
          layout="row"
          onReset={() => update({ clamshellMicrophone: null })}
          tooltip={t("clamshellTooltip")}
        >
          <ElevatedSurface className="w-52" inline>
            <Select
              onChange={(v) =>
                update({
                  clamshellMicrophone:
                    v === "disabled" ? null : Number.parseInt(v, 10),
                })
              }
              options={clamshellOptions}
              value={currentClamshellId}
            />
          </ElevatedSurface>
        </SettingField>
      </div>
    </SettingSection>
  );
}

// ─────────────────────────── Endpointing ───────────────────────────

interface VadSectionProps {
  audio: AudioSettings | undefined;
  ta: AudioT;
  updateAudio: UpdateAudioFn;
}

// Voice Activity Detection tuning — only surfaced when VAD actually drives
// the endpoint (listen / wakeword). Extracted so the panel root stays under
// the cyclomatic-complexity ceiling.
function VadSection({ audio, ta, updateAudio }: VadSectionProps) {
  return (
    <SettingSection
      icon={VoiceIdIcon}
      onToggle={(v) => updateAudio({ sileroDeactivityDetection: v })}
      title={ta("vad")}
      toggled={audio?.sileroDeactivityDetection ?? true}
    >
      <div className="flex flex-col divide-y divide-surface-1">
        <SettingField
          isDefault={
            (audio?.sileroSensitivity ??
              DEFAULT_SETTINGS.audio.sileroSensitivity) ===
            DEFAULT_SETTINGS.audio.sileroSensitivity
          }
          label={ta("sileroSensitivity")}
          onReset={() =>
            updateAudio({
              sileroSensitivity: DEFAULT_SETTINGS.audio.sileroSensitivity,
            })
          }
          tooltip={ta("sileroSensitivityTooltip")}
        >
          <ElevatedSurface inline>
            <Slider
              aria-label={ta("sileroSensitivity")}
              formatValue={(v) => v.toFixed(2)}
              max={1}
              min={0}
              onChange={(v) => updateAudio({ sileroSensitivity: v })}
              step={0.05}
              value={
                audio?.sileroSensitivity ??
                DEFAULT_SETTINGS.audio.sileroSensitivity
              }
            />
          </ElevatedSurface>
        </SettingField>
        <SettingField
          isDefault={
            (audio?.webrtcSensitivity ??
              DEFAULT_SETTINGS.audio.webrtcSensitivity) ===
            DEFAULT_SETTINGS.audio.webrtcSensitivity
          }
          label={ta("webrtcSensitivity")}
          onReset={() =>
            updateAudio({
              webrtcSensitivity: DEFAULT_SETTINGS.audio.webrtcSensitivity,
            })
          }
          tooltip={ta("webrtcSensitivityTooltip")}
        >
          <ElevatedSurface inline>
            <Slider
              aria-label={ta("webrtcSensitivity")}
              max={3}
              min={0}
              onChange={(v) => updateAudio({ webrtcSensitivity: v })}
              step={1}
              value={
                audio?.webrtcSensitivity ??
                DEFAULT_SETTINGS.audio.webrtcSensitivity
              }
            />
          </ElevatedSurface>
        </SettingField>
        <SettingField
          isDefault={
            (audio?.postSpeechSilenceDuration ??
              DEFAULT_SETTINGS.audio.postSpeechSilenceDuration) ===
            DEFAULT_SETTINGS.audio.postSpeechSilenceDuration
          }
          label={ta("postSpeechSilence")}
          layout="row"
          onReset={() =>
            updateAudio({
              postSpeechSilenceDuration:
                DEFAULT_SETTINGS.audio.postSpeechSilenceDuration,
            })
          }
          tooltip={ta("postSpeechSilenceTooltip")}
        >
          <ElevatedSurface className="w-fit" inline>
            <NumberStepper
              min={0.1}
              onChange={(v) => updateAudio({ postSpeechSilenceDuration: v })}
              step={0.1}
              value={
                audio?.postSpeechSilenceDuration ??
                DEFAULT_SETTINGS.audio.postSpeechSilenceDuration
              }
            />
          </ElevatedSurface>
        </SettingField>
      </div>
    </SettingSection>
  );
}

interface SmartEndpointSectionProps {
  onToggle: (next: boolean) => void;
  q: QualitySettings | undefined;
  t: QualityT;
  update: UpdateQualityFn;
}

function SmartEndpointSection({
  q,
  t,
  update,
  onToggle,
}: SmartEndpointSectionProps) {
  const enabled = q?.smartEndpoint ?? false;
  return (
    <SettingSection icon={Radar02Icon} title={t("smartEndpoint")}>
      <div className="flex flex-col divide-y divide-surface-1">
        <SettingField
          isDefault={enabled === DEFAULT_SETTINGS.quality.smartEndpoint}
          label={t("smartEndpointLabel")}
          labelAddon={<Toggle checked={enabled} onCheckedChange={onToggle} />}
          onReset={() => onToggle(DEFAULT_SETTINGS.quality.smartEndpoint)}
          tooltip={t("smartEndpointTooltip")}
        />
        {/* Detection speed depends on Smart Endpoint being on — shown
				    disabled (not hidden) when off so the option stays discoverable. */}
        <SettingField
          disabled={!enabled}
          disabledReason={t("smartEndpoint")}
          isDefault={
            (q?.smartEndpointSpeed ??
              DEFAULT_SETTINGS.quality.smartEndpointSpeed) ===
            DEFAULT_SETTINGS.quality.smartEndpointSpeed
          }
          label={t("detectionSpeed")}
          layout="row"
          onReset={() =>
            update({
              smartEndpointSpeed: DEFAULT_SETTINGS.quality.smartEndpointSpeed,
            })
          }
          tooltip={t("detectionSpeedTooltip")}
        >
          <ElevatedSurface className="w-fit" inline>
            <NumberStepper
              max={3.0}
              min={0.5}
              onChange={(v) => update({ smartEndpointSpeed: v })}
              step={0.1}
              value={
                q?.smartEndpointSpeed ??
                DEFAULT_SETTINGS.quality.smartEndpointSpeed
              }
            />
          </ElevatedSurface>
        </SettingField>
      </div>
    </SettingSection>
  );
}

interface SentencePauseSectionProps {
  q: QualitySettings | undefined;
  t: QualityT;
  update: UpdateQualityFn;
}

// Sliders that drive the toggle-mode silence-timing heuristic. Surface them
// here (in Endpointing) so users discover them next to Smart Endpoint — they
// are the manual alternative to it.
function SentencePauseSection({ q, t, update }: SentencePauseSectionProps) {
  return (
    <SettingSection icon={PauseCircleIcon} title={t("sentencePauses")}>
      <div className="flex flex-col divide-y divide-surface-1">
        <SettingField
          isDefault={
            (q?.endOfSentenceDetectionPause ??
              DEFAULT_SETTINGS.quality.endOfSentenceDetectionPause) ===
            DEFAULT_SETTINGS.quality.endOfSentenceDetectionPause
          }
          label={t("endOfSentencePause")}
          layout="row"
          onReset={() =>
            update({
              endOfSentenceDetectionPause:
                DEFAULT_SETTINGS.quality.endOfSentenceDetectionPause,
            })
          }
          tooltip={t("endOfSentencePauseTooltip")}
        >
          <ElevatedSurface className="w-fit" inline>
            <NumberStepper
              max={5.0}
              min={0.1}
              onChange={(v) => update({ endOfSentenceDetectionPause: v })}
              step={0.05}
              value={
                q?.endOfSentenceDetectionPause ??
                DEFAULT_SETTINGS.quality.endOfSentenceDetectionPause
              }
            />
          </ElevatedSurface>
        </SettingField>
        <SettingField
          isDefault={
            (q?.unknownSentenceDetectionPause ??
              DEFAULT_SETTINGS.quality.unknownSentenceDetectionPause) ===
            DEFAULT_SETTINGS.quality.unknownSentenceDetectionPause
          }
          label={t("unknownSentencePause")}
          layout="row"
          onReset={() =>
            update({
              unknownSentenceDetectionPause:
                DEFAULT_SETTINGS.quality.unknownSentenceDetectionPause,
            })
          }
          tooltip={t("unknownSentencePauseTooltip")}
        >
          <ElevatedSurface className="w-fit" inline>
            <NumberStepper
              max={5.0}
              min={0.1}
              onChange={(v) => update({ unknownSentenceDetectionPause: v })}
              step={0.05}
              value={
                q?.unknownSentenceDetectionPause ??
                DEFAULT_SETTINGS.quality.unknownSentenceDetectionPause
              }
            />
          </ElevatedSurface>
        </SettingField>
        <SettingField
          isDefault={
            (q?.midSentenceDetectionPause ??
              DEFAULT_SETTINGS.quality.midSentenceDetectionPause) ===
            DEFAULT_SETTINGS.quality.midSentenceDetectionPause
          }
          label={t("midSentencePause")}
          layout="row"
          onReset={() =>
            update({
              midSentenceDetectionPause:
                DEFAULT_SETTINGS.quality.midSentenceDetectionPause,
            })
          }
          tooltip={t("midSentencePauseTooltip")}
        >
          <ElevatedSurface className="w-fit" inline>
            <NumberStepper
              max={10.0}
              min={0.1}
              onChange={(v) => update({ midSentenceDetectionPause: v })}
              step={0.1}
              value={
                q?.midSentenceDetectionPause ??
                DEFAULT_SETTINGS.quality.midSentenceDetectionPause
              }
            />
          </ElevatedSurface>
        </SettingField>
      </div>
    </SettingSection>
  );
}

// ─────────────────────────── Advanced ───────────────────────────

interface AdvancedSectionProps {
  audio: AudioSettings | undefined;
  t: AudioT;
  update: UpdateAudioFn;
}

// Consolidated mic-release picker — a single Select covering the five discrete
// behaviors (always / immediate / 30s / 1m / 5m). The Tauri recorder reads the
// persisted policy live; changing it must not ask for a restart.
function AdvancedSection({
  audio,
  t,
  update,
}: AdvancedSectionProps): ReactNode {
  const microphoneRelease =
    audio?.microphoneRelease ?? DEFAULT_SETTINGS.audio.microphoneRelease;
  const microphoneReleaseOptions: SelectOption[] = [
    { id: "always", label: t("microphoneReleaseAlways"), icon: InfinityIcon },
    {
      id: "immediate",
      label: t("microphoneReleaseImmediate"),
      icon: FlashIcon,
    },
    { id: "sec30", label: t("microphoneReleaseSec30"), icon: Clock01Icon },
    { id: "min1", label: t("microphoneReleaseMin1"), icon: Timer01Icon },
    { id: "min5", label: t("microphoneReleaseMin5"), icon: HourglassIcon },
  ];
  return (
    <SettingSection icon={SlidersHorizontalIcon} title={t("advancedTitle")}>
      <div className="flex flex-col divide-y divide-surface-1">
        <SettingField
          isDefault={
            microphoneRelease === DEFAULT_SETTINGS.audio.microphoneRelease
          }
          label={t("microphoneRelease")}
          layout="row"
          onReset={() =>
            update({
              microphoneRelease: DEFAULT_SETTINGS.audio.microphoneRelease,
            })
          }
          tooltip={t("microphoneReleaseTooltip")}
        >
          <ElevatedSurface className="w-52" inline>
            <Select
              onChange={(v) =>
                update({
                  microphoneRelease: v as
                    | "always"
                    | "immediate"
                    | "sec30"
                    | "min1"
                    | "min5",
                })
              }
              options={microphoneReleaseOptions}
              value={microphoneRelease}
            />
          </ElevatedSurface>
        </SettingField>
      </div>
    </SettingSection>
  );
}

// ─────────────────────────── Panel ───────────────────────────

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
  const tq = useTranslations("quality");

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
