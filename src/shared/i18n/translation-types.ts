import type { useTranslations } from "use-intl";

export type TranslateFn = ReturnType<typeof useTranslations>;
export type SettingsTranslateFn = ReturnType<
	typeof useTranslations<"settings">
>;
export type StatusBarTranslateFn = ReturnType<
	typeof useTranslations<"statusBar">
>;
