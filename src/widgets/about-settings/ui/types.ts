import type { useTranslations } from "use-intl";
import type { useSettingsStore } from "@/entities/setting";

export type AboutT = ReturnType<typeof useTranslations<"about">>;
export type GeneralT = ReturnType<typeof useTranslations<"general">>;
export type GeneralSettings = NonNullable<
	ReturnType<typeof useSettingsStore.getState>["settings"]["general"]
>;
export type UpdateFn = (patch: Partial<GeneralSettings>) => void;
