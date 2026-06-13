import { matchesFuzzySearch } from "@/shared/lib/fuzzy-search";

export const ALL_PROVIDERS_VALUE = "__all__";

export function filterEndpointProviders(
	providers: [string, number][],
	queryLower: string,
): [string, number][] {
	if (!queryLower) {
		return providers;
	}
	return providers.filter(([p]) => matchesFuzzySearch(p, queryLower));
}

export function resolveSelection(value: string | null): string | null | "noop" {
	if (value === ALL_PROVIDERS_VALUE) {
		return null;
	}
	if (value) {
		return value;
	}
	return "noop";
}

export function isTickVisible(
	selectedProvider: string | null,
	matchValue: string | null,
): boolean {
	return selectedProvider === matchValue;
}

export function resolveComboboxValue(
	selectedEndpointProvider: string | null,
): string {
	return selectedEndpointProvider || ALL_PROVIDERS_VALUE;
}

export function applyProviderChange(
	value: string | null,
	onEndpointProviderSelect: (provider: string | null) => void,
): void {
	const resolved = resolveSelection(value);
	if (resolved !== "noop") {
		onEndpointProviderSelect(resolved);
	}
}

export interface ItemContext {
	/** Translated label for the synthetic "All Providers" row. */
	allLabel: string;
	counts: Map<string, number>;
	selectedEndpointProvider: string | null;
}
