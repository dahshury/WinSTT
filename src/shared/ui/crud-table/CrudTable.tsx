import { Form } from "@base-ui/react/form";
import {
	Cancel01Icon,
	CheckIcon,
	Delete02Icon,
	Edit02Icon,
	PlusSignIcon,
} from "@hugeicons/core-free-icons";
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
	type SortingState,
	useReactTable,
	type VisibilityState,
} from "@tanstack/react-table";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { useTranslations } from "use-intl";
import type { ZodType } from "zod";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { ButtonGroup } from "@/shared/ui/button-group";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import {
	DataGrid,
	DataGridContainer,
	type DataGridLabels,
	DataGridPagination,
	DataGridTable,
	DataGridToolbar,
} from "@/shared/ui/data-grid";
import { FormControl } from "@/shared/ui/form-control";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@/shared/ui/input-group";
import { Tooltip } from "@/shared/ui/tooltip";

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
 * inline Add button, the scroll frame, per-row edit/delete, the empty state, and
 * the guarded clear-all) is identical across consumers and lives here once.
 *
 * The list itself is a TanStack Table v8 data grid (sorting, global search,
 * pagination, column visibility + resize) rendered through the app's own `Table`
 * primitive and surface tokens — see `@/shared/ui/data-grid`. The features are
 * opt-in per consumer via the corresponding props.
 */
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
	const addErrorIdPrefix = useId();
	const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
	const [values, setValues] = useState<Record<string, string>>({});
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editValues, setEditValues] = useState<Record<string, string>>({});
	const [editErrors, setEditErrors] = useState<Record<string, string>>({});
	const [sorting, setSorting] = useState<SortingState>([]);
	const [globalFilter, setGlobalFilter] = useState("");
	const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
	const [pagination, setPagination] = useState<PaginationState>({
		pageIndex: 0,
		pageSize,
	});

	const setField = (name: string, value: string): void => {
		setValues((prev) => ({ ...prev, [name]: value }));
		if (errors[name]) {
			setErrors((prev) => {
				const { [name]: _omit, ...rest } = prev;
				return rest;
			});
		}
	};

	const setEditField = (name: string, value: string): void => {
		setEditValues((prev) => ({ ...prev, [name]: value }));
		if (editErrors[name]) {
			setEditErrors((prev) => {
				const { [name]: _omit, ...rest } = prev;
				return rest;
			});
		}
	};

	const buildDraft = (
		source: Record<string, string>
	): Record<string, string> => {
		const draft: Record<string, string> = {};
		for (const f of fields) {
			draft[f.name] = source[f.name] ?? "";
		}
		return draft;
	};

	const buildDefaultEditValues = (entry: TEntry): Record<string, string> => {
		const entryRecord = entry as Record<string, unknown>;
		const draft: Record<string, string> = {};
		for (const f of fields) {
			const raw = entryRecord[f.name];
			draft[f.name] = typeof raw === "string" ? raw : "";
		}
		return draft;
	};

	const startEdit = (entry: TEntry): void => {
		const seed = getEditValues?.(entry) ?? buildDefaultEditValues(entry);
		const next: Record<string, string> = {};
		for (const f of fields) {
			next[f.name] = seed[f.name] ?? "";
		}
		setEditingId(getId(entry));
		setEditValues(next);
		setEditErrors({});
	};

	const cancelEdit = (): void => {
		setEditingId(null);
		setEditValues({});
		setEditErrors({});
	};

	const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
		event.preventDefault();
		const draft = buildDraft(values);
		const result = schema.safeParse(draft);
		if (!result.success) {
			const next: Record<string, string> = {};
			for (const issue of result.error.issues) {
				const key = issue.path[0];
				if (typeof key === "string" && !next[key]) {
					next[key] = issue.message;
				}
			}
			setErrors(next);
			return;
		}
		// The Zod schema applies .trim() during validation — no manual trimming.
		onAdd(result.data);
		setValues({});
		setErrors({});
	};

	const handleUpdate = (entry: TEntry): void => {
		if (!onUpdate) {
			return;
		}
		const draft = buildDraft(editValues);
		const result = (updateSchema?.(entry) ?? schema).safeParse(draft);
		if (!result.success) {
			const next: Record<string, string> = {};
			for (const issue of result.error.issues) {
				const key = issue.path[0];
				if (typeof key === "string" && !next[key]) {
					next[key] = issue.message;
				}
			}
			setEditErrors(next);
			return;
		}
		onUpdate(getId(entry), result.data);
		cancelEdit();
	};

	const fieldForName = (name: string): CrudField | undefined =>
		fields.find((field) => field.name === name);

	const isAddDisabled = !fields.every(
		(f) => (values[f.name] ?? "").trim().length > 0
	);
	const isEditSaveDisabled = !fields.every(
		(f) => (editValues[f.name] ?? "").trim().length > 0
	);
	const actionColumnClassName = onUpdate ? "w-20" : "w-10";
	const addFieldErrorId = (fieldName: string): string =>
		`${addErrorIdPrefix}-${fieldName}-error`;
	const hasAddErrors = fields.some((field) => !!errors[field.name]);

	// Inline-edit cell: when this row is being edited and the column maps to a
	// field, swap the value for an editable input (+ inline error); otherwise
	// render the column's normal content. Sorting reads the committed value (the
	// column accessor), so a row never jumps while it's being typed in.
	const renderEditableCell = (col: CrudColumn<TEntry>, entry: TEntry): ReactNode => {
		const editField = col.editFieldName ? fieldForName(col.editFieldName) : undefined;
		if (editingId === getId(entry) && editField) {
			const error = editErrors[editField.name];
			return (
				<div className="flex flex-col gap-1">
					<InputGroup
						appearance="minimal"
						className="h-8"
						size="sm"
						tone={error ? "danger" : "default"}
					>
						<InputGroupAddon align="inline-start">
							<HugeiconsIcon
								aria-hidden="true"
								icon={editField.icon}
								size={14}
							/>
						</InputGroupAddon>
						<InputGroupInput
							aria-invalid={!!error}
							aria-label={editField.label}
							name={editField.name}
							onChange={(event) => setEditField(editField.name, event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									handleUpdate(entry);
								}
								if (event.key === "Escape") {
									event.preventDefault();
									cancelEdit();
								}
							}}
							placeholder={editField.placeholder}
							value={editValues[editField.name] ?? ""}
						/>
					</InputGroup>
					{error ? (
						<div
							aria-live="assertive"
							className="text-error text-xs-tight leading-[14px]"
							role="alert"
						>
							{error}
						</div>
					) : null}
				</div>
			);
		}
		return col.render(entry);
	};

	// Trailing per-row controls: edit/delete normally, save/cancel while editing.
	const renderRowActions = (entry: TEntry): ReactNode => {
		const id = getId(entry);
		const isEditing = editingId === id;
		return (
			<div className="flex justify-end gap-1">
				{isEditing ? (
					<>
						<Tooltip content={labels.save}>
							<Button
								aria-label={`${labels.save} "${deleteLabelFor(entry)}"`}
								className="rounded bg-transparent p-1 text-success transition-colors duration-150 hover:bg-success-dim"
								disabled={isEditSaveDisabled}
								onClick={() => handleUpdate(entry)}
							>
								<HugeiconsIcon icon={CheckIcon} size={14} />
							</Button>
						</Tooltip>
						<Tooltip content={labels.cancel}>
							<Button
								aria-label={`${labels.cancel} "${deleteLabelFor(entry)}"`}
								className="rounded bg-transparent p-1 text-foreground-muted transition-colors duration-150 hover:bg-surface-hover hover:text-foreground"
								onClick={cancelEdit}
							>
								<HugeiconsIcon icon={Cancel01Icon} size={14} />
							</Button>
						</Tooltip>
					</>
				) : (
					<>
						{onUpdate ? (
							<Tooltip content={labels.edit}>
								<Button
									aria-label={`${labels.edit} "${deleteLabelFor(entry)}"`}
									className="rounded bg-transparent p-1 text-foreground-muted transition-colors duration-150 hover:bg-surface-hover hover:text-foreground"
									onClick={() => startEdit(entry)}
								>
									<HugeiconsIcon icon={Edit02Icon} size={14} />
								</Button>
							</Tooltip>
						) : null}
						<Tooltip content={labels.delete}>
							<Button
								aria-label={`${labels.delete} "${deleteLabelFor(entry)}"`}
								className="rounded bg-transparent p-1 text-error transition-colors duration-150 hover:bg-error-dim"
								onClick={() => onRemove(id)}
							>
								<HugeiconsIcon icon={Delete02Icon} size={14} />
							</Button>
						</Tooltip>
					</>
				)}
			</div>
		);
	};

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
		{
			cell: (ctx) => renderRowActions(ctx.row.original),
			enableGlobalFilter: false,
			enableHiding: false,
			enableResizing: false,
			enableSorting: false,
			header: () => null,
			id: "__actions",
			meta: {
				cellClassName: cn(actionColumnClassName, "text-right"),
				headClassName: actionColumnClassName,
			},
			...(resizable ? { size: 84 } : {}),
		},
	];

	const table = useReactTable<TEntry>({
		columns: columnDefs,
		data: entries,
		enableColumnResizing: resizable,
		enableSorting: sortable,
		getCoreRowModel: getCoreRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		getRowId: (entry) => getId(entry),
		getSortedRowModel: getSortedRowModel(),
		globalFilterFn: gridGlobalFilter,
		onColumnVisibilityChange: setColumnVisibility,
		onGlobalFilterChange: setGlobalFilter,
		onSortingChange: setSorting,
		state: paginated
			? { columnVisibility, globalFilter, pagination, sorting }
			: { columnVisibility, globalFilter, sorting },
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

	// Search/visibility/pagination chrome only makes sense with rows present;
	// keeping it off when empty also keeps the empty-state DOM minimal.
	const showChrome = entries.length > 0;

	const addInputGroup = (
		field: CrudField,
		isLast: boolean,
		error: string | undefined,
		joined: boolean
	): ReactNode => (
		<InputGroup
			appearance={joined ? "minimal" : "elevated"}
			className={cn(
				"h-9",
				joined &&
					"rounded-none bg-transparent shadow-none ring-0 hover:bg-transparent focus-within:bg-foreground/[0.04] focus-within:ring-0"
			)}
			data-crud-add-input-group={joined ? "true" : undefined}
			size="sm"
			tone={error ? "danger" : "default"}
		>
			<InputGroupAddon align="inline-start">
				<HugeiconsIcon aria-hidden="true" icon={field.icon} size={14} />
			</InputGroupAddon>
			<InputGroupInput
				aria-describedby={error ? addFieldErrorId(field.name) : undefined}
				aria-invalid={!!error}
				aria-label={field.label}
				name={field.name}
				onChange={(event) => setField(field.name, event.target.value)}
				placeholder={field.placeholder}
				value={values[field.name] ?? ""}
			/>
			{isLast ? (
				<InputGroupAddon align="inline-end">
					<InputGroupButton
						aria-label={labels.add}
						className={cn(joined && "rounded-none shadow-none ring-0")}
						disabled={isAddDisabled}
						tone={joined ? "ghost" : "surface"}
						type="submit"
					>
						<HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={2.25} />
					</InputGroupButton>
				</InputGroupAddon>
			) : null}
		</InputGroup>
	);

	return (
		<div className="flex flex-col gap-3">
			{/* Search + column-visibility chrome rides ABOVE the add row so the add
			    field flows straight into the table with nothing wedged between
			    them. The search mirrors this table's add-entry field (elevated for
			    the separate layout, minimal for joined) and carries the
			    column-visibility trigger in its trailing slot, so the two read as
			    one grouped control. */}
			{showChrome && (searchable || columnControls) ? (
				<DataGrid labels={dataGridLabels} resizable={resizable} table={table}>
					<DataGridToolbar
						appearance={addFormLayout === "joined" ? "minimal" : "elevated"}
						columnControls={columnControls}
						searchable={searchable}
					/>
				</DataGrid>
			) : null}
			{/* Add-an-entry row: each field sits in its own input-group; the Add
			    button lives in the trailing slot of the LAST field so the
			    field(s) + their action read as one control (the fluidfunctionalism
			    input-group recipe). */}
			<Form
				className={
					addFormLayout === "joined"
						? "flex flex-col gap-1.5"
						: fields.length > 1
							? "flex items-end gap-2"
							: undefined
				}
				onSubmit={handleSubmit}
			>
				{addFormLayout === "joined" ? (
					<>
						<div
							aria-hidden="true"
							className="flex text-2xs text-foreground-secondary"
						>
							{fields.map((field) => (
								<div
									className={cn("min-w-0 px-2", field.width ?? "flex-1")}
									key={field.name}
								>
									{field.label}
								</div>
							))}
						</div>
						<ButtonGroup
							aria-label={labels.add}
							className={cn(
								"w-full",
								hasAddErrors && "ring-error/45",
								"[&_[data-crud-add-input-group='true']]:h-9"
							)}
							connected
						>
							{fields.map((field, i) => {
								const isLast = i === fields.length - 1;
								const error = errors[field.name];
								return (
									<div
										className={cn("min-w-0", field.width ?? "flex-1")}
										key={field.name}
									>
										{addInputGroup(field, isLast, error, true)}
									</div>
								);
							})}
						</ButtonGroup>
						{hasAddErrors ? (
							<div className="flex gap-0">
								{fields.map((field) => {
									const error = errors[field.name];
									return (
										<div
											className={cn("min-w-0 px-2", field.width ?? "flex-1")}
											key={field.name}
										>
											{error ? (
												<div
													aria-live="assertive"
													className="text-error text-xs-tight leading-[14px]"
													id={addFieldErrorId(field.name)}
													role="alert"
												>
													{error}
												</div>
											) : null}
										</div>
									);
								})}
							</div>
						) : null}
					</>
				) : (
					fields.map((field, i) => {
						const isLast = i === fields.length - 1;
						const error = errors[field.name];
						const inputGroup = (
							<FormControl error={error} label={field.label}>
								{addInputGroup(field, isLast, error, false)}
							</FormControl>
						);
						return fields.length > 1 ? (
							<div className={field.width} key={field.name}>
								{inputGroup}
							</div>
						) : (
							<div key={field.name}>{inputGroup}</div>
						);
					})
				)}
			</Form>
			<DataGrid labels={dataGridLabels} resizable={resizable} table={table}>
				<DataGridContainer>
					<DataGridTable />
				</DataGridContainer>
				{showChrome && paginated ? (
					<DataGridPagination showPageSize={false} />
				) : null}
			</DataGrid>
			{onClearAll && (
				<>
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
					<Button
						className="h-7 gap-1.5 self-end rounded-md bg-error-dim/40 px-2.5 font-medium text-error text-xs ring-1 ring-error/25 transition-colors duration-150 hover:bg-error-dim/70 hover:ring-error/40 disabled:opacity-50"
						disabled={entries.length === 0}
						onClick={() => setClearConfirmOpen(true)}
					>
						<HugeiconsIcon aria-hidden="true" icon={Delete02Icon} size={14} />
						{labels.deleteAll}
					</Button>
				</>
			)}
		</div>
	);
}
