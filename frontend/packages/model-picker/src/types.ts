/**
 * Public type contract for `@winstt/model-picker`.
 *
 * The package is intentionally framework-agnostic at the model-shape level:
 * consumers pass in their own `Model` type and the renderer treats it
 * structurally. The only hard couplings are React, Base UI, Hugeicons, virtua,
 * and fuse.js — all declared as peer deps in `package.json`.
 */

/**
 * Minimal translation function shape. Consumers wire this to next-intl,
 * i18next, lingui, or any other i18n lib. When omitted, the package's
 * defaults (English) are used.
 */
export type TranslateFn = (key: string) => string;

/**
 * Identity translate — returns the key as-is. Useful as a safe default for
 * consumers that don't wire i18n.
 */
export const identityTranslate: TranslateFn = (key) => key;

/**
 * Bag of localized strings the picker UI surfaces. Every key has an English
 * default; consumers can override any subset by passing a `t` function or a
 * partial `labels` object.
 */
export interface PickerLabels {
	emptyNoModelsBody: string;
	emptyNoModelsTitle: string;
	emptyUnreachableBody: string;
	emptyUnreachableTitle: string;
	endpointProviderFilter: string;
	filtersLabel: string;
	hostingProviders: string;
	parametersFilter: string;
	pricingPerMillion: string;
	pricingTooltipFree: string;
	searchPlaceholder: string;
	triggerLabel: string;
	variantFilter: string;
}

/** English defaults used when a key is missing from the consumer-provided `t`. */
export const DEFAULT_LABELS: PickerLabels = {
	emptyNoModelsBody: "Try adjusting your filters to see more results.",
	emptyNoModelsTitle: "No models found",
	emptyUnreachableBody:
		"The OpenRouter servers may be down or you may have lost internet connection.",
	emptyUnreachableTitle: "Unable to load models",
	endpointProviderFilter: "Provider",
	filtersLabel: "Filters",
	hostingProviders: "Hosting providers",
	parametersFilter: "Capabilities",
	pricingPerMillion: "Approximate cost per 1M tokens (input/output).",
	pricingTooltipFree: "Free",
	searchPlaceholder: "Search models",
	triggerLabel: "Model",
	variantFilter: "Variant",
};

/**
 * Resolves a key against a consumer `t` function with a built-in English
 * fallback. Wrap your i18n lookups with this helper so the package never
 * renders a raw lookup key if a translation is missing.
 */
export function resolveLabel(key: keyof PickerLabels, t?: TranslateFn): string {
	if (!t) {
		return DEFAULT_LABELS[key];
	}
	const value = t(key);
	if (!value || value === key) {
		return DEFAULT_LABELS[key];
	}
	return value;
}
