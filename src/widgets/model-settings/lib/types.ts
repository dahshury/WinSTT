import type { FitAssessmentEntry } from "@/shared/api/ipc-client";
import type { useCatalogStore, useModelStateStore } from "@/entities/model-catalog";
import type { useSettingsStore } from "@/entities/setting";
import type { useTranslations } from "use-intl";

export type TFn = ReturnType<typeof useTranslations>;

export type SettingsStoreState = ReturnType<typeof useSettingsStore.getState>;
export type GlobalSettings = SettingsStoreState["settings"]["global"];
export type ModelSettings = SettingsStoreState["settings"]["model"];
export type QualitySettings = SettingsStoreState["settings"]["quality"];
export type UpdateGlobalFn = SettingsStoreState["updateGlobalSettings"];
export type UpdateModelFn = SettingsStoreState["updateModelSettings"];
export type UpdateQualityFn = SettingsStoreState["updateQualitySettings"];
export type ModelUnloadTimeoutValue = GlobalSettings["modelUnloadTimeout"];

export type DeviceValue = "auto" | "cpu";
export type LanguageControlMode = "hidden" | "single" | "auto" | "candidate-auto";
export type CatalogModels = ReturnType<typeof useCatalogStore.getState>["models"];
export type StatesById = ReturnType<typeof useModelStateStore.getState>["statesById"];
export type SystemInfo = ReturnType<typeof useModelStateStore.getState>["systemInfo"];
export type GetFitAssessment = (modelId: string) => FitAssessmentEntry | null;

export type TtsSettings = SettingsStoreState["settings"]["tts"];
export type ElevenIntegration =
  SettingsStoreState["settings"]["integrations"]["elevenlabs"];

export interface ModelControlVisibility {
  showDevice: boolean;
  showLanguage: boolean;
}
