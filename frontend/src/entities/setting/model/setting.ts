import type { components } from "@spec/schema";
import { type AppSettingsOutput, appSettingsSchema } from "@/shared/config/settings-schema";

export type AppSettings = components["schemas"]["AppSettings"];
export type ModelSettings = components["schemas"]["ModelSettings"];
export type QualitySettings = components["schemas"]["QualitySettings"];
export type AudioSettings = components["schemas"]["AudioSettings"];
export type GeneralSettings = components["schemas"]["GeneralSettings"];
export type HotkeySettings = components["schemas"]["HotkeySettings"];
export type DictionaryEntry = components["schemas"]["DictionaryEntry"];
export type SnippetEntry = components["schemas"]["SnippetEntry"];

/**
 * Default settings derived from the Zod schema. Single source of truth
 * for all default values — no manual duplication.
 */
export const DEFAULT_SETTINGS: AppSettingsOutput = appSettingsSchema.parse({});
