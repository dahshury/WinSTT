import type { useTranslations } from "use-intl";

export type { GeneralSettings, GeneralT } from "@/entities/setting";
export type { UpdateGeneralFn as UpdateFn } from "@/entities/setting";

export type AboutT = ReturnType<typeof useTranslations<"about">>;
