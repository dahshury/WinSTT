import { AiSettingIcon, CpuIcon } from "@hugeicons/core-free-icons";
import { resolveEffectiveQuant } from "@picker";
import { providerOf } from "@/entities/cloud-stt-provider";
import type { OnnxQuantization } from "@/shared/config/defaults";
import type { SwitcherOption } from "@/shared/ui/switcher";
import type {
  DeviceValue,
  ElevenIntegration,
  LanguageControlMode,
  ModelControlVisibility,
  StatesById,
  TFn,
  TtsSettings,
} from "./types";

export type { DeviceValue, ModelControlVisibility };

// The Device switch is only ever rendered when a GPU is present (see
// DeviceSection), so it is always the full Auto/CPU pair — Auto picks the
// fastest device per model; CPU is the manual override.
export function buildDeviceOpts(t: TFn): SwitcherOption<DeviceValue>[] {
  return [
    { value: "auto", label: t("deviceAutoLabel"), icon: AiSettingIcon },
    { value: "cpu", label: t("deviceCpuLabel"), icon: CpuIcon },
  ];
}

/** Whether local Kokoro TTS is the active synthesis source. It rides on the
 *  Model-tab compute device (`model.device` → `--tts-device`), so the Device
 *  control must survive a cloud STT selection while this is true. Mirrors
 *  TtsModelSection's effective-source gate (cloud needs a present + verified
 *  ElevenLabs key, else it falls back to local). */
export function isLocalTtsActive(
  tts: TtsSettings | undefined,
  elevenlabs: ElevenIntegration,
): boolean {
  const cloudEffective =
    (tts?.source ?? "local") === "cloud" &&
    elevenlabs.apiKey.trim().length > 0 &&
    elevenlabs.verified === true;
  return (tts?.enabled ?? false) && !cloudEffective;
}

/** Which Model-tab controls stay visible for the active main model. A cloud
 *  main hides the STT-local knobs: language (the provider owns it) and
 *  idle-unload-timeout (no local session to unload). `showDevice` is different —
 *  it gates the STANDALONE {@link DeviceSection}, not an STT sub-control, and is
 *  true whenever ANY local model needs a device: a local STT main OR local
 *  Kokoro TTS (both share `model.device`). It only disappears when STT and TTS
 *  are both cloud. A single-language local model also hides language
 *  (auto-detect + one language is a no-op choice). */
export function resolveModelControlVisibility(
  selectedIsCloud: boolean,
  languageControlMode: LanguageControlMode,
  localTtsActive: boolean,
): ModelControlVisibility {
  return {
    showLanguage: !selectedIsCloud && languageControlMode !== "hidden",
    showDevice: !selectedIsCloud || localTtsActive,
  };
}

export function localModelIdOrNull(
  modelId: string | undefined,
  enabled = true,
): string | null {
  if (!enabled || !modelId || providerOf(modelId) !== null) {
    return null;
  }
  return modelId;
}

export function quantForFit(
  statesById: StatesById,
  modelId: string | null,
  currentQuantization: OnnxQuantization,
): string {
  return modelId
    ? resolveEffectiveQuant(statesById[modelId], currentQuantization)
    : "";
}

export function requestedDeviceForFit(deviceValue: DeviceValue): string | null {
  return deviceValue === "cpu" ? "cpu" : null;
}
