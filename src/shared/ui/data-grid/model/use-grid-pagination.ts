import {
	getPaginationRowModel,
	type Table,
	type TableState,
} from "@tanstack/react-table";
import { useEffect, useState } from "react";

/** Rows per page for the settings grids (Dictionary / Snippets). */
const GRID_PAGE_SIZE = 5;

/**
 * Pagination options to spread into `useDataGrid`. The row model is created once
 * per grid instance (sharing one factory across grids would cross-wire their
 * memo caches). `autoResetPageIndex: false` keeps the active page put while the
 * user edits cells (each edit replaces the controlled `data` reference, which
 * would otherwise snap back to page 1).
 */
export function useGridPaginationOptions(): {
	getPaginationRowModel: ReturnType<typeof getPaginationRowModel>;
	autoResetPageIndex: false;
	initialState: Partial<TableState>;
} {
	const [rowModel] = useState(() => getPaginationRowModel());
	return {
		autoResetPageIndex: false,
		getPaginationRowModel: rowModel,
		initialState: { pagination: { pageIndex: 0, pageSize: GRID_PAGE_SIZE } },
	};
}

/** Clamp the active page back into range after rows are removed. */
export function useGridPageClamp<TData>(table: Table<TData>): void {
	useEffect(() => {
		// eslint-disable-next-line react-doctor/no-event-handler -- syncs the page index to externally-controlled data (rows removed via the controlled `data` prop from any source); pageCount only reflects the new row set after the table re-renders, so it cannot be computed inside the deleting event handler.
		const pageCount = table.getPageCount();
		const { pageIndex } = table.getState().pagination;
		if (pageCount > 0 && pageIndex > pageCount - 1) {
			table.setPageIndex(pageCount - 1);
		}
	});
}

/** Page index that holds the row at `dataLength - 1` (the just-appended row). */
export function lastPageIndex(dataLength: number): number {
	return Math.max(0, Math.ceil(dataLength / GRID_PAGE_SIZE) - 1);
}

/** Row offset of the just-appended row within its page (for focus targeting). */
export function lastRowIndexInPage(dataLength: number): number {
	return (dataLength - 1) % GRID_PAGE_SIZE;
}
