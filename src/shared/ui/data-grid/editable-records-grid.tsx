import type { ColumnDef, Table } from "@tanstack/react-table";
import { useEffect, useRef } from "react";
import { cellUpdatesBetween } from "@/shared/lib/grid-cell-diff";
import { ButtonGroup } from "@/shared/ui/button-group";
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
import type { RowHeightValue } from "./types";

export interface EditableRecordsGridProps<TData extends { id: string }> {
	acceptData?: (next: readonly TData[], current: readonly TData[]) => boolean;
	canAdd?: boolean;
	columns: ColumnDef<TData>[];
	createRow: () => TData;
	data: TData[];
	editableColumnIds: readonly string[];
	focusColumnId: string;
	isEmptyRow: (row: TData) => boolean;
	onChange: (rows: TData[]) => void;
	readOnly?: boolean;
	rowHeight?: RowHeightValue;
	showSortControl?: boolean;
}

export function EditableRecordsGrid<TData extends { id: string }>({
	acceptData,
	canAdd = true,
	columns,
	createRow,
	data,
	editableColumnIds,
	focusColumnId,
	isEmptyRow,
	onChange,
	readOnly = false,
	rowHeight,
	showSortControl = true,
}: EditableRecordsGridProps<TData>) {
	const dataRef = useRef(data);
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
		const last = current.at(-1);
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
		...(canAdd && !readOnly ? { onRowAdd, onRowsAdd } : {}),
		...(readOnly ? {} : { onRowsDelete }),
		readOnly,
		...(rowHeight ? { rowHeight } : {}),
		...paginationOptions,
	});
	// Latest-value refs for grid callbacks that run outside render (row add/delete,
	// prune-on-blur). Written after commit so render stays pure; every reader is an
	// event handler invoked post-commit, so it always observes the latest value.
	useEffect(() => {
		dataRef.current = data;
		tableRef.current = table;
	});
	useGridPageClamp(table);
	const { wrapperRef, onBlur } = usePruneEmptyRows<TData>({
		dataRef,
		isEmpty: isEmptyRow,
		onChange,
	});

	return (
		<div className="flex flex-col gap-3" onBlur={onBlur} ref={wrapperRef}>
			<ButtonGroup aria-label="Table controls" className="self-end" connected>
				<DataGridFilterMenu table={table} />
				{showSortControl ? <DataGridSortMenu table={table} /> : null}
				<DataGridRowHeightMenu table={table} />
				<DataGridViewMenu table={table} />
			</ButtonGroup>
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
					{readOnly ? null : (
						<DataGridSelectionBar
							onDeleteSelected={onRowsDelete}
							table={table}
						/>
					)}
					<DataGridPagination className="ms-auto" table={table} />
				</div>
			)}
		</div>
	);
}
