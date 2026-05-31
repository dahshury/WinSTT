import type { ModelVariant } from "./model-variant-utils";
import type { FilterableParameter } from "./openrouter-provider-utils";

interface ActiveFilterCountInput {
	selectedEndpointProvider: string | null;
	selectedMakers: string[];
	selectedParameters: FilterableParameter[];
	selectedVariant: ModelVariant | "none" | null;
}

export function countNonNull(value: unknown): number {
	return value === null ? 0 : 1;
}

export function computeActiveFilterCount(input: ActiveFilterCountInput): number {
	return (
		countNonNull(input.selectedVariant) +
		countNonNull(input.selectedEndpointProvider) +
		input.selectedParameters.length +
		input.selectedMakers.length
	);
}

export function getActiveFiltersAttr(count: number): number | undefined {
	return count > 0 ? count : undefined;
}

export function getOpenStateAttr(isOpen: boolean): "open" | "closed" {
	return isOpen ? "open" : "closed";
}

export function shouldRenderAuthorSubmenu(
	allProviders: string[],
	onMakersChange: ((makers: string[]) => void) | undefined
): boolean {
	return allProviders.length > 0 && !!onMakersChange;
}

export function shouldRenderEndpointSubmenu(endpointProviders: [string, number][]): boolean {
	return endpointProviders.length > 0;
}
