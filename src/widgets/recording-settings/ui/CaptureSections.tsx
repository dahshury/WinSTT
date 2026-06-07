import {
  BellRingIcon,
  Mic02Icon,
  MicOff01Icon,
  VoiceIdIcon,
} from "@hugeicons/core-free-icons";
import { useState, type ReactNode } from "react";
import {
  buildInputDeviceOptions,
  MicrophoneLevelMeter,
  useInputDevices,
  useMicrophoneLevels,
} from "@/entities/audio-device";
import {
  DEFAULT_SETTINGS,
  SettingField,
  SettingSection,
} from "@/entities/setting";
import { SoundLibrary } from "@/features/recording-sound";
import { cn } from "@/shared/lib/cn";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { Select, type SelectOption } from "@/shared/ui/select";
import { Slider } from "@/shared/ui/slider";
import { Toggle } from "@/shared/ui/toggle";
import type {
  AudioSettings,
  AudioT,
  CommonT,
  GeneralSettings,
  GeneralT,
  SettingsT,
  UpdateAudioFn,
  UpdateGeneralFn,
} from "./recording-settings-types";

interface RecordingSoundSectionProps {
  enabled: boolean;
  general: GeneralSettings | undefined;
  t: GeneralT;
  tCommon: CommonT;
  tSettings: SettingsT;
  update: UpdateGeneralFn;
}

export function RecordingSoundSection({
  enabled,
  general,
  t,
  tCommon,
  tSettings,
  update,
}: RecordingSoundSectionProps): ReactNode {
  return (
    <SettingSection divided icon={BellRingIcon} title={t("recordingSound")}>
      <SettingField
        defaultValue={DEFAULT_SETTINGS.general.recordingSoundPath}
        hideReset={!enabled}
        label={t("recordingSound")}
        labelAddon={
          <Toggle
            checked={enabled}
            onCheckedChange={(v) => update({ recordingSound: v })}
          />
        }
        onReset={() =>
          update({
            recordingSoundPath: DEFAULT_SETTINGS.general.recordingSoundPath,
          })
        }
        tooltip={
          enabled
            ? t("soundLibraryTooltip")
            : `${t("soundLibraryTooltip")} ${tSettings("disabledReason", { name: t("recordingSound") })}`
        }
        value={general?.recordingSoundPath ?? ""}
      >
        <div
          className={cn(
            "transition-opacity duration-200 ease-out",
            !enabled && "pointer-events-none opacity-40",
          )}
        >
          <SoundLibrary t={t} tCommon={tCommon} />
        </div>
      </SettingField>
    </SettingSection>
  );
}

interface InputDeviceSectionProps {
  audio: AudioSettings | undefined;
  t: AudioT;
  update: UpdateAudioFn;
}

// Input + clamshell mic. Hidden entirely in Listen mode — there the loopback
// device (above) is captured instead of a microphone.
export function InputDeviceSection({
  audio,
  t,
  update,
}: InputDeviceSectionProps): ReactNode {
  const { devices, defaultDevice } = useInputDevices();
  const [deviceSelectOpen, setDeviceSelectOpen] = useState(false);
  const defaultLabel = defaultDevice
    ? `${t("systemDefault")} (${defaultDevice.name})`
    : t("systemDefault");
  const { deviceOptions, currentDeviceId } = buildInputDeviceOptions(
    devices,
    audio?.inputDeviceIndex ?? null,
    defaultLabel,
    defaultDevice?.name,
  );
  const levels = useMicrophoneLevels(
    deviceSelectOpen,
    deviceOptions.map((option) => option.id),
  );
  const meteredDeviceOptions: SelectOption[] = deviceOptions.map((option) => ({
    ...option,
    trailing: (
      <MicrophoneLevelMeter
        active={option.id === currentDeviceId}
        level={levels[option.id] ?? 0}
      />
    ),
  }));

  // Clamshell picker shares the device list but uses a "disabled" sentinel
  // instead of "default" — null = feature off (don't poll), whereas a
  // configured index = mic to swap to when the lid closes.
  const [clamshellSelectOpen, setClamshellSelectOpen] = useState(false);
  const { deviceOptions: clamshellDeviceOptions } = buildInputDeviceOptions(
    devices,
    audio?.clamshellMicrophone ?? null,
    defaultLabel,
    defaultDevice?.name,
  );
  const currentClamshellId =
    audio?.clamshellMicrophone == null
      ? "disabled"
      : String(audio.clamshellMicrophone);

  // Same live VU meters as the main device picker. Clamshell never offers the
  // "system default" row (it must name a concrete mic to swap to), so only the
  // real device rows are listed and metered.
  const clamshellDeviceRows = clamshellDeviceOptions.filter(
    (option) => option.id !== "default",
  );
  const clamshellLevels = useMicrophoneLevels(
    clamshellSelectOpen,
    clamshellDeviceRows.map((option) => option.id),
  );
  const clamshellOptions: SelectOption[] = [
    { id: "disabled", label: t("clamshellDisabled"), icon: MicOff01Icon },
    ...clamshellDeviceRows.map((option) => ({
      ...option,
      trailing: (
        <MicrophoneLevelMeter
          active={option.id === currentClamshellId}
          level={clamshellLevels[option.id] ?? 0}
        />
      ),
    })),
  ];

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
              onOpenChange={setDeviceSelectOpen}
              options={meteredDeviceOptions}
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
              onOpenChange={setClamshellSelectOpen}
              options={clamshellOptions}
              value={currentClamshellId}
            />
          </ElevatedSurface>
        </SettingField>
      </div>
    </SettingSection>
  );
}

interface VadSectionProps {
  audio: AudioSettings | undefined;
  ta: AudioT;
  updateAudio: UpdateAudioFn;
}

// Voice Activity Detection tuning — only surfaced when VAD actually drives
// the endpoint (listen / wakeword). Extracted so the panel root stays under
// the cyclomatic-complexity ceiling.
export function VadSection({ audio, ta, updateAudio }: VadSectionProps) {
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
