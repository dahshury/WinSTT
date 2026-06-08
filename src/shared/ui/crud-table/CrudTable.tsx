import { Delete02Icon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
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
	useReactTable,
	type VisibilityState,
} from "@tanstack/react-table";
import {
	type ChangeEventHandler,
	type ReactNode,
	useEffect,
	useState,
} from "react";
import { useTranslations } from "use-intl";
import type { ZodType } from "zod";
import { cn } from "@/shared/lib/cn";
import { SurfaceProvider, surfaceBg, useSurface } from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import {
	DataGrid,
	DataGridContainer,
	type DataGridLabels,
	DataGridPagination,
	DataGridTable,
	DataGridToolbar,
} from "@/shared/ui/data-grid";
import { CrudAddForm } from "./CrudAddForm";
import { CrudEditableCell } from "./CrudRow";
import { useCrudEditing } from "./use-crud-editing";
import { useCrudForm } from "./use-crud-form";

const DEFAULT_PAGE_SIZE = 10;

/** One field in the add-entry form. The Add button rides in the LAST field. */
export interface CrudField {
	icon: IconSvgElement;
	name: string;
	placeholder: string;
	label: string;
	/** Width class for the field wrapper in a multi-field row (e.g. "w-1/3", "flex-1"). */
	width?: string;
}

/** One column in the entry table (the trailing delete column is automatic). */
export interface CrudColumn<TEntry> {
	/**
	 * Plain-text value used for sorting + global search. Defaults to the entry
	 * field named by `editFieldName` (a no-op for non-text columns like badges,
	 * which should supply this when they need to be sortable/searchable).
	 */
	accessor?: (entry: TEntry) => string;
	/** Name of the form field rendered inline when this row is being edited. */
	editFieldName?: string;
	header: string;
	/** When false, the column can't be toggled off via the visibility menu. Default true. */
	hideable?: boolean;
	render: (entry: TEntry) => ReactNode;
	/** Initial pixel width — only applied when the grid is `resizable`. */
	size?: number;
	/** Width class applied to both the header and cells (e.g. "w-1/3"). */
	width?: string;
	/** Extra classes for the data cells. */
	cellClassName?: string;
}

export interface CrudTableLabels {
	add: string;
	cancel: string;
	clearDescription: string;
	clearTitle: string;
	delete: string;
	deleteAll: string;
	edit: string;
	emptyState: string;
	save: string;
	/** Optional confirm-button label for the clear-all dialog. */
	clearConfirm?: string;
	/** Accessible label for the header checkbox. Defaults to English. */
	selectAll?: string;
	/** Accessible label for one row checkbox. Defaults to English. */
	formatSelectRow?: (label: string) => string;
	/** Button text for selected-row deletion. Defaults to `${delete} (${count})`. */
	formatDeleteSelected?: (count: number) => string;
}

export interface CrudTableProps<TEntry, TAdd> {
	/** Visual layout for the add row. `joined` connects multiple input groups into one toolbar. */
	addFormLayout?: "separate" | "joined";
	columns: CrudColumn<TEntry>[];
	/** Show the column-visibility dropdown in the toolbar. */
	columnControls?: boolean;
	/** Value shown in each row's delete aria-label: `${delete} "${value}"`. */
	deleteLabelFor: (entry: TEntry) => string;
	entries: TEntry[];
	fields: CrudField[];
	getId: (entry: TEntry) => string;
	/** Values used to seed the inline edit controls. Defaults to reading field names from the entry. */
	getEditValues?: (entry: TEntry) => Record<string, string>;
	labels: CrudTableLabels;
	onAdd: (entry: TAdd) => void;
	onClearAll?: () => void;
	onRemove: (id: string) => void;
	onRemoveMany?: (ids: string[]) => void;
	onUpdate?: (id: string, entry: TAdd) => void;
	/** Split the list across pages with a page-size selector. */
	paginated?: boolean;
	/** Rows per page when `paginated`. Default {@link DEFAULT_PAGE_SIZE}. */
	pageSize?: number;
	/** Let users drag column edges to resize (pixel widths under `table-fixed`). */
	resizable?: boolean;
	/** Validates the assembled `{ [field.name]: value }` map; its output is passed to `onAdd`. */
	schema: ZodType<TAdd>;
	/** Show a global-search box in the toolbar. */
	searchable?: boolean;
	/** Make column headers click-to-sort. */
	sortable?: boolean;
	/** Optional row-aware validator for edits, e.g. duplicate checks that exclude the edited row. */
	updateSchema?: (entry: TEntry) => ZodType<TAdd>;
}

/**
 * A scrollable add/list/delete table — the shared engine behind the Dictionary
 * and Snippets settings tables (and any future "manage a small list" control).
 * Caller supplies the entry columns, the add-form fields, a Zod schema for the
 * add row, and the CRUD callbacks; everything else (the add field-group with its
 * inline Add button, the selected-row delete action, the scroll frame, per-row
 * edit, the empty state, and the guarded clear-all) is identical across
 * consumers and lives here once.
 *
 * The list itself is a TanStack Table v8 data grid (sorting, global search,
 * pagination, column visibility + resize) rendered through the app's own `Table`
 * primitive and surface tokens — see `@/shared/ui/data-grid`. The features are
 * opt-in per consumer via the corresponding props.
 */
interface RowSelectionCheckboxProps {
	checked: boolean;
	disabled?: boolean;
	indeterminate?: boolean;
	label: string;
	onChange: ChangeEventHandler<HTMLInputElement>;
}

function RowSelectionCheckbox({
	checked,
	disabled = false,
	indeterminate = false,
	label,
	onChange,
}: RowSelectionCheckboxProps) {
	return (
		<input
			aria-label={label}
			checked={checked}
			className="size-3.5 cursor-pointer rounded border border-border bg-transparent accent-accent outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default disabled:opacity-40"
			disabled={disabled}
			onChange={onChange}
			ref={(node) => {
				if (node) {
					node.indeterminate = indeterminate;
				}
			}}
			type="checkbox"
		/>
	);
}

export function CrudTable<TEntry, TAdd>({
	addFormLayout = "separate",
	columns,
	columnControls = false,
	deleteLabelFor,
	entries,
	fields,
	getId,
	getEditValues,
	labels,
	onAdd,
	onClearAll,
	onRemove,
	onRemoveMany,
	onUpdate,
	paginated = false,
	pageSize = DEFAULT_PAGE_SIZE,
	resizable = false,
	schema,
	searchable = false,
	sortable = false,
	updateSchema,
}: CrudTableProps<TEntry, TAdd>) {
	const tGrid = useTranslations("common");
	const level = Math.min(useSurface() + 1, 8);
	const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
	const [sorting, setSorting] = useState<SortingState>([]);
	const [globalFilter, setGlobalFilter] = useState("");
	const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
	const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
	const [pagination, setPagination] = useState<PaginationState>({
		pageIndex: 0,
		pageSize,
	});

	const form = useCrudForm({ fields, schema, onAdd });
	const editing = useCrudEditing({
		fields,
		schema,
		getId,
		getEditValues,
		onUpdate,
		updateSchema,
	});
	const { editingId, startEdit, cancelEdit, handleUpdate } = editing;

	useEffect(() => {
		const validIds = new Set(entries.map((entry) => getId(entry)));
		setRowSelection((prev) => {
			let changed = false;
			const next: RowSelectionState = {};
			for (const [id, selected] of Object.entries(prev)) {
				if (selected && validIds.has(id)) {
					next[id] = true;
				} else if (selected) {
					changed = true;
				}
			}
			return changed ? next : prev;
		});
	}, [entries, getId]);

	const selectedIds = Object.entries(rowSelection)
		.filter(([, selected]) => selected)
		.map(([id]) => id);
	const selectedCount = selectedIds.length;
	const selectAllLabel = labels.selectAll ?? "Select all rows";
	const formatSelectRow =
		labels.formatSelectRow ?? ((label: string) => `Select "${label}"`);
	const deleteSelectedLabel =
		labels.formatDeleteSelected?.(selectedCount) ??
		(selectedCount > 0 ? `${labels.delete} (${selectedCount})` : labels.delete);

	const handleRemoveSelected = () => {
		if (selectedIds.length === 0) {
			return;
		}
		if (onRemoveMany) {
			onRemoveMany(selectedIds);
		} else {
			for (const id of selectedIds) {
				onRemove(id);
			}
		}
		setRowSelection({});
	};

	const renderEditableCell = (
		col: CrudColumn<TEntry>,
		entry: TEntry,
	): ReactNode => (
		<CrudEditableCell
			cancelEdit={cancelEdit}
			col={col}
			editErrors={editing.editErrors}
			editValues={editing.editValues}
			editingId={editingId}
			entry={entry}
			fields={fields}
			getId={getId}
			handleUpdate={handleUpdate}
			setEditField={editing.setEditField}
			startEdit={startEdit}
		/>
	);

	// While a row is being edited, always let it pass the global filter so typing
	// a value that no longer matches the query can't unmount the edit input.
	const gridGlobalFilter: FilterFn<TEntry> = (row, columnId, filterValue) => {
		if (editingId !== null && row.id === editingId) {
			return true;
		}
		const raw = row.getValue(columnId);
		const haystack = typeof raw === "string" ? raw : String(raw ?? "");
		return haystack.toLowerCase().includes(String(filterValue).toLowerCase());
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
				cell: (ctx) => renderEditableCell(col, ctx.row.original),
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

	const table = useReactTable<TEntry>({
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

	const dataGridLabels: DataGridLabels = {
		columns: tGrid("columns"),
		emptyState: labels.emptyState,
		nextPage: tGrid("nextPage"),
		noResults: tGrid("noResults"),
		previousPage: tGrid("previousPage"),
		rowsPerPage: tGrid("rowsPerPage"),
		search: tGrid("search"),
		formatPaginationInfo: ({ count, from, to }) =>
			tGrid("paginationInfo", { count, from, to }),
		formatSortBy: (column) => tGrid("sortBy", { column }),
	};

	const showToolbar = searchable || columnControls;
	const showPagination = paginated && entries.length > 0;
	const deleteAllControl = onClearAll ? (
		<Button
			className="h-7 gap-1.5 rounded-md bg-error-dim/40 px-2.5 font-medium text-error text-xs ring-1 ring-error/25 transition-colors duration-150 hover:bg-error-dim/70 hover:ring-error/40 disabled:opacity-50"
			disabled={entries.length === 0}
			onClick={() => setClearConfirmOpen(true)}
		>
			<HugeiconsIcon aria-hidden="true" icon={Delete02Icon} size={14} />
			{labels.deleteAll}
		</Button>
	) : null;

	return (
		<SurfaceProvider value={level}>
			<div
				className={cn(
					"flex flex-col gap-3 rounded-lg border border-border p-3",
					surfaceBg(level),
				)}
			>
				{/* Search + column-visibility chrome rides ABOVE the add row so the add
			    field flows straight into the table with nothing wedged between
			    them. The search mirrors this table's add-entry field (elevated for
			    the separate layout, minimal for joined) and carries the
			    column-visibility trigger in its trailing slot, so the two read as
			    one grouped control. */}
				{showToolbar ? (
					<DataGrid
						labels={dataGridLabels}
						resizable={resizable}
						table={table}
						tableLayout={{
							cellBorder: true,
							dense: true,
							striped: true,
							width: "auto",
						}}
					>
						<DataGridToolbar
							appearance={addFormLayout === "joined" ? "minimal" : "elevated"}
							columnControls={columnControls}
							searchable={searchable}
						/>
					</DataGrid>
				) : null}
				<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
					<div className="min-w-0 flex-1">
						<CrudAddForm
							addFieldErrorId={form.addFieldErrorId}
							addFormLayout={addFormLayout}
							errors={form.errors}
							fields={fields}
							handleSubmit={form.handleSubmit}
							hasAddErrors={form.hasAddErrors}
							isAddDisabled={form.isAddDisabled}
							labels={labels}
							setField={form.setField}
							values={form.values}
						/>
					</div>
					<Button
						aria-label={deleteSelectedLabel}
						className="h-9 shrink-0 gap-1.5 rounded-md bg-error-dim/40 px-2.5 font-medium text-error text-xs ring-1 ring-error/25 transition-colors duration-150 hover:bg-error-dim/70 hover:ring-error/40 disabled:opacity-50"
						disabled={selectedCount === 0}
						onClick={handleRemoveSelected}
					>
						<HugeiconsIcon aria-hidden="true" icon={Delete02Icon} size={14} />
						<span>{deleteSelectedLabel}</span>
					</Button>
				</div>
				<DataGrid
					labels={dataGridLabels}
					resizable={resizable}
					table={table}
					tableLayout={{
						cellBorder: true,
						dense: true,
						striped: true,
						width: "auto",
					}}
				>
					<DataGridContainer>
						<DataGridTable />
					</DataGridContainer>
					{showPagination ? (
						<DataGridPagination
							actions={deleteAllControl}
							showPageSize={false}
						/>
					) : deleteAllControl ? (
						<div className="flex justify-end pt-1">{deleteAllControl}</div>
					) : null}
				</DataGrid>
				{onClearAll && (
					<ConfirmDialog
						description={labels.clearDescription}
						onConfirm={onClearAll}
						onOpenChange={setClearConfirmOpen}
						open={clearConfirmOpen}
						title={labels.clearTitle}
						{...(labels.clearConfirm
							? { confirmLabel: labels.clearConfirm }
							: {})}
					/>
				)}
			</div>
		</SurfaceProvider>
	);
}
