"use client";

import { Tick01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { DropdownMenuItem } from "../ui/DropdownMenu";
import { getVariantIcon } from "./filter-icons";
import type { ModelVariant } from "./model-variant-utils";
import { getVariantInfo } from "./variant-filter-submenu-utils";

interface SelectedTickProps {
	visible: boolean;
}

export function SelectedTick({ visible }: SelectedTickProps) {
	if (!visible) {
		return null;
	}
	return (
		<HugeiconsIcon className="ms-2 size-4 text-accent" icon={Tick01Icon} />
	);
}

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
