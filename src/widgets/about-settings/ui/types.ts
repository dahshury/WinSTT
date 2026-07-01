import type { useTranslations } from "use-intl";

export type { GeneralSettings, GeneralT } from "@/entities/setting";
// ``UpdateFn`` is this widget's local name for the shared general update-fn.
export type { UpdateGeneralFn as UpdateFn } from "@/entities/setting";

export type AboutT = ReturnType<typeof useTranslations<"about">>;
