import type { RowData, Table } from "@tanstack/react-table";
import { createContext, use } from "react";

/**
 * Per-column extras carried on the TanStack `ColumnMeta`. The grid chrome reads
 * these to apply the host app's Tailwind width/utility classes to the header and
 * body cells, and to label the column in sort/visibility affordances — keeping
 * the data grid styled with the app's surface tokens rather than shadcn ones.
 */
declare module "@tanstack/react-table" {
	// The two type parameters are mandated by the original `ColumnMeta`
	// declaration; they go unused in the augmentation, which is expected.
	interface ColumnMeta<TData extends RowData, TValue> {
		/** Classes applied to each body `<td>` for this column. */
		cellClassName?: string | undefined;
		/** Classes applied to the header `<th>` for this column. */
		headClassName?: string | undefined;
		/** Plain-text column title used for the sort aria-label + visibility menu. */
		title?: string | undefined;
	}
}

/**
 * The display strings the grid chrome needs. The host passes these (already
 * translated) so nothing user-facing is hardcoded — the two interpolated ones
 * are functions so the caller owns ICU formatting.
 */
export interface DataGridLabels {
	columns: string;
	emptyState: string;
	nextPage: string;
	noResults: string;
	previousPage: string;
	rowsPerPage: string;
	search: string;
	formatPaginationInfo: (info: {
		count: number;
		from: number;
		to: number;
	}) => string;
	formatSortBy: (column: string) => string;
}

export interface DataGridTableLayout {
	/** Compact row height and cell padding. */
	dense?: boolean;
	/** Vertical dividers between cells. */
	cellBorder?: boolean;
	/** Horizontal dividers between rows. */
	rowBorder?: boolean;
	/** Zebra-strip body rows. */
	striped?: boolean;
	/** Slightly lift the header row from the body. */
	headerBackground?: boolean;
	/** Divider below the header. */
	headerBorder?: boolean;
	/** Visual treatment for the table frame and row material. */
	presentation?: "standard" | "layered";
	/** CSS table layout algorithm. Resizable grids always force fixed layout. */
	width?: "auto" | "fixed";
}

export interface DataGridContextValue {
	labels: DataGridLabels;
	resizable: boolean;
	tableLayout: DataGridTableLayout;
	/**
	 * Row-type-erased table instance. The chrome renders exclusively via
	 * `flexRender` and column metadata, neither of which needs the concrete row
	 * type, so erasing it here keeps the context non-generic.
	 */
	table: Table<RowData>;
}

export const DataGridContext = createContext<DataGridContextValue | null>(null);

export function useDataGrid(): DataGridContextValue {
	const ctx = use(DataGridContext);
	if (ctx === null) {
		throw new Error("useDataGrid must be used within a <DataGrid>");
	}
	return ctx;
}
