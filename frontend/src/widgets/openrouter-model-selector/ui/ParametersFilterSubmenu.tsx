"use client";

import { FilterIcon, Settings01Icon, Tick01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getParameterIcon } from "../lib/filter-icons";
import {
	FILTERABLE_PARAMETERS,
	type FilterableParameter,
	PARAMETER_INFO,
} from "../lib/openrouter-provider-utils";
import {
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "./DropdownMenu";

export interface ParametersFilterSubmenuProps {
	onParametersChange: (params: FilterableParameter[]) => void;
	parameterCounts: Map<FilterableParameter, number>;
	selectedParameters: FilterableParameter[];
}

function toggleParameterValue(
	current: FilterableParameter[],
	param: FilterableParameter,
	selectedSet: Set<FilterableParameter>
): FilterableParameter[] {
	if (selectedSet.has(param)) {
		return current.filter((p) => p !== param);
	}
	return [...current, param];
}

/** Pure: returns the count for `param` from the map, defaulting to 0. */
export function getParamCount(
	parameterCounts: Map<FilterableParameter, number>,
	param: FilterableParameter
): number {
	return parameterCounts.get(param) ?? 0;
}

export function shouldShowSelectedTick(visible: boolean): boolean {
	return visible;
}

export function shouldShowCountBadge(count: number): boolean {
	return count > 0;
}

export function shouldShowClearAll(selectedCount: number): boolean {
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

function SelectedCountBadge({ count }: SelectedCountBadgeProps) {
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

function ClearAllSection({ onClear, visible }: ClearAllSectionProps) {
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

function ParameterMenuItem({ count, isSelected, onToggle, param }: ParameterMenuItemProps) {
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

export function ParametersFilterSubmenu({
	parameterCounts,
	selectedParameters,
	onParametersChange,
}: ParametersFilterSubmenuProps) {
	const selectedSet = new Set(selectedParameters);

	const toggleParameter = (param: FilterableParameter) => {
		onParametersChange(toggleParameterValue(selectedParameters, param, selectedSet));
	};

	const handleClearAll = () => onParametersChange([]);

	const renderParameter = (param: FilterableParameter) => (
		<ParameterMenuItem
			count={getParamCount(parameterCounts, param)}
			isSelected={selectedSet.has(param)}
			key={param}
			onToggle={() => toggleParameter(param)}
			param={param}
		/>
	);

	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger>
				<HugeiconsIcon className="me-2 size-4" icon={Settings01Icon} />
				<span>Supported Parameters</span>
				<SelectedCountBadge count={selectedParameters.length} />
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent className="w-56">
				<DropdownMenuGroup>
					<DropdownMenuLabel>Filter by capabilities</DropdownMenuLabel>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<ClearAllSection onClear={handleClearAll} visible={selectedParameters.length > 0} />
				<DropdownMenuGroup>{FILTERABLE_PARAMETERS.map(renderParameter)}</DropdownMenuGroup>
			</DropdownMenuSubContent>
		</DropdownMenuSub>
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
