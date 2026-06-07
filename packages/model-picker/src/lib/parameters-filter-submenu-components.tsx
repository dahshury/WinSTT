"use client";

import { FilterIcon, Tick01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { DropdownMenuItem, DropdownMenuSeparator } from "../ui/DropdownMenu";
import { getParameterIcon } from "./filter-icons";
import {
	type FilterableParameter,
	PARAMETER_INFO,
} from "./openrouter-provider-utils";
import {
	shouldShowClearAll,
	shouldShowCountBadge,
} from "./parameters-filter-submenu-utils";

interface SelectedCountBadgeProps {
	count: number;
}

export function SelectedCountBadge({ count }: SelectedCountBadgeProps) {
	if (!shouldShowCountBadge(count)) {
		return null;
	}
	return (
		<span className="ml-auto rounded-full bg-foreground/[0.10] px-1.5 py-0.5 text-foreground-secondary text-xs-tight tabular-nums">
			{count}
		</span>
	);
}

interface ClearAllSectionProps {
	onClear: () => void;
	visible: boolean;
}

export function ClearAllSection({ onClear, visible }: ClearAllSectionProps) {
	if (!shouldShowClearAll(visible ? 1 : 0)) {
		return null;
	}
	return (
		<>
			<DropdownMenuItem onClick={onClear}>
				<HugeiconsIcon className="me-2 size-4" icon={FilterIcon} />
				<span className="flex-1">Clear all</span>
			</DropdownMenuItem>
			<DropdownMenuSeparator />
		</>
	);
}

interface ParameterMenuItemProps {
	count: number;
	isSelected: boolean;
	onToggle: () => void;
	param: FilterableParameter;
}

export function ParameterMenuItem({
	count,
	isSelected,
	onToggle,
	param,
}: ParameterMenuItemProps) {
	const info = PARAMETER_INFO[param];
	return (
		<DropdownMenuItem closeOnClick={false} key={param} onClick={onToggle}>
			{getParameterIcon(param)}
			<span className="ms-2 flex-1">{info.label}</span>
			{isSelected ? (
				<HugeiconsIcon className="ms-2 size-4 text-accent" icon={Tick01Icon} />
			) : null}
			<span className="text-2xs text-foreground-muted">({count})</span>
		</DropdownMenuItem>
	);
}
