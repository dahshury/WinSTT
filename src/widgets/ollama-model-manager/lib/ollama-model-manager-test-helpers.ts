import type { useTranslations } from "use-intl";

type TranslateFn = ReturnType<typeof useTranslations>;
type Tab = "installed" | "recommended";

export function buildTabOptions(t: TranslateFn) {
	return [
		{ value: "installed" as Tab, label: t("tabInstalled") },
		{ value: "recommended" as Tab, label: t("tabRecommended") },
	] as const;
}

/**
 * Creates a standalone handlePull function bound to the given pullModel and onModelInstalled.
 * Exported for unit testing — avoids relying on Base UI tab-switch in happy-dom.
 */
export function createHandlePull(
	pullModel: (name: string) => Promise<{ success: boolean }>,
	onModelInstalled?: (name: string) => void,
) {
	return async (name: string) => {
		const result = await pullModel(name);
		if (result.success && onModelInstalled) {
			onModelInstalled(name);
		}
	};
}
