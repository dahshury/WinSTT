import type { FitAssessmentEntry } from "@/shared/api/ipc-client";
import type { useSettingsStore } from "@/entities/setting";
import type { TranslateFn } from "@/shared/i18n/translation-types";
export type {
	CatalogModels,
	ModelStatesById as StatesById,
	ModelSystemInfo as SystemInfo,
} from "@/entities/model-catalog";

export type TFn = TranslateFn;

export type SettingsStoreState = ReturnType<typeof useSettingsStore.getState>;
export type GlobalSettings = SettingsStoreState["settings"]["global"];
export type ModelSettings = SettingsStoreState["settings"]["model"];
export type QualitySettings = SettingsStoreState["settings"]["quality"];
export type UpdateGlobalFn = SettingsStoreState["updateGlobalSettings"];
export type UpdateModelFn = SettingsStoreState["updateModelSettings"];
export type UpdateQualityFn = SettingsStoreState["updateQualitySettings"];
export type ModelUnloadTimeoutValue = GlobalSettings["modelUnloadTimeout"];

export type DeviceValue = "auto" | "cpu";
export type LanguageControlMode =
	| "hidden"
	| "single"
	| "auto"
	| "candidate-auto";
export type GetFitAssessment = (modelId: string) => FitAssessmentEntry | null;

export type TtsSettings = SettingsStoreState["settings"]["tts"];
export type ElevenIntegration =
	SettingsStoreState["settings"]["integrations"]["elevenlabs"];

export interface ModelControlVisibility {
	showDevice: boolean;
	showLanguage: boolean;
	showLifetime: boolean;
}
