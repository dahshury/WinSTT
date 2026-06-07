import type { useTranslations } from "use-intl";
import type { useSettingsStore } from "@/entities/setting";
import type { WakewordModelStatusPayload } from "@/shared/api/ipc-client";

export type GeneralT = ReturnType<typeof useTranslations<"general">>;
export type AudioT = ReturnType<typeof useTranslations<"audio">>;
export type CommonT = ReturnType<typeof useTranslations<"common">>;
export type QualityT = ReturnType<typeof useTranslations<"quality">>;
export type SettingsT = ReturnType<typeof useTranslations<"settings">>;
export type GeneralSettings = NonNullable<
  ReturnType<typeof useSettingsStore.getState>["settings"]["general"]
>;
export type AudioSettings = NonNullable<
  ReturnType<typeof useSettingsStore.getState>["settings"]["audio"]
>;
export type QualitySettings = NonNullable<
  ReturnType<typeof useSettingsStore.getState>["settings"]["quality"]
>;
export type UpdateGeneralFn = (patch: Partial<GeneralSettings>) => void;
export type UpdateAudioFn = (patch: Partial<AudioSettings>) => void;
export type UpdateQualityFn = (patch: Partial<QualitySettings>) => void;

export const SILENCE_STOP_MIN_SECONDS = 0.1;
export const SILENCE_STOP_MAX_SECONDS = 10;
export const SILENCE_STOP_STEP_SECONDS = 0.1;
export const WAKEWORD_DOWNLOAD_SIZE_LABEL = "about 17 MB";
export const WAKEWORD_MODEL_DISABLED_REASON = "wake word model download";
export const WAKEWORD_MODEL_STATUS_DEFAULT: WakewordModelStatusPayload = {
  available: false,
  downloading: false,
  phase: "idle",
};

export function roundSilenceStopSeconds(value: number): number {
  return Number(
    (
      Math.round(value / SILENCE_STOP_STEP_SECONDS) * SILENCE_STOP_STEP_SECONDS
    ).toFixed(1),
  );
}
