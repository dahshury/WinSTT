import {
	CheckmarkBadge01Icon,
	Delete02Icon,
	LeftToRightListBulletIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { RowSelectionState } from "@tanstack/react-table";
import { useState } from "react";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import {
	DataGrid,
	DataGridContainer,
	type DataGridTableLayout,
	DataGridPagination,
	DataGridTable,
	DataGridToolbar,
} from "@/shared/ui/data-grid";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { CrudAddForm } from "./CrudAddForm";
import { type CrudTableProps, DEFAULT_PAGE_SIZE } from "./types";
import { useCrudEditing } from "./use-crud-editing";
import { useCrudForm } from "./use-crud-form";
import { useCrudGrid } from "./use-crud-grid";
import { useCrudGridLabels } from "./use-crud-grid-labels";

const CRUD_GRID_TABLE_LAYOUT = {
	cellBorder: false,
	dense: true,
	headerBackground: true,
	headerBorder: false,
	presentation: "layered",
	rowBorder: false,
	striped: false,
	width: "auto",
} satisfies DataGridTableLayout;

export type {
	CrudColumn,
	CrudField,
	CrudTableLabels,
	CrudTableProps,
} from "./types";

/**
 * A scrollable add/list/delete table — the shared engine behind the Dictionary
 * and Snippets settings tables (and any future "manage a small list" control).
 * Caller supplies the entry columns, the add-form fields, a Zod schema for the
 * add row, and the CRUD callbacks; everything else (the add field-group with its
 * inline Add button, the selected-row delete action, the scroll frame, per-row
 * edit, the empty state, and the guarded clear-all) is identical across
 * consumers and lives here once. The list is a TanStack Table v8 data grid
 * (sorting, search, pagination, column visibility + resize) built by
 * {@link useCrudGrid} and rendered through `@/shared/ui/data-grid`; the features
 * are opt-in per consumer via the corresponding props.
 */
export function CrudTable<TEntry, TAdd>({
	addFormLayout = "separate",
	columns,
	columnControls = false,
	deleteLabelFor,
	emptyIcon,
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
	const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
	const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

	const form = useCrudForm({ fields, schema, onAdd });
	const editing = useCrudEditing({
		fields,
		schema,
		getId,
		getEditValues,
		onUpdate,
		updateSchema,
	});

	const validIds = new Set(entries.map((entry) => getId(entry)));
	const visibleRowSelection = Object.entries(
		rowSelection,
	).reduce<RowSelectionState>((next, [id, selected]) => {
		if (selected && validIds.has(id)) {
			next[id] = true;
		}
		return next;
	}, {});

	const selectedIds = Object.entries(visibleRowSelection).reduce<string[]>(
		(acc, [id, selected]) => {
			if (selected) {
				acc.push(id);
			}
			return acc;
		},
		[],
	);
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

	const table = useCrudGrid<TEntry>({
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
		rowSelection: visibleRowSelection,
		selectAllLabel,
		setRowSelection,
		sortable,
	});

	const dataGridLabels = useCrudGridLabels(labels.emptyState);

	const isEmpty = entries.length === 0;
	const showToolbar = searchable || columnControls;
	const showPagination = paginated && !isEmpty;
	const deleteAllControl = onClearAll ? (
		<Button
			className="h-7 gap-1.5 rounded-md bg-error-dim/40 px-2.5 font-medium text-error text-xs ring-1 ring-error/25 transition-colors duration-150 hover:bg-error-dim/70 hover:ring-error/40 disabled:opacity-50"
			disabled={isEmpty}
			onClick={() => setClearConfirmOpen(true)}
		>
			<HugeiconsIcon aria-hidden="true" icon={Delete02Icon} size={14} />
			{labels.deleteAll}
		</Button>
	) : null;

	return (
		<ElevatedSurface className="flex flex-col gap-2.5 p-2.5">
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
					tableLayout={CRUD_GRID_TABLE_LAYOUT}
				>
					<DataGridToolbar
						appearance={addFormLayout === "joined" ? "minimal" : "elevated"}
						columnControls={columnControls}
						searchable={searchable}
					/>
				</DataGrid>
			) : null}
			{/* The add-entry field is the card's primary affordance, so it spans the
			    full width on its own row. The destructive selected-row action no
			    longer rides alongside it — it surfaces contextually below. */}
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
			{/* Contextual selection bar: it animates in only once rows are picked,
			    so the resting card stays clean and the destructive action appears
			    exactly when it becomes actionable (count on the left, delete on the
			    right). */}
			{selectedCount > 0 ? (
				<div className="flex animate-fade-in items-center justify-between gap-3 rounded-lg bg-accent/10 px-3 py-1.5 ring-1 ring-accent/25">
					<span className="flex items-center gap-1.5 text-foreground text-xs-tight">
						<HugeiconsIcon
							aria-hidden="true"
							className="text-accent"
							icon={CheckmarkBadge01Icon}
							size={15}
						/>
						<span className="font-semibold tabular-nums">{selectedCount}</span>
					</span>
					<Button
						aria-label={deleteSelectedLabel}
						className="h-7 shrink-0 gap-1.5 rounded-md bg-error-dim/50 px-2.5 font-medium text-error text-xs ring-1 ring-error/30 transition-colors duration-150 hover:bg-error-dim/80 hover:ring-error/50"
						onClick={handleRemoveSelected}
					>
						<HugeiconsIcon aria-hidden="true" icon={Delete02Icon} size={14} />
						<span>{deleteSelectedLabel}</span>
					</Button>
				</div>
			) : null}
			{isEmpty ? (
				<div className="flex animate-fade-in flex-col items-center justify-center gap-3 rounded-lg bg-surface-3/40 px-6 py-10 text-center shadow-surface-1 ring-1 ring-divider/60">
					<div className="flex size-11 items-center justify-center rounded-full bg-surface-5/70 text-foreground-muted shadow-surface-2 ring-1 ring-divider">
						<HugeiconsIcon
							aria-hidden="true"
							icon={emptyIcon ?? LeftToRightListBulletIcon}
							size={20}
						/>
					</div>
					<p className="max-w-[36ch] text-balance text-body-sm text-foreground-secondary">
						{labels.emptyState}
					</p>
				</div>
			) : (
				<DataGrid
					labels={dataGridLabels}
					resizable={resizable}
					table={table}
					tableLayout={CRUD_GRID_TABLE_LAYOUT}
				>
					{/* Inner core of the nested card: its own fill + hairline ring,
					    a slightly tighter radius than the outer shell so the two
					    read as concentric machined surfaces. */}
					<DataGridContainer
						border={false}
						className="rounded-lg bg-surface-3/55 p-1 shadow-surface-1 ring-1 ring-divider/60"
					>
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
			)}
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
		</ElevatedSurface>
	);
}
