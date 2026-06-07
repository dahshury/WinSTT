import type { RowData, Table } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { DataGridContext, type DataGridLabels } from "./data-grid-context";

// Keep the entry list scrolling inside its own frame rather than growing
// unbounded and pushing the rest of a fixed-height settings panel off-screen.
// ~7 rows visible before the scrollbar engages — matches the prior table frame.
const DEFAULT_MAX_HEIGHT_PX = 280;

/**
 * Root provider for the data grid. Holds a TanStack `Table` instance (created by
 * the caller from its own typed columns) plus the chrome labels and the resize
 * flag, and hands them to the grid sub-components through context. Rendered with
 * the app's `Table` primitive + surface tokens — not the shadcn/ReUI styling.
 */
export function DataGrid<TData>({
	children,
	labels,
	resizable = false,
	table,
}: {
	children: ReactNode;
	labels: DataGridLabels;
	resizable?: boolean;
	table: Table<TData>;
}) {
	return (
		<DataGridContext.Provider
			value={{ labels, resizable, table: table as unknown as Table<RowData> }}
		>
			{children}
		</DataGridContext.Provider>
	);
}

/**
 * Scrollable frame around the table. The scroll lives on this outer element so
 * the `Table` primitive's inner proximity-hover container scrolls as one unit
 * and the row-hover backdrop stays aligned; the border/rounding ride here too so
 * the frame stays put while the rows scroll.
 */
export function DataGridContainer({
	border = true,
	children,
	className,
	maxHeight = DEFAULT_MAX_HEIGHT_PX,
}: {
	border?: boolean;
	children: ReactNode;
	className?: string;
	maxHeight?: number;
}) {
	return (
		<div
			className={cn(
				"overflow-auto overscroll-contain rounded",
				border && "border border-border",
				className
			)}
			style={{ maxHeight }}
		>
			{children}
		</div>
	);
}
