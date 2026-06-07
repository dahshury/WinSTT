import type { useTranslations } from "use-intl";
import type { OllamaPullProgress } from "@/shared/api/models";
import { pullStatusToI18nKey } from "../lib/dialog-helpers";

export type TranslateFn = ReturnType<typeof useTranslations>;

export function localizePullStatus(
	progress: OllamaPullProgress,
	t: TranslateFn,
): string {
	// pullStatusToI18nKey returns a string key that is always valid in the "llm" namespace.
	// We cast through unknown to satisfy next-intl's strict key type.
	return t(pullStatusToI18nKey(progress.status) as Parameters<TranslateFn>[0]);
}
