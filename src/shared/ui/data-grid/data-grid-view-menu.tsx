import type { Table } from "@tanstack/react-table";
import { useTranslations } from "use-intl";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/shared/ui/data-grid/primitives/command";
import { useDirection } from "@/shared/ui/data-grid/primitives/direction";

function hideableColumns<TData>(table: Table<TData>) {
	return table
		.getAllColumns()
		.filter(
			(column) =>
				typeof column.accessorFn !== "undefined" && column.getCanHide(),
		);
}

/** "8 / 11" — the visible-column summary on the table-controls root row. */
export function columnVisibilitySummary<TData>(table: Table<TData>): string {
	const columns = hideableColumns(table);
	const visible = columns.filter((column) => column.getIsVisible()).length;
	return `${visible}/${columns.length}`;
}

/**
 * The columns view of the shared table-controls popover: a searchable list of
 * hideable columns. Was its own 176px popover; now one row of the root list.
 */
export function DataGridColumnsPanel<TData>({
	table,
}: {
	table: Table<TData>;
}) {
	const t = useTranslations("dataGrid");
	const dir = useDirection();

	return (
		<div className="p-1 pt-0" dir={dir}>
			<Command>
				<CommandInput data-nav-initial-focus placeholder="Search columns..." />
				<CommandList>
					<CommandEmpty>{t("noColumnsFound")}</CommandEmpty>
					<CommandGroup>
						{hideableColumns(table).map((column) => (
							<CommandItem
								key={column.id}
								data-checked={column.getIsVisible()}
								onSelect={() => column.toggleVisibility(!column.getIsVisible())}
							>
								<span className="truncate">
									{column.columnDef.meta?.label ?? column.id}
								</span>
							</CommandItem>
						))}
					</CommandGroup>
				</CommandList>
			</Command>
		</div>
	);
}
