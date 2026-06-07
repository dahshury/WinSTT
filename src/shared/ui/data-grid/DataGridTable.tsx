import { flexRender } from "@tanstack/react-table";
import { cn } from "@/shared/lib/cn";
import {
	Table,
	TableBody,
	TableCell,
	TableEmpty,
	TableHeader,
	TableRow,
} from "@/shared/ui/table";
import { useDataGrid } from "./data-grid-context";
import { DataGridColumnHeader } from "./DataGridColumnHeader";

/**
 * Renders the TanStack table through the app's `Table` primitives. Body rows are
 * keyed by `row.id` (stable across sort/paginate so the motion layout animates
 * reorders) and tagged with their on-screen `index` (drives proximity-hover).
 * Distinguishes a genuinely empty list from a filtered-to-zero result.
 */
export function DataGridTable({
	renderHeader = true,
}: {
	renderHeader?: boolean;
}) {
	const { labels, resizable, table } = useDataGrid();
	const rows = table.getRowModel().rows;
	const visibleColumnCount = table.getVisibleLeafColumns().length;
	const trulyEmpty = table.getPreFilteredRowModel().rows.length === 0;

	return (
		<Table
			className={cn(resizable ? "min-w-full" : "w-full", "table-fixed")}
			style={resizable ? { width: table.getTotalSize() } : undefined}
		>
			{renderHeader ? (
				<TableHeader>
					{table.getHeaderGroups().map((headerGroup) => (
						<TableRow key={headerGroup.id}>
							{headerGroup.headers.map((header) => (
								<DataGridColumnHeader header={header} key={header.id} />
							))}
						</TableRow>
					))}
				</TableHeader>
			) : null}
			<TableBody>
				{rows.length === 0 ? (
					<TableEmpty colSpan={visibleColumnCount}>
						{trulyEmpty ? labels.emptyState : labels.noResults}
					</TableEmpty>
				) : (
					rows.map((row, index) => (
						<TableRow index={index} key={row.id}>
							{row.getVisibleCells().map((cell) => (
								<TableCell
									className={cell.column.columnDef.meta?.cellClassName}
									key={cell.id}
									style={
										resizable ? { width: cell.column.getSize() } : undefined
									}
								>
									{flexRender(cell.column.columnDef.cell, cell.getContext())}
								</TableCell>
							))}
						</TableRow>
					))
				)}
			</TableBody>
		</Table>
	);
}
