import {
	ArrowDown01Icon,
	ArrowUp01Icon,
	ArrowUpDownIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { flexRender, type Header } from "@tanstack/react-table";
import { cn } from "@/shared/lib/cn";
import { TableHead } from "@/shared/ui/table";
import { useDataGrid } from "./data-grid-context";

/**
 * One header cell. When the column is sortable the title becomes a button that
 * toggles sort (caret reflects asc/desc, faint up-down hint otherwise); when the
 * grid is resizable a drag handle rides the trailing edge. Non-sortable columns
 * render the title plainly. Always a `<th>` so the `columnheader` role stays.
 */
export function DataGridColumnHeader({
	header,
}: {
	header: Header<unknown, unknown>;
}) {
	const { labels, resizable, tableLayout } = useDataGrid();
	const column = header.column;
	const canSort = column.getCanSort();
	const sorted = column.getIsSorted();
	const title = column.columnDef.meta?.title ?? "";
	const dense = tableLayout.dense ?? true;
	const cellBorder = tableLayout.cellBorder ?? true;
	const headerBorder = tableLayout.headerBorder ?? true;
	const layered = tableLayout.presentation === "layered";
	const ariaSort =
		sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none";
	const content = header.isPlaceholder
		? null
		: flexRender(column.columnDef.header, header.getContext());

	return (
		<TableHead
			aria-sort={canSort ? ariaSort : undefined}
			className={cn(
				dense && (layered ? "px-3 py-2" : "px-2 py-1.5"),
				headerBorder && !layered && "border-border/80 border-b",
				cellBorder && !layered && "border-border/70 border-r last:border-r-0",
				layered &&
					"font-medium text-2xs text-foreground-muted uppercase tracking-[0.08em]",
				resizable && "relative",
				column.columnDef.meta?.headClassName,
			)}
			style={resizable ? { width: header.getSize() } : undefined}
		>
			{canSort && !header.isPlaceholder ? (
				<button
					aria-label={labels.formatSortBy(title)}
					className={cn(
						"-mx-1 group/sort flex w-full items-center gap-1 rounded px-1 text-left outline-none transition-colors duration-100 hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent",
						layered && "rounded-md hover:bg-foreground/[0.04]",
					)}
					onClick={column.getToggleSortingHandler()}
					type="button"
				>
					<span className="min-w-0 flex-1 truncate">{content}</span>
					<HugeiconsIcon
						aria-hidden="true"
						className={cn(
							"shrink-0 transition-opacity duration-100",
							sorted
								? "text-foreground opacity-100"
								: "text-foreground-muted opacity-0 group-hover/sort:opacity-60",
						)}
						icon={
							sorted === "desc"
								? ArrowDown01Icon
								: sorted === "asc"
									? ArrowUp01Icon
									: ArrowUpDownIcon
						}
						size={13}
					/>
				</button>
			) : (
				content
			)}
			{resizable && column.getCanResize() ? (
				<button
					aria-label="Resize column"
					className={cn(
						"absolute top-0 right-0 z-raised m-0 h-full w-1 cursor-col-resize touch-none select-none border-0 transition-colors duration-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70",
						column.getIsResizing()
							? "bg-accent"
							: "bg-transparent hover:bg-border",
					)}
					onDoubleClick={() => column.resetSize()}
					onKeyDown={(event) => {
						if (event.key === "Enter" || event.key === " ") {
							event.preventDefault();
							column.resetSize();
						}
					}}
					onMouseDown={header.getResizeHandler()}
					onTouchStart={header.getResizeHandler()}
					type="button"
				/>
			) : null}
		</TableHead>
	);
}
