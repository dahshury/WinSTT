import type { ColumnDef, TableMeta } from "@tanstack/react-table";
import {
	CopyIcon,
	EraserIcon,
	ScissorsIcon,
	Trash2Icon,
} from "@/shared/ui/data-grid/primitives/icons";
import * as React from "react";
import { useTranslations } from "use-intl";
import { toast } from "@/shared/ui/data-grid/primitives/toast";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/shared/ui/data-grid/primitives/dropdown-menu";
import { useAsRef } from "@/shared/ui/data-grid/model/use-as-ref";
import {
	getEmptyCellValue,
	parseCellKey,
} from "@/shared/ui/data-grid/lib/data-grid";
import type { CellUpdate, ContextMenuState } from "@/shared/ui/data-grid/types";

interface DataGridContextMenuProps<TData> {
	tableMeta: TableMeta<TData>;
	columns: Array<ColumnDef<TData>>;
	contextMenu: ContextMenuState;
}

export function DataGridContextMenu<TData>({
	tableMeta,
	columns,
	contextMenu,
}: DataGridContextMenuProps<TData>) {
	const onContextMenuOpenChange = tableMeta?.onContextMenuOpenChange;
	const selectionState = tableMeta?.selectionState;
	const dataGridRef = tableMeta?.dataGridRef;
	const onDataUpdate = tableMeta?.onDataUpdate;
	const onRowsDelete = tableMeta?.onRowsDelete;
	const onCellsCopy = tableMeta?.onCellsCopy;
	const onCellsCut = tableMeta?.onCellsCut;

	if (!contextMenu.open) return null;

	return (
		<ContextMenu
			tableMeta={tableMeta}
			columns={columns}
			dataGridRef={dataGridRef}
			contextMenu={contextMenu}
			onContextMenuOpenChange={onContextMenuOpenChange}
			selectionState={selectionState}
			onDataUpdate={onDataUpdate}
			onRowsDelete={onRowsDelete}
			onCellsCopy={onCellsCopy}
			onCellsCut={onCellsCut}
		/>
	);
}

interface ContextMenuProps<TData>
	extends
		Pick<
			TableMeta<TData>,
			| "dataGridRef"
			| "onContextMenuOpenChange"
			| "selectionState"
			| "onDataUpdate"
			| "onRowsDelete"
			| "onCellsCopy"
			| "onCellsCut"
			| "readOnly"
		>,
		Required<Pick<TableMeta<TData>, "contextMenu">> {
	tableMeta: TableMeta<TData>;
	columns: Array<ColumnDef<TData>>;
}

function ContextMenu<TData>({
	tableMeta,
	columns,
	dataGridRef,
	contextMenu,
	onContextMenuOpenChange,
	selectionState,
	onDataUpdate,
	onRowsDelete,
	onCellsCopy,
	onCellsCut,
}: ContextMenuProps<TData>) {
	const t = useTranslations("dataGrid");
	const propsRef = useAsRef({
		dataGridRef,
		selectionState,
		onDataUpdate,
		onRowsDelete,
		onCellsCopy,
		onCellsCut,
		columns,
	});

	const triggerStyle: React.CSSProperties = {
		position: "fixed",
		left: `${contextMenu.x}px`,
		top: `${contextMenu.y}px`,
		width: "1px",
		height: "1px",
		padding: 0,
		margin: 0,
		border: "none",
		background: "transparent",
		pointerEvents: "none",
		opacity: 0,
	};

	const onCloseAutoFocus: NonNullable<
		React.ComponentProps<typeof DropdownMenuContent>["onCloseAutoFocus"]
	> = (event) => {
		event.preventDefault();
		propsRef.current.dataGridRef?.current?.focus();
	};

	const onCopy = () => {
		propsRef.current.onCellsCopy?.();
	};

	const onCut = () => {
		propsRef.current.onCellsCut?.();
	};

	const onClear = () => {
		const { selectionState, columns, onDataUpdate } = propsRef.current;

		if (
			!selectionState?.selectedCells ||
			selectionState.selectedCells.size === 0
		)
			return;

		const updates: Array<CellUpdate> = [];

		// Build columnId -> column lookup once before the loop
		const columnById = new Map<string, (typeof columns)[number]>();
		for (const col of columns) {
			if (col.id) {
				columnById.set(col.id, col);
			} else if ("accessorKey" in col && typeof col.accessorKey === "string") {
				columnById.set(col.accessorKey, col);
			}
		}

		for (const cellKey of selectionState.selectedCells) {
			const { rowIndex, columnId } = parseCellKey(cellKey);

			const column = columnById.get(columnId);
			const cellVariant = column?.meta?.cell?.variant;

			const emptyValue = getEmptyCellValue(cellVariant);

			updates.push({ rowIndex, columnId, value: emptyValue });
		}

		onDataUpdate?.(updates);

		toast.success(
			`${updates.length} cell${updates.length !== 1 ? "s" : ""} cleared`,
		);
	};

	const onDelete = async () => {
		const { selectionState, onRowsDelete } = propsRef.current;

		if (
			!selectionState?.selectedCells ||
			selectionState.selectedCells.size === 0
		)
			return;

		const rowIndices = new Set<number>();
		for (const cellKey of selectionState.selectedCells) {
			const { rowIndex } = parseCellKey(cellKey);
			rowIndices.add(rowIndex);
		}

		const rowIndicesArray = Array.from(rowIndices).sort((a, b) => a - b);
		const rowCount = rowIndicesArray.length;

		await onRowsDelete?.(rowIndicesArray);

		toast.success(`${rowCount} row${rowCount !== 1 ? "s" : ""} deleted`);
	};

	return (
		<DropdownMenu
			open={contextMenu.open}
			onOpenChange={onContextMenuOpenChange}
		>
			<DropdownMenuTrigger style={triggerStyle} />
			<DropdownMenuContent
				data-grid-popover=""
				align="start"
				className="w-48"
				onCloseAutoFocus={onCloseAutoFocus}
			>
				<DropdownMenuItem onSelect={onCopy}>
					<CopyIcon />
					{t("copy")}
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={onCut} disabled={tableMeta?.readOnly}>
					<ScissorsIcon />
					{t("cut")}
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={onClear} disabled={tableMeta?.readOnly}>
					<EraserIcon />
					{t("clearCells")}
				</DropdownMenuItem>
				{onRowsDelete && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem variant="destructive" onSelect={onDelete}>
							<Trash2Icon />
							{t("deleteRows")}
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
