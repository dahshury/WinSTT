"use client";

import { FilterIcon, Tag01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ModelVariant } from "../lib/model-variant-utils";
import {
	getVariantCount,
	SelectedTick,
	VariantMenuItem,
} from "../lib/variant-filter-submenu-test-helpers";
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
					<DropdownMenuLabel>Variant</DropdownMenuLabel>
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
