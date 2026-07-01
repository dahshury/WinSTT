import type { ColumnDef, Table } from "@tanstack/react-table";
import { useRef } from "react";
import { cellUpdatesBetween } from "@/shared/lib/grid-cell-diff";
import { DataGrid } from "./data-grid";
import { DataGridFilterMenu } from "./data-grid-filter-menu";
import { DataGridKeyboardShortcuts } from "./data-grid-keyboard-shortcuts";
import { DataGridPagination } from "./data-grid-pagination";
import { DataGridRowHeightMenu } from "./data-grid-row-height-menu";
import { DataGridSelectionBar } from "./data-grid-selection-bar";
import { DataGridSortMenu } from "./data-grid-sort-menu";
import { DataGridViewMenu } from "./data-grid-view-menu";
import { useDataGrid } from "./model/use-data-grid";
import { useDataGridUndoRedo } from "./model/use-data-grid-undo-redo";
import {
	lastPageIndex,
	lastRowIndexInPage,
	useGridPageClamp,
	useGridPaginationOptions,
} from "./model/use-grid-pagination";
import { usePruneEmptyRows } from "./model/use-prune-empty-rows";

export interface EditableRecordsGridProps<TData extends { id: string }> {
	acceptData?: (next: readonly TData[], current: readonly TData[]) => boolean;
	columns: ColumnDef<TData>[];
	createRow: () => TData;
	data: TData[];
	editableColumnIds: readonly string[];
	focusColumnId: string;
	isEmptyRow: (row: TData) => boolean;
	onChange: (rows: TData[]) => void;
}

export function EditableRecordsGrid<TData extends { id: string }>({
	acceptData,
	columns,
	createRow,
	data,
	editableColumnIds,
	focusColumnId,
	isEmptyRow,
	onChange,
}: EditableRecordsGridProps<TData>) {
	const dataRef = useRef(data);
	// eslint-disable-next-line react-hooks-js/refs -- latest-value ref for grid callbacks invoked outside render
	dataRef.current = data;
	const tableRef = useRef<Table<TData> | null>(null);
	const paginationOptions = useGridPaginationOptions();
	const { trackCellsUpdate, trackRowsAdd, trackRowsDelete } =
		useDataGridUndoRedo<TData>({
			data,
			getRowId: (row) => row.id,
			onDataChange: onChange,
		});

	const onDataChange = (newData: TData[]) => {
		const current = dataRef.current;
		if (acceptData && !acceptData(newData, current)) {
			onChange(current.slice());
			return;
		}
		const updates = cellUpdatesBetween(current, newData, editableColumnIds);
		if (updates.length > 0) {
			trackCellsUpdate(updates);
		}
		onChange(newData);
	};

	const onRowAdd = () => {
		const current = dataRef.current;
		const last = current[current.length - 1];
		if (last && isEmptyRow(last)) {
			tableRef.current?.setPageIndex(lastPageIndex(current.length));
			return {
				columnId: focusColumnId,
				rowIndex: lastRowIndexInPage(current.length),
			};
		}
		const row = createRow();
		trackRowsAdd([row]);
		const next = [...current, row];
		onChange(next);
		tableRef.current?.setPageIndex(lastPageIndex(next.length));
		return {
			columnId: focusColumnId,
			rowIndex: lastRowIndexInPage(next.length),
		};
	};

	const onRowsAdd = (count: number) => {
		const rows = Array.from({ length: count }, createRow);
		trackRowsAdd(rows);
		const next = [...dataRef.current, ...rows];
		onChange(next);
		tableRef.current?.setPageIndex(lastPageIndex(next.length));
	};

	const onRowsDelete = (rows: TData[]) => {
		trackRowsDelete(rows);
		const ids = new Set(rows.map((row) => row.id));
		onChange(dataRef.current.filter((row) => !ids.has(row.id)));
	};

	const { table, ...dataGridProps } = useDataGrid({
		columns,
		data,
		enablePaste: true,
		enableSearch: true,
		getRowId: (row) => row.id,
		onDataChange,
		onRowAdd,
		onRowsAdd,
		onRowsDelete,
		...paginationOptions,
	});
	// eslint-disable-next-line react-hooks-js/refs -- stable table handle for add-row callbacks
	tableRef.current = table;
	useGridPageClamp(table);
	const { wrapperRef, onBlur } = usePruneEmptyRows<TData>({
		dataRef,
		isEmpty: isEmptyRow,
		onChange,
	});

	return (
		<div className="flex flex-col gap-3" onBlur={onBlur} ref={wrapperRef}>
			<div
				aria-orientation="horizontal"
				className="flex items-center gap-2 self-end"
				role="toolbar"
			>
				<DataGridFilterMenu table={table} />
				<DataGridSortMenu table={table} />
				<DataGridRowHeightMenu table={table} />
				<DataGridViewMenu table={table} />
			</div>
			<DataGridKeyboardShortcuts
				features={{
					enableSearch: Boolean(dataGridProps.searchState),
					enableUndoRedo: true,
				}}
			/>
			<DataGrid stretchColumns table={table} {...dataGridProps} />
			{(table.getSelectedRowModel().rows.length > 0 ||
				table.getPageCount() > 1) && (
				<div className="flex min-h-7 items-center gap-3">
					<DataGridSelectionBar onDeleteSelected={onRowsDelete} table={table} />
					<DataGridPagination className="ms-auto" table={table} />
				</div>
			)}
		</div>
	);
}
