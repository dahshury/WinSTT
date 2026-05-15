"use client";

import { FilterIcon, Tag01Icon, Tick01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getVariantIcon } from "../lib/filter-icons";
import { MODEL_VARIANT_INFO, type ModelVariant } from "../lib/model-variant-utils";
import {
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "./DropdownMenu";

export interface VariantFilterSubmenuProps {
	availableVariants: Array<ModelVariant | "none">;
	onVariantSelect: (variant: ModelVariant | "none" | null) => void;
	selectedVariant: ModelVariant | "none" | null;
	variantCounts: Map<ModelVariant | "none", number>;
}

const STANDARD_INFO = { label: "Standard" } as const;

function getVariantInfo(variant: ModelVariant | "none"): { label: string } {
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

/** Pure: returns the count for `variant` from the map, defaulting to 0. */
export function getVariantCount(
	variantCounts: Map<ModelVariant | "none", number>,
	variant: ModelVariant | "none"
): number {
	return variantCounts.get(variant) ?? 0;
}

interface SelectedTickProps {
	visible: boolean;
}

function SelectedTick({ visible }: SelectedTickProps) {
	if (!visible) {
		return null;
	}
	return <HugeiconsIcon className="ms-2 size-4 text-accent" icon={Tick01Icon} />;
}

interface AllVariantsItemProps {
	isSelected: boolean;
	onSelect: () => void;
}

function AllVariantsItem({ isSelected, onSelect }: AllVariantsItemProps) {
	return (
		<DropdownMenuItem onClick={onSelect}>
			<HugeiconsIcon className="me-2 size-4" icon={FilterIcon} />
			<span className="flex-1">All Variants</span>
			<SelectedTick visible={isSelected} />
		</DropdownMenuItem>
	);
}

interface VariantMenuItemProps {
	count: number;
	isSelected: boolean;
	onSelect: () => void;
	variant: ModelVariant | "none";
}

function VariantMenuItem({ count, isSelected, onSelect, variant }: VariantMenuItemProps) {
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

export function VariantFilterSubmenu({
	availableVariants,
	variantCounts,
	selectedVariant,
	onVariantSelect,
}: VariantFilterSubmenuProps) {
	const renderVariantItem = (variant: ModelVariant | "none") => (
		<VariantMenuItem
			count={getVariantCount(variantCounts, variant)}
			isSelected={selectedVariant === variant}
			key={variant}
			onSelect={() => onVariantSelect(variant)}
			variant={variant}
		/>
	);

	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger>
				<HugeiconsIcon className="me-2 size-4" icon={Tag01Icon} />
				<span>Model Variant</span>
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent className="w-52">
				<DropdownMenuGroup>
					<DropdownMenuLabel>Filter by variant</DropdownMenuLabel>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<AllVariantsItem
						isSelected={selectedVariant === null}
						onSelect={() => onVariantSelect(null)}
					/>
					<DropdownMenuSeparator />
					{availableVariants.map(renderVariantItem)}
				</DropdownMenuGroup>
			</DropdownMenuSubContent>
		</DropdownMenuSub>
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
