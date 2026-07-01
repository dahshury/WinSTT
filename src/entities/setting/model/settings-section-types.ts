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
 * The ``NonNullable`` wrapper is retained for backwards-compatibility with the
 * historical call sites — the store keeps each section non-optional, so it is a
 * no-op, but the wrapper keeps the resolved type identical to the deleted
 * per-widget copies.
 */
type SettingsStoreState = ReturnType<typeof useSettingsStore.getState>;

export type GeneralSettings = NonNullable<
	SettingsStoreState["settings"]["general"]
>;
export type AudioSettings = NonNullable<
	SettingsStoreState["settings"]["audio"]
>;
export type QualitySettings = NonNullable<
	SettingsStoreState["settings"]["quality"]
>;

export type GeneralT = ReturnType<typeof useTranslations<"general">>;
export type AudioT = ReturnType<typeof useTranslations<"audio">>;
export type QualityT = ReturnType<typeof useTranslations<"quality">>;

export type UpdateGeneralFn = (patch: Partial<GeneralSettings>) => void;
export type UpdateAudioFn = (patch: Partial<AudioSettings>) => void;
export type UpdateQualityFn = (patch: Partial<QualitySettings>) => void;
