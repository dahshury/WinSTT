import type {
	ColumnPinningState,
	Row,
	TableMeta,
	VisibilityState,
} from "@tanstack/react-table";
import type { VirtualItem } from "@tanstack/react-virtual";
import * as React from "react";
import { DataGridCell } from "@/shared/ui/data-grid/data-grid-cell";
import { useComposedRefs } from "@/shared/ui/data-grid/lib/compose-refs";
import {
	flexRender,
	getCellKey,
	getColumnBorderVisibility,
	getColumnPinningStyle,
	getRowHeightValue,
} from "@/shared/ui/data-grid/lib/data-grid";
import { cn } from "@/shared/lib/cn";
import type {
	CellPosition,
	Direction,
	RowHeightValue,
} from "@/shared/ui/data-grid/types";

interface DataGridRowProps<TData> extends React.ComponentProps<"div"> {
	row: Row<TData>;
	tableMeta: TableMeta<TData>;
	virtualItem: VirtualItem;
	measureElement: (node: Element | null) => void;
	rowMapRef: React.RefObject<Map<number, HTMLDivElement>>;
	rowHeight: RowHeightValue;
	columnVisibility: VisibilityState;
	columnPinning: ColumnPinningState;
	focusedCell: CellPosition | null;
	editingCell: CellPosition | null;
	cellSelectionKeys: Set<string>;
	searchMatchColumns: Set<string> | null;
	activeSearchMatch: CellPosition | null;
	dir: Direction;
	readOnly: boolean;
	stretchColumns: boolean;
	adjustLayout: boolean;
}

export function DataGridRow<TData>({
	row,
	tableMeta,
	virtualItem,
	measureElement,
	rowMapRef,
	rowHeight,
	columnVisibility,
	columnPinning,
	focusedCell,
	editingCell,
	cellSelectionKeys,
	searchMatchColumns,
	activeSearchMatch,
	dir,
	readOnly,
	stretchColumns,
	adjustLayout,
	className,
	style,
	ref,
	...props
}: DataGridRowProps<TData>) {
	const virtualRowIndex = virtualItem.index;

	const onRowChange = (node: HTMLDivElement | null) => {
		if (typeof virtualRowIndex === "undefined") return;

		if (node) {
			measureElement(node);
			rowMapRef.current?.set(virtualRowIndex, node);
		} else {
			rowMapRef.current?.delete(virtualRowIndex);
		}
	};

	const rowRef = useComposedRefs(ref, onRowChange);

	const isRowSelected = row.getIsSelected();

	const visibleCells = row.getVisibleCells();

	return (
		<div
			key={row.id}
			// eslint-disable-next-line react-doctor/prefer-tag-over-role -- virtualized div grid requires ARIA grid roles; table elements break CSS-grid/virtualization
			role="row"
			aria-rowindex={virtualRowIndex + 2}
			aria-selected={isRowSelected}
			data-index={virtualRowIndex}
			data-slot="grid-row"
			tabIndex={-1}
			{...props}
			ref={rowRef}
			className={cn(
				"absolute flex w-full border-b transition-colors [content-visibility:auto] hover:bg-surface-5/60",
				!adjustLayout && "will-change-transform",
				className,
			)}
			style={{
				height: `${getRowHeightValue(rowHeight)}px`,
				...(adjustLayout
					? { top: `${virtualItem.start}px` }
					: { transform: `translateY(${virtualItem.start}px)` }),
				...style,
			}}
		>
			{visibleCells.map((cell, colIndex) => {
				const columnId = cell.column.id;

				const isCellFocused =
					focusedCell?.rowIndex === virtualRowIndex &&
					focusedCell?.columnId === columnId;
				const isCellEditing =
					editingCell?.rowIndex === virtualRowIndex &&
					editingCell?.columnId === columnId;
				const isCellSelected =
					cellSelectionKeys?.has(getCellKey(virtualRowIndex, columnId)) ??
					false;

				const isSearchMatch = searchMatchColumns?.has(columnId) ?? false;
				const isActiveSearchMatch = activeSearchMatch?.columnId === columnId;

				const nextCell = visibleCells[colIndex + 1];
				const isLastColumn = colIndex === visibleCells.length - 1;
				const { showEndBorder, showStartBorder } = getColumnBorderVisibility({
					column: cell.column,
					nextColumn: nextCell?.column,
					isLastColumn,
				});

				return (
					<div
						key={cell.id}
						// eslint-disable-next-line react-doctor/prefer-tag-over-role -- virtualized div grid requires ARIA grid roles; table elements break CSS-grid/virtualization
						role="gridcell"
						aria-colindex={colIndex + 1}
						data-highlighted={isCellFocused ? "" : undefined}
						data-slot="grid-cell"
						tabIndex={-1}
						className={cn({
							grow: stretchColumns && columnId !== "select",
							"border-e": showEndBorder && columnId !== "select",
							"border-s": showStartBorder && columnId !== "select",
						})}
						style={{
							...getColumnPinningStyle({ column: cell.column, dir }),
							width: `calc(var(--col-${columnId}-size) * 1px)`,
						}}
					>
						{typeof cell.column.columnDef.header === "function" ? (
							<div
								className={cn("size-full px-3 py-1.5", {
									"bg-primary/10": isRowSelected,
								})}
							>
								{flexRender(cell.column.columnDef.cell, cell.getContext())}
							</div>
						) : (
							<DataGridCell
								cell={cell}
								tableMeta={tableMeta}
								rowIndex={virtualRowIndex}
								columnId={columnId}
								rowHeight={rowHeight}
								state={{
									isEditing: isCellEditing,
									isFocused: isCellFocused,
									isSelected: isCellSelected,
									isSearchMatch,
									isActiveSearchMatch,
									readOnly,
								}}
							/>
						)}
					</div>
				);
			})}
		</div>
	);
}
