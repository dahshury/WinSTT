"use client";

import { DropdownMenuItem } from "../ui/DropdownMenu";
import { SelectedTick } from "./filter-submenu-shared";
import { getVariantIcon } from "./filter-icons";
import type { ModelVariant } from "./model-variant-utils";
import { getVariantInfo } from "./variant-filter-submenu-utils";

export { SelectedTick } from "./filter-submenu-shared";

interface VariantMenuItemProps {
	count: number;
	isSelected: boolean;
	onSelect: () => void;
	variant: ModelVariant | "none";
}

export function VariantMenuItem({
	count,
	isSelected,
	onSelect,
	variant,
}: VariantMenuItemProps) {
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
