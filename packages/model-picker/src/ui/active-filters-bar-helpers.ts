import {
	MODEL_VARIANT_INFO,
	type ModelVariant,
} from "../lib/model-variant-utils";
import type { FilterableParameter } from "../lib/openrouter-provider-utils";

export function getVariantLabel(variant: ModelVariant | "none"): string {
	return variant === "none"
		? "Standard"
		: (MODEL_VARIANT_INFO[variant]?.label ?? variant);
}

export function hasActiveFilters(
	selectedMakers: string[],
	selectedVariant: ModelVariant | "none" | null,
	selectedEndpointProvider: string | null,
	selectedParameters: FilterableParameter[],
): boolean {
	return (
		selectedMakers.length > 0 ||
		selectedVariant !== null ||
		selectedEndpointProvider !== null ||
		selectedParameters.length > 0
	);
}
