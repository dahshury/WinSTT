import {
	type ColumnDef,
	type FilterFn,
	getCoreRowModel,
	getFilteredRowModel,
	getPaginationRowModel,
	getSortedRowModel,
	type PaginationState,
	type RowSelectionState,
	type SortingState,
	type Table,
	type VisibilityState,
} from "@tanstack/react-table";
import { type Dispatch, type SetStateAction, useState } from "react";
import { cn } from "@/shared/lib/cn";
import { useCompilerSafeReactTable } from "@/shared/ui/data-grid/use-compiler-safe-react-table";
import { matchesFuzzySearch } from "@/shared/lib/fuzzy-search";
import { CrudEditableCell } from "./CrudRow";
import { RowSelectionCheckbox } from "./RowSelectionCheckbox";
import type { CrudColumn, CrudField } from "./types";
import type { CrudEditingState } from "./use-crud-editing";

interface UseCrudGridArgs<TEntry> {
	columns: CrudColumn<TEntry>[];
	deleteLabelFor: (entry: TEntry) => string;
	editing: CrudEditingState<TEntry>;
	entries: TEntry[];
	fields: CrudField[];
	formatSelectRow: (label: string) => string;
	getId: (entry: TEntry) => string;
	pageSize: number;
	paginated: boolean;
	resizable: boolean;
	rowSelection: RowSelectionState;
	selectAllLabel: string;
	setRowSelection: Dispatch<SetStateAction<RowSelectionState>>;
	sortable: boolean;
}

/**
 * The TanStack Table v8 wiring behind {@link CrudTable}: it derives the column
 * defs (the leading select column, then a caller column rendered through
 * {@link CrudEditableCell}), the edit-aware global filter, and the table
 * instance with its sorting / search / pagination / visibility / resize state.
 * Extracted so the table shell stays a thin composition root — the row-selection
 * effect and the multi-row delete still live with the shell since they touch the
 * CRUD callbacks.
 */
export function useCrudGrid<TEntry>({
	columns,
	deleteLabelFor,
	editing,
	entries,
	fields,
	formatSelectRow,
	getId,
	pageSize,
	paginated,
	resizable,
	rowSelection,
	selectAllLabel,
	setRowSelection,
	sortable,
}: UseCrudGridArgs<TEntry>): Table<TEntry> {
	"use no memo";
	const [sorting, setSorting] = useState<SortingState>([]);
	const [globalFilter, setGlobalFilter] = useState("");
	const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
	const [pagination, setPagination] = useState<PaginationState>({
		pageIndex: 0,
		pageSize,
	});

	const { editingId } = editing;

	// While a row is being edited, always let it pass the global filter so typing
	// a value that no longer matches the query can't unmount the edit input.
	const gridGlobalFilter: FilterFn<TEntry> = (row, columnId, filterValue) => {
		if (editingId !== null && row.id === editingId) {
			return true;
		}
		const raw = row.getValue(columnId);
		const haystack = typeof raw === "string" ? raw : String(raw ?? "");
		return matchesFuzzySearch(haystack, String(filterValue));
	};

	const columnDefs: ColumnDef<TEntry>[] = [
		{
			cell: (ctx) => (
				<div className="flex justify-center">
					<RowSelectionCheckbox
						checked={ctx.row.getIsSelected()}
						disabled={!ctx.row.getCanSelect()}
						label={formatSelectRow(deleteLabelFor(ctx.row.original))}
						onChange={(event) => ctx.row.toggleSelected(event.target.checked)}
					/>
				</div>
			),
			enableGlobalFilter: false,
			enableHiding: false,
			enableResizing: false,
			enableSorting: false,
			header: ({ table: grid }) => {
				const checked = grid.getIsAllPageRowsSelected();
				const hasRows = grid.getRowModel().rows.length > 0;
				return (
					<div className="flex justify-center">
						<RowSelectionCheckbox
							checked={checked}
							disabled={!hasRows}
							indeterminate={!checked && grid.getIsSomePageRowsSelected()}
							label={selectAllLabel}
							onChange={(event) =>
								grid.toggleAllPageRowsSelected(event.target.checked)
							}
						/>
					</div>
				);
			},
			id: "__select",
			meta: {
				cellClassName: "w-9 text-center",
				headClassName: "w-9",
				title: selectAllLabel,
			},
			...(resizable ? { size: 36 } : {}),
		},
		...columns.map((col): ColumnDef<TEntry> => {
			const accessor =
				col.accessor ??
				((entry: TEntry): string => {
					if (!col.editFieldName) {
						return "";
					}
					const raw = (entry as Record<string, unknown>)[col.editFieldName];
					return typeof raw === "string" ? raw : "";
				});
			return {
				accessorFn: accessor,
				cell: (ctx) => (
					<CrudEditableCell
						cancelEdit={editing.cancelEdit}
						col={col}
						editErrors={editing.editErrors}
						editValues={editing.editValues}
						editingId={editingId}
						entry={ctx.row.original}
						fields={fields}
						getId={getId}
						handleUpdate={editing.handleUpdate}
						setEditField={editing.setEditField}
						startEdit={editing.startEdit}
					/>
				),
				enableHiding: col.hideable !== false,
				enableSorting: sortable,
				header: col.header,
				id: col.header,
				meta: {
					cellClassName: cn("break-words", col.width, col.cellClassName),
					headClassName: col.width,
					title: col.header,
				},
				...(col.size === undefined ? {} : { size: col.size }),
			};
		}),
	];

	return useCompilerSafeReactTable<TEntry>({
		columns: columnDefs,
		data: entries,
		enableColumnResizing: resizable,
		enableRowSelection: true,
		enableSorting: sortable,
		getCoreRowModel: getCoreRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		getRowId: (entry) => getId(entry),
		getSortedRowModel: getSortedRowModel(),
		globalFilterFn: gridGlobalFilter,
		onColumnVisibilityChange: setColumnVisibility,
		onGlobalFilterChange: setGlobalFilter,
		onRowSelectionChange: setRowSelection,
		onSortingChange: setSorting,
		state: paginated
			? { columnVisibility, globalFilter, pagination, rowSelection, sorting }
			: { columnVisibility, globalFilter, rowSelection, sorting },
		...(resizable ? { columnResizeMode: "onChange" } : {}),
		...(paginated
			? {
					getPaginationRowModel: getPaginationRowModel(),
					onPaginationChange: setPagination,
				}
			: {}),
	});
}
