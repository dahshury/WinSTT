"use client";

import { FilterIcon, Tick01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { DropdownMenuItem, DropdownMenuSeparator } from "../ui/DropdownMenu";
import { getParameterIcon } from "./filter-icons";
import { type FilterableParameter, PARAMETER_INFO } from "./openrouter-provider-utils";

export function toggleParameterValue(
	current: FilterableParameter[],
	param: FilterableParameter,
	selectedSet: Set<FilterableParameter>
): FilterableParameter[] {
	if (selectedSet.has(param)) {
		return current.filter((p) => p !== param);
	}
	return [...current, param];
}

export function getParamCount(
	parameterCounts: Map<FilterableParameter, number>,
	param: FilterableParameter
): number {
	return parameterCounts.get(param) ?? 0;
}

function shouldShowSelectedTick(visible: boolean): boolean {
	return visible;
}

function shouldShowCountBadge(count: number): boolean {
	return count > 0;
}

function shouldShowClearAll(selectedCount: number): boolean {
	return selectedCount > 0;
}

interface SelectedTickProps {
	visible: boolean;
}

function SelectedTick({ visible }: SelectedTickProps) {
	if (!shouldShowSelectedTick(visible)) {
		return null;
	}
	return <HugeiconsIcon className="ms-2 size-4 text-accent" icon={Tick01Icon} />;
}

interface SelectedCountBadgeProps {
	count: number;
}

export function SelectedCountBadge({ count }: SelectedCountBadgeProps) {
	if (!shouldShowCountBadge(count)) {
		return null;
	}
	return (
		<span className="ml-auto rounded-full bg-accent px-1.5 py-0.5 text-foreground text-xs-tight">
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

export function ParameterMenuItem({ count, isSelected, onToggle, param }: ParameterMenuItemProps) {
	const info = PARAMETER_INFO[param];
	return (
		<DropdownMenuItem closeOnClick={false} key={param} onClick={onToggle}>
			{getParameterIcon(param)}
			<span className="ms-2 flex-1">{info.label}</span>
			<SelectedTick visible={isSelected} />
			<span className="text-2xs text-foreground-muted">({count})</span>
		</DropdownMenuItem>
	);
}

export const __parameters_filter_submenu_test_helpers__ = {
	toggleParameterValue,
	getParamCount,
	shouldShowSelectedTick,
	shouldShowCountBadge,
	shouldShowClearAll,
	SelectedTick,
	SelectedCountBadge,
	ClearAllSection,
	ParameterMenuItem,
};
