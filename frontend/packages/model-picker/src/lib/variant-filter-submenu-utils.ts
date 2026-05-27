import { MODEL_VARIANT_INFO, type ModelVariant } from "./model-variant-utils";

export const STANDARD_INFO = { label: "Standard" } as const;

export function getVariantInfo(variant: ModelVariant | "none"): { label: string } {
	if (variant === "none") {
		return STANDARD_INFO;
	}
	return MODEL_VARIANT_INFO[variant];
}

export function isVariantSelected(
	selectedVariant: ModelVariant | "none" | null,
	variant: ModelVariant | "none"
): boolean {
	return selectedVariant === variant;
}

export function getVariantCount(
	variantCounts: Map<ModelVariant | "none", number>,
	variant: ModelVariant | "none"
): number {
	return variantCounts.get(variant) ?? 0;
}
