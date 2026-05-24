"use client";

import { Tick01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { DropdownMenuItem } from "../ui/DropdownMenu";
import { getVariantIcon } from "./filter-icons";
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

interface SelectedTickProps {
	visible: boolean;
}

export function SelectedTick({ visible }: SelectedTickProps) {
	if (!visible) {
		return null;
	}
	return <HugeiconsIcon className="ms-2 size-4 text-accent" icon={Tick01Icon} />;
}

interface VariantMenuItemProps {
	count: number;
	isSelected: boolean;
	onSelect: () => void;
	variant: ModelVariant | "none";
}

export function VariantMenuItem({ count, isSelected, onSelect, variant }: VariantMenuItemProps) {
	const info = getVariantInfo(variant);
	return (
		<DropdownMenuItem key={variant} onClick={onSelect}>
			{getVariantIcon(variant)}
			<span className="ms-2 flex-1">{info.label}</span>
			<SelectedTick visible={isSelected} />
			<span className="text-2xs text-foreground-muted">({count})</span>
		</DropdownMenuItem>
	);
}

export const __variant_filter_submenu_test_helpers__ = {
	STANDARD_INFO,
	getVariantInfo,
	isVariantSelected,
	getVariantCount,
	SelectedTick,
	VariantMenuItem,
};
