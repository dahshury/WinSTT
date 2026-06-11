import { Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { RowSelectionState } from "@tanstack/react-table";
import { useEffect, useState } from "react";
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

	const table = useCrudGrid<TEntry, TAdd>({
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
	});

	const dataGridLabels = useCrudGridLabels(labels.emptyState);

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
		<ElevatedSurface className="flex flex-col gap-2.5 p-2">
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
				tableLayout={CRUD_GRID_TABLE_LAYOUT}
			>
				<DataGridContainer
					border={false}
					className="rounded-lg bg-surface-3/70 p-1 shadow-surface-1 ring-1 ring-divider/70"
				>
					<DataGridTable />
				</DataGridContainer>
				{showPagination ? (
					<DataGridPagination actions={deleteAllControl} showPageSize={false} />
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
		</ElevatedSurface>
	);
}
