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

const DEFAULT_TABLE_LAYOUT = {
	cellBorder: true,
	dense: true,
	headerBackground: true,
	headerBorder: true,
	presentation: "standard",
	rowBorder: true,
	striped: true,
	width: "auto",
} as const;

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
	const { labels, resizable, table, tableLayout } = useDataGrid();
	const rows = table.getRowModel().rows;
	const visibleColumnCount = table.getVisibleLeafColumns().length;
	const trulyEmpty = table.getPreFilteredRowModel().rows.length === 0;
	const layout = { ...DEFAULT_TABLE_LAYOUT, ...tableLayout };
	const layered = layout.presentation === "layered";
	const width = resizable ? "fixed" : layout.width;
	const denseCellClassName = layout.dense
		? layered
			? "px-3 py-2"
			: "px-2 py-1.5"
		: undefined;
	const cellBorderClassName =
		layout.cellBorder && !layered
			? "border-r border-border/70 last:border-r-0"
			: undefined;
	const rowBorderClassName =
		layout.rowBorder && !layered ? undefined : "border-b-0";
	const tableClassName = cn(
		resizable
			? "min-w-full table-fixed"
			: width === "auto"
				? "w-auto min-w-full table-auto"
				: "w-full table-fixed",
		layered && "border-separate border-spacing-y-1",
	);

	return (
		<Table
			className={tableClassName}
			{...(layered ? { containerClassName: "bg-transparent" } : {})}
			{...(resizable ? { style: { width: table.getTotalSize() } } : {})}
		>
			{renderHeader ? (
				<TableHeader>
					{table.getHeaderGroups().map((headerGroup) => (
						<TableRow
							className={cn(
								layered
									? [
											"border-b-0",
											"[&>th]:bg-surface-5/45",
											"[&>th:first-child]:rounded-l-md [&>th:last-child]:rounded-r-md",
										]
									: layout.headerBackground && "bg-surface-4/70",
								!(layout.headerBorder || layout.rowBorder) &&
									!layered &&
									"border-b-0",
							)}
							key={headerGroup.id}
						>
							{headerGroup.headers.map((header) => (
								<DataGridColumnHeader header={header} key={header.id} />
							))}
						</TableRow>
					))}
				</TableHeader>
			) : null}
			<TableBody>
				{rows.length === 0 ? (
					<TableEmpty
						colSpan={visibleColumnCount}
						{...(layered ? { className: "rounded-lg bg-surface-4/55" } : {})}
					>
						{trulyEmpty ? labels.emptyState : labels.noResults}
					</TableEmpty>
				) : (
					rows.map((row, index) => (
						<TableRow
							className={cn(
								rowBorderClassName,
								layered
									? [
											"[&>td]:bg-surface-4/45 [&>td]:transition-[background-color,box-shadow] [&>td]:duration-150",
											"[&>td:first-child]:rounded-l-md [&>td:last-child]:rounded-r-md",
											row.getIsSelected()
												? [
														"[&>td]:bg-accent/15 [&>td]:text-foreground",
														"[&>td:first-child]:shadow-[inset_3px_0_0_0_var(--color-accent)]",
													]
												: "hover:[&>td]:bg-surface-5/70",
										]
									: [
											layout.striped &&
												index % 2 === 1 &&
												"bg-foreground/[0.025]",
											row.getIsSelected() && "bg-accent/10",
										],
							)}
							data-selected={row.getIsSelected() ? "true" : undefined}
							index={index}
							key={row.id}
						>
							{row.getVisibleCells().map((cell) => (
								<TableCell
									className={cn(
										denseCellClassName,
										cellBorderClassName,
										cell.column.columnDef.meta?.cellClassName,
									)}
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
