import { Tick01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { DropdownMenuItem } from "../ui/DropdownMenu";
import { getParameterIcon } from "./filter-icons";
import {
	type FilterableParameter,
	PARAMETER_INFO,
} from "./openrouter-provider-utils";

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
