"use client";

import { Settings01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import {
	FILTERABLE_PARAMETERS,
	type FilterableParameter,
} from "../lib/openrouter-provider-utils";
import {
	ClearAllSection,
	ParameterMenuItem,
	SelectedCountBadge,
} from "../lib/parameters-filter-submenu-components";
import {
	getParamCount,
	toggleParameterValue,
} from "../lib/parameters-filter-submenu-utils";
import {
	DropdownMenuGroup,
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

export function ParametersFilterSubmenu({
	parameterCounts,
	selectedParameters,
	onParametersChange,
}: ParametersFilterSubmenuProps) {
	const t = useTranslations("modelPicker");
	const selectedSet = new Set(selectedParameters);

	const toggleParameter = (param: FilterableParameter) => {
		onParametersChange(
			toggleParameterValue(selectedParameters, param, selectedSet),
		);
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
				<span>{t("supportedParameters")}</span>
				<SelectedCountBadge count={selectedParameters.length} />
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent className="w-56">
				<DropdownMenuGroup>
					<DropdownMenuLabel>{t("capabilities")}</DropdownMenuLabel>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<ClearAllSection
					onClear={handleClearAll}
					visible={selectedParameters.length > 0}
				/>
				<DropdownMenuGroup>
					{FILTERABLE_PARAMETERS.map(renderParameter)}
				</DropdownMenuGroup>
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
}
