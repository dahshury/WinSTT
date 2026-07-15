import type { useTranslations } from "use-intl";
import type { useSettingsStore } from "./settings-store";

/**
 * Store-derived section types — single source of truth.
 *
 * Every settings widget panel previously re-declared this same
 * ``NonNullable<ReturnType<typeof useSettingsStore.getState>["settings"][K]>``
 * triplet (section value + ``use-intl`` namespace + update-fn). Those verbatim
 * copies are collapsed here and re-exported from ``@/entities/setting``.
 *
 */
type SettingsStoreState = ReturnType<typeof useSettingsStore.getState>;

export type GeneralSettings = SettingsStoreState["settings"]["general"];
export type AudioSettings = SettingsStoreState["settings"]["audio"];
export type QualitySettings = SettingsStoreState["settings"]["quality"];

export type GeneralT = ReturnType<typeof useTranslations<"general">>;
export type AudioT = ReturnType<typeof useTranslations<"audio">>;
export type QualityT = ReturnType<typeof useTranslations<"quality">>;

export type UpdateGeneralFn = (patch: Partial<GeneralSettings>) => void;
export type UpdateAudioFn = (patch: Partial<AudioSettings>) => void;
export type UpdateQualityFn = (patch: Partial<QualitySettings>) => void;
