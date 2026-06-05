import {
  ArrowTurnDownIcon,
  BellRingIcon,
  ClipboardPasteIcon,
  ComputerIcon,
  FileScriptIcon,
  HeadphonesIcon,
  KeyboardIcon,
  Speaker01Icon,
  SubtitleIcon,
  Txt01Icon,
  VolumeMinusIcon,
} from "@hugeicons/core-free-icons";
import { type ReactNode, useState } from "react";
import { useTranslations } from "use-intl";
import { useOutputDevices } from "@/entities/audio-device";
import { providerOf } from "@/entities/cloud-stt-provider";
import {
  isSelectableRealtimeModel,
  useCatalogStore,
} from "@/entities/model-catalog";
import {
  DEFAULT_SETTINGS,
  SettingField,
  SettingSection,
  useSettingsStore,
} from "@/entities/setting";
import { SoundLibrary } from "@/features/recording-sound";
import { cn } from "@/shared/lib/cn";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { Select, type SelectOption } from "@/shared/ui/select";
import { Slider } from "@/shared/ui/slider";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";

const REDUCTION_STEPS = [0, 20, 40, 60, 80, 100] as const;

function reductionToIndex(pct: number): number {
  const idx = REDUCTION_STEPS.indexOf(pct as (typeof REDUCTION_STEPS)[number]);
  return idx === -1 ? 0 : idx;
}

function indexToReduction(index: number): number {
  return REDUCTION_STEPS[index] ?? 0;
}

type GeneralT = ReturnType<typeof useTranslations<"general">>;
type GeneralSettings = NonNullable<
  ReturnType<typeof useSettingsStore.getState>["settings"]["general"]
>;
type UpdateGeneralFn = (patch: Partial<GeneralSettings>) => void;

function reductionStepLabel(pct: number, t: GeneralT): string {
  if (pct <= 0) {
    return t("systemAudioReductionOff");
  }
  return pct >= 100 ? t("systemAudioReductionMute") : `${pct}%`;
}

function muteLevel(settings: GeneralSettings | undefined): number {
  return settings?.systemAudioReductionWhileDictating ?? 0;
}

const TRANSCRIPTION_FORMAT_OPTIONS: readonly SwitcherOption<"txt" | "srt">[] = [
  { value: "txt", label: "TXT", icon: Txt01Icon },
  { value: "srt", label: "SRT", icon: SubtitleIcon },
] as const;

interface PasteBehaviorSectionProps {
  autoSubmit: boolean;
  autoSubmitKey: "enter" | "ctrl_enter";
  autoSubmitKeyOptions: SwitcherOption<"enter" | "ctrl_enter">[];
  previewBeforePasting: boolean;
  previewBeforePastingDisabled: boolean;
  previewBeforePastingDisabledReason: string;
  wordByWordPasting: boolean;
  wordByWordPastingDisabled: boolean;
  wordByWordPastingDisabledReason: string;
  onChangeAutoSubmit: (next: boolean) => void;
  onChangeAutoSubmitKey: (next: "enter" | "ctrl_enter") => void;
  onChangePreviewBeforePasting: (next: boolean) => void;
  onChangeWordByWordPasting: (next: boolean) => void;
  tg: GeneralT;
}

function PasteBehaviorSection({
  autoSubmit,
  autoSubmitKey,
  autoSubmitKeyOptions,
  previewBeforePasting,
  previewBeforePastingDisabled,
  previewBeforePastingDisabledReason,
  wordByWordPasting,
  wordByWordPastingDisabled,
  wordByWordPastingDisabledReason,
  onChangeAutoSubmit,
  onChangeAutoSubmitKey,
  onChangePreviewBeforePasting,
  onChangeWordByWordPasting,
  tg,
}: PasteBehaviorSectionProps): ReactNode {
  return (
    <SettingSection
      divided
      icon={ClipboardPasteIcon}
      title={tg("pasteBehaviorTitle")}
    >
      <SettingField
        defaultValue={DEFAULT_SETTINGS.general.autoSubmit}
        label={tg("autoSubmit")}
        labelAddon={
          <Toggle checked={autoSubmit} onCheckedChange={onChangeAutoSubmit} />
        }
        onReset={() => onChangeAutoSubmit(DEFAULT_SETTINGS.general.autoSubmit)}
        tooltip={tg("autoSubmitTooltip")}
        value={autoSubmit}
      />
      <SettingField
        defaultValue={DEFAULT_SETTINGS.general.autoSubmitKey}
        disabled={!autoSubmit}
        disabledReason={tg("autoSubmit")}
        label={tg("autoSubmitKey")}
        layout="row"
        onReset={() =>
          onChangeAutoSubmitKey(DEFAULT_SETTINGS.general.autoSubmitKey)
        }
        tooltip={tg("autoSubmitKeyTooltip")}
        value={autoSubmitKey}
      >
        <ElevatedSurface className="w-72 max-w-full">
          <Switcher
            fullWidth
            onChange={onChangeAutoSubmitKey}
            options={autoSubmitKeyOptions}
            value={autoSubmitKey}
          />
        </ElevatedSurface>
      </SettingField>
      <SettingField
        defaultValue={DEFAULT_SETTINGS.general.previewBeforePasting}
        disabled={previewBeforePastingDisabled}
        disabledReason={previewBeforePastingDisabledReason}
        label={tg("previewBeforePasting")}
        labelAddon={
          <Toggle
            checked={previewBeforePasting}
            disabled={previewBeforePastingDisabled}
            onCheckedChange={onChangePreviewBeforePasting}
          />
        }
        onReset={() =>
          onChangePreviewBeforePasting(
            DEFAULT_SETTINGS.general.previewBeforePasting,
          )
        }
        tooltip={tg("previewBeforePastingTooltip")}
        value={previewBeforePasting}
      />
      <SettingField
        defaultValue={DEFAULT_SETTINGS.general.wordByWordPasting}
        disabled={wordByWordPastingDisabled}
        disabledReason={wordByWordPastingDisabledReason}
        label={tg("wordByWordPasting")}
        labelAddon={
          <Toggle
            checked={wordByWordPasting}
            disabled={wordByWordPastingDisabled}
            onCheckedChange={onChangeWordByWordPasting}
          />
        }
        onReset={() =>
          onChangeWordByWordPasting(DEFAULT_SETTINGS.general.wordByWordPasting)
        }
        tooltip={tg("wordByWordPastingTooltip")}
        value={wordByWordPasting}
      />
    </SettingSection>
  );
}

interface MuteSystemAudioControlProps {
  general: GeneralSettings | undefined;
  t: GeneralT;
  update: UpdateGeneralFn;
}

function MuteSystemAudioControl({
  general,
  t,
  update,
}: MuteSystemAudioControlProps): ReactNode {
  const level = muteLevel(general);
  return (
    <SettingField
      defaultValue={DEFAULT_SETTINGS.general.systemAudioReductionWhileDictating}
      label={t("muteSystemAudio")}
      onReset={() =>
        update({
          systemAudioReductionWhileDictating:
            DEFAULT_SETTINGS.general.systemAudioReductionWhileDictating,
        })
      }
      tooltip={t("muteSystemAudioTooltip")}
      value={level}
    >
      <ElevatedSurface inline>
        <Slider
          aria-label={t("muteSystemAudio")}
          formatValue={(v) => reductionStepLabel(indexToReduction(v), t)}
          max={REDUCTION_STEPS.length - 1}
          min={0}
          onChange={(v) =>
            update({ systemAudioReductionWhileDictating: indexToReduction(v) })
          }
          step={1}
          value={reductionToIndex(level)}
        />
      </ElevatedSurface>
    </SettingField>
  );
}

export function OutputSettingsPanel(): ReactNode {
  const general = useSettingsStore((s) => s.settings.general);
  const model = useSettingsStore((s) => s.settings.model);
  const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
  const updateLlmDictation = useSettingsStore((s) => s.updateLlmDictation);
  const tg = useTranslations("general");
  const tc = useTranslations("common");
  const getModel = useCatalogStore((s) => s.getModel);
  const [confirmWordByWordOpen, setConfirmWordByWordOpen] = useState(false);

  const autoSubmit = general?.autoSubmit ?? false;
  const autoSubmitKey = general?.autoSubmitKey ?? "enter";
  const llmDictationEnabled = useSettingsStore(
    (s) => s.settings.llm.dictation.enabled,
  );
  const wordByWordPasting = general?.wordByWordPasting ?? false;
  const previewBeforePasting = wordByWordPasting
    ? false
    : (general?.previewBeforePasting ?? false);
  const pillOff =
    !(general?.showRecordingOverlay ?? true) ||
    (general?.overlayPosition ?? "auto") === "none";
  const selectedModel = model?.model ?? DEFAULT_SETTINGS.model.model;
  const selectedInfo =
    providerOf(selectedModel) === null ? getModel(selectedModel) : undefined;
  const mainModelCanNativeStream =
    selectedInfo !== undefined && isSelectableRealtimeModel(selectedInfo);
  const previewBeforePastingDisabled = pillOff || wordByWordPasting;
  const previewBeforePastingDisabledReason = wordByWordPasting
    ? tg("wordByWordPasting")
    : tg("showRecordingOverlay");
  const wordByWordPastingDisabled =
    !mainModelCanNativeStream || previewBeforePasting;
  const wordByWordPastingDisabledReason = previewBeforePasting
    ? tg("previewBeforePasting")
    : tg("wordByWordPastingRequirement");
  const autoSubmitKeyOptions: SwitcherOption<"enter" | "ctrl_enter">[] = [
    {
      value: "enter",
      label: tg("autoSubmitKeyEnter"),
      icon: ArrowTurnDownIcon,
    },
    {
      value: "ctrl_enter",
      label: tg("autoSubmitKeyCtrlEnter"),
      icon: KeyboardIcon,
    },
  ];
  const transcriptionFormat = general?.fileTranscriptionFormat ?? "txt";

  const enableWordByWordPasting = () => {
    updateLlmDictation({ enabled: false });
    updateGeneral({ wordByWordPasting: true, previewBeforePasting: false });
  };

  const handleWordByWordPastingChange = (next: boolean) => {
    if (!next) {
      updateGeneral({ wordByWordPasting: false });
      return;
    }
    if (llmDictationEnabled) {
      setConfirmWordByWordOpen(true);
      return;
    }
    enableWordByWordPasting();
  };

  const confirmWordByWordPasting = () => {
    enableWordByWordPasting();
    setConfirmWordByWordOpen(false);
  };

  return (
    <>
      <div className="flex flex-col gap-2">
        <PasteBehaviorSection
          autoSubmit={autoSubmit}
          autoSubmitKey={autoSubmitKey}
          autoSubmitKeyOptions={autoSubmitKeyOptions}
          onChangeAutoSubmit={(v) => updateGeneral({ autoSubmit: v })}
          onChangeAutoSubmitKey={(v) => updateGeneral({ autoSubmitKey: v })}
          onChangePreviewBeforePasting={(v) =>
            updateGeneral(
              v
                ? { previewBeforePasting: true, wordByWordPasting: false }
                : { previewBeforePasting: false },
            )
          }
          onChangeWordByWordPasting={handleWordByWordPastingChange}
          previewBeforePastingDisabled={previewBeforePastingDisabled}
          previewBeforePastingDisabledReason={
            previewBeforePastingDisabledReason
          }
          previewBeforePasting={previewBeforePasting}
          tg={tg}
          wordByWordPasting={wordByWordPasting}
          wordByWordPastingDisabled={wordByWordPastingDisabled}
          wordByWordPastingDisabledReason={wordByWordPastingDisabledReason}
        />

        <SettingSection
          divided
          icon={FileScriptIcon}
          title={tg("fileTranscription")}
        >
          <SettingField
            defaultValue={DEFAULT_SETTINGS.general.fileTranscriptionFormat}
            label={tg("fileTranscriptionFormat")}
            layout="row"
            onReset={() =>
              updateGeneral({
                fileTranscriptionFormat:
                  DEFAULT_SETTINGS.general.fileTranscriptionFormat,
              })
            }
            tooltip={tg("fileTranscriptionFormatTooltip")}
            value={transcriptionFormat}
          >
            <ElevatedSurface className="w-52">
              <Switcher
                fullWidth
                onChange={(v) => updateGeneral({ fileTranscriptionFormat: v })}
                options={TRANSCRIPTION_FORMAT_OPTIONS}
                value={transcriptionFormat}
              />
            </ElevatedSurface>
          </SettingField>
        </SettingSection>
      </div>
      <ConfirmDialog
        cancelLabel={tc("cancel")}
        confirmLabel={tg("wordByWordDisablePostProcessingConfirm")}
        description={tg("wordByWordDisablePostProcessingDescription")}
        onConfirm={confirmWordByWordPasting}
        onOpenChange={setConfirmWordByWordOpen}
        open={confirmWordByWordOpen}
        title={tg("wordByWordDisablePostProcessingTitle")}
      />
    </>
  );
}

export function PlaybackSettingsPanel(): ReactNode {
  const general = useSettingsStore((s) => s.settings.general);
  const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
  const tg = useTranslations("general");
  const ta = useTranslations("audio");
  const tc = useTranslations("common");
  const ts = useTranslations("settings");
  const tt = useTranslations("tts");

  const recordingMode = general?.recordingMode ?? "ptt";
  const isListenMode = recordingMode === "listen";
  const outputDeviceId = useSettingsStore(
    (s) => s.settings.general?.outputDeviceId ?? "",
  );
  const recordingSoundEnabled = useSettingsStore(
    (s) => s.settings.general?.recordingSound ?? true,
  );
  const ttsEnabled = useSettingsStore((s) => s.settings.tts?.enabled ?? false);
  const { devices: outputDevices, defaultDevice: defaultOutputDevice } =
    useOutputDevices();
  const showOutputDevice = recordingSoundEnabled || ttsEnabled;
  const outputDeviceOptions: SelectOption[] = (() => {
    const defaultLabel = defaultOutputDevice
      ? `${ta("systemDefault")} (${defaultOutputDevice.label})`
      : ta("systemDefault");
    const opts: SelectOption[] = [
      { id: "", label: defaultLabel, icon: ComputerIcon },
    ];
    for (const d of outputDevices) {
      if (d.deviceId === "default" || d.deviceId === "") {
        continue;
      }
      opts.push({ id: d.deviceId, label: d.label, icon: Speaker01Icon });
    }
    return opts;
  })();

  return (
    <div className="flex flex-col gap-2">
      <SettingSection divided icon={HeadphonesIcon} title={ta("outputDevice")}>
        <SettingField
          defaultValue={DEFAULT_SETTINGS.general.outputDeviceId}
          disabled={!showOutputDevice}
          disabledReason={`${tg("recordingSound")} / ${tt("title")}`}
          label={ta("outputDevice")}
          layout="row"
          onReset={() =>
            updateGeneral({
              outputDeviceId: DEFAULT_SETTINGS.general.outputDeviceId,
            })
          }
          tooltip={ta("outputDeviceTooltip")}
          value={outputDeviceId}
        >
          <ElevatedSurface className="w-52" inline>
            <Select
              onChange={(v) => updateGeneral({ outputDeviceId: v })}
              options={outputDeviceOptions}
              value={outputDeviceId}
            />
          </ElevatedSurface>
        </SettingField>
      </SettingSection>

      {isListenMode ? null : (
        <SettingSection
          divided
          icon={BellRingIcon}
          title={tg("recordingSound")}
        >
          <SettingField
            defaultValue={DEFAULT_SETTINGS.general.recordingSoundPath}
            hideReset={!recordingSoundEnabled}
            label={tg("recordingSound")}
            labelAddon={
              <Toggle
                checked={recordingSoundEnabled}
                onCheckedChange={(v) => updateGeneral({ recordingSound: v })}
              />
            }
            onReset={() =>
              updateGeneral({
                recordingSoundPath: DEFAULT_SETTINGS.general.recordingSoundPath,
              })
            }
            tooltip={
              recordingSoundEnabled
                ? tg("soundLibraryTooltip")
                : `${tg("soundLibraryTooltip")} ${ts("disabledReason", { name: tg("recordingSound") })}`
            }
            value={general?.recordingSoundPath ?? ""}
          >
            <div
              className={cn(
                "transition-opacity duration-200 ease-out",
                !recordingSoundEnabled && "pointer-events-none opacity-40",
              )}
            >
              <SoundLibrary t={tg} tCommon={tc} />
            </div>
          </SettingField>
        </SettingSection>
      )}

      {isListenMode ? null : (
        <SettingSection
          divided
          icon={VolumeMinusIcon}
          title={tg("muteSystemAudio")}
        >
          <MuteSystemAudioControl
            general={general}
            t={tg}
            update={updateGeneral}
          />
        </SettingSection>
      )}
    </div>
  );
}
