import type { Table } from "@tanstack/react-table";
import {
	AlignVerticalSpaceAroundIcon,
	Check,
	ChevronsDownUpIcon,
	EqualIcon,
	MinusIcon,
} from "@/shared/ui/data-grid/primitives/icons";
import { cn } from "@/shared/lib/cn";
import type { RowHeightValue } from "./types";

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

/** Label of the active row height — the summary the table-controls root row
 *  shows so the setting is legible without opening its view. */
export function rowHeightLabel(value: RowHeightValue | undefined): string {
	return rowHeights.find((option) => option.value === value)?.label ?? "Short";
}

/**
 * The row-height view of the shared table-controls popover. It was a `Select`
 * when it had its own trigger; inside the popover the options are plain rows,
 * so picking a height is one click rather than opening a dropdown inside a
 * dropdown.
 */
export function DataGridRowHeightPanel<TData>({
	table,
}: {
	table: Table<TData>;
}) {
	const rowHeight = table.options.meta?.rowHeight;
	const onRowHeightChange = table.options.meta?.onRowHeightChange;

	return (
		<div className="flex flex-col gap-0.5 p-1 pt-0" data-nav-initial-focus>
			{rowHeights.map((option) => {
				const isSelected = option.value === (rowHeight ?? "short");
				return (
					<button
						aria-pressed={isSelected}
						className={cn(
							"flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-body-sm outline-none transition-colors",
							"hover:bg-foreground/[0.045] focus-visible:ring-2 focus-visible:ring-accent",
							isSelected && "bg-accent/10 text-accent",
						)}
						key={option.value}
						onClick={() => onRowHeightChange?.(option.value)}
						type="button"
					>
						<option.icon />
						<span className="flex-1 truncate">{option.label}</span>
						{isSelected ? <Check className="size-4" /> : null}
					</button>
				);
			})}
		</div>
	);
}
