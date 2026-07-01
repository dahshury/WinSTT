import type { Table } from "@tanstack/react-table";
import {
	AlignVerticalSpaceAroundIcon,
	ChevronsDownUpIcon,
	EqualIcon,
	MinusIcon,
} from "@/shared/ui/data-grid/primitives/icons";
import * as React from "react";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/shared/ui/data-grid/primitives/select";

const rowHeights = [
	{
		label: "Short",
		value: "short" as const,
		icon: MinusIcon,
	},
	{
		label: "Medium",
		value: "medium" as const,
		icon: EqualIcon,
	},
	{
		label: "Tall",
		value: "tall" as const,
		icon: AlignVerticalSpaceAroundIcon,
	},
	{
		label: "Extra Tall",
		value: "extra-tall" as const,
		icon: ChevronsDownUpIcon,
	},
] as const;

interface DataGridRowHeightMenuProps<TData> extends React.ComponentProps<
	typeof SelectContent
> {
	table: Table<TData>;
	disabled?: boolean;
}

export function DataGridRowHeightMenu<TData>({
	table,
	disabled,
	...props
}: DataGridRowHeightMenuProps<TData>) {
	const rowHeight = table.options.meta?.rowHeight;
	const onRowHeightChange = table.options.meta?.onRowHeightChange;

	const selectedRowHeight = rowHeights.find(
		(opt) => opt.value === rowHeight,
	) ?? {
		label: "Short",
		value: "short" as const,
		icon: MinusIcon,
	};

	return (
		<Select
			value={rowHeight}
			onValueChange={onRowHeightChange}
			disabled={disabled}
		>
			<SelectTrigger>
				<SelectValue placeholder="Row height">
					<span className="flex items-center gap-2">
						<selectedRowHeight.icon />
						{selectedRowHeight.label}
					</span>
				</SelectValue>
			</SelectTrigger>
			<SelectContent {...props}>
				<SelectGroup>
					{rowHeights.map((option) => (
						<SelectItem key={option.value} value={option.value}>
							<span className="flex items-center gap-2">
								<option.icon />
								{option.label}
							</span>
						</SelectItem>
					))}
				</SelectGroup>
			</SelectContent>
		</Select>
	);
}
