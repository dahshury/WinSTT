import { Plus } from "@/shared/ui/data-grid/primitives/icons";
import * as React from "react";
import { useTranslations } from "use-intl";
import { DataGridColumnHeader } from "@/shared/ui/data-grid/data-grid-column-header";
import { DataGridContextMenu } from "@/shared/ui/data-grid/data-grid-context-menu";
import { DataGridPasteDialog } from "@/shared/ui/data-grid/data-grid-paste-dialog";
import { DataGridRow } from "@/shared/ui/data-grid/data-grid-row";
import { DataGridSearch } from "@/shared/ui/data-grid/data-grid-search";
import { useAsRef } from "@/shared/ui/data-grid/model/use-as-ref";
import type { useDataGrid } from "@/shared/ui/data-grid/model/use-data-grid";
import {
	flexRender,
	getColumnBorderVisibility,
	getColumnPinningStyle,
} from "@/shared/ui/data-grid/lib/data-grid";
import { cn } from "@/shared/lib/cn";
import type { Direction } from "@/shared/ui/data-grid/types";

const EMPTY_CELL_SELECTION_SET = new Set<string>();

function onDataGridContextMenu(event: React.MouseEvent<HTMLDivElement>) {
	event.preventDefault();
}

interface DataGridProps<TData>
	extends
		Omit<ReturnType<typeof useDataGrid<TData>>, "dir">,
		Omit<React.ComponentProps<"div">, "contextMenu"> {
	dir?: Direction;
	height?: number;
	stretchColumns?: boolean;
}

export function DataGrid<TData>({
	dataGridRef,
	headerRef,
	rowMapRef,
	footerRef,
	dir = "ltr",
	table,
	tableMeta,
	virtualTotalSize,
	virtualItems,
	measureElement,
	columns,
	columnSizeVars,
	searchState,
	searchMatchesByRow,
	activeSearchMatch,
	cellSelectionMap,
	focusedCell,
	editingCell,
	rowHeight,
	contextMenu,
	pasteDialog,
	onRowAdd: onRowAddProp,
	height = 600,
	stretchColumns = false,
	adjustLayout = false,
	className,
	...props
}: DataGridProps<TData>) {
	const t = useTranslations("dataGrid");
	const rows = table.getRowModel().rows;
	const readOnly = tableMeta?.readOnly ?? false;
	const columnVisibility = table.getState().columnVisibility;
	const columnPinning = table.getState().columnPinning;

	const onRowAddRef = useAsRef(onRowAddProp);

	const onRowAdd = (event: React.MouseEvent<HTMLDivElement>) => {
		onRowAddRef.current?.(event);
	};

	const onFooterCellKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (!onRowAddRef.current) return;

		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			onRowAddRef.current();
		}
	};

	return (
		<div
			data-slot="grid-wrapper"
			dir={dir}
			{...props}
			className={cn("relative flex w-full flex-col", className)}
		>
			{searchState && <DataGridSearch {...searchState} />}
			<DataGridContextMenu
				tableMeta={tableMeta}
				columns={columns}
				contextMenu={contextMenu}
			/>
			<DataGridPasteDialog tableMeta={tableMeta} pasteDialog={pasteDialog} />
			<div
				role="grid"
				aria-label="Data grid"
				aria-rowcount={rows.length + (onRowAddProp ? 1 : 0)}
				aria-colcount={columns.length}
				data-slot="grid"
				tabIndex={0}
				ref={dataGridRef}
				className="relative grid select-none overflow-auto rounded-lg border border-border bg-surface-4 shadow-surface-4 focus:outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
				style={{
					...columnSizeVars,
					maxHeight: `${height}px`,
				}}
				onContextMenu={onDataGridContextMenu}
			>
				<div
					// eslint-disable-next-line react-doctor/prefer-tag-over-role -- virtualized div grid requires ARIA grid roles; table elements break CSS-grid/virtualization
					role="rowgroup"
					data-slot="grid-header"
					ref={headerRef}
					className="sticky top-0 z-raised grid border-b border-border bg-surface-5"
				>
					{table.getHeaderGroups().map((headerGroup, rowIndex) => (
						<div
							key={headerGroup.id}
							// eslint-disable-next-line react-doctor/prefer-tag-over-role -- virtualized div grid requires ARIA grid roles; table elements break CSS-grid/virtualization
							role="row"
							aria-rowindex={rowIndex + 1}
							data-slot="grid-header-row"
							tabIndex={-1}
							className="flex w-full"
						>
							{headerGroup.headers.map((header, colIndex) => {
								const sorting = table.getState().sorting;
								const currentSort = sorting.find(
									(sort) => sort.id === header.column.id,
								);
								const isSortable = header.column.getCanSort();

								const nextHeader = headerGroup.headers[colIndex + 1];
								const isLastColumn =
									colIndex === headerGroup.headers.length - 1;

								const { showEndBorder, showStartBorder } =
									getColumnBorderVisibility({
										column: header.column,
										nextColumn: nextHeader?.column,
										isLastColumn,
									});

								return (
									<div
										key={header.id}
										// eslint-disable-next-line react-doctor/prefer-tag-over-role -- virtualized div grid requires ARIA grid roles; table elements break CSS-grid/virtualization
										role="columnheader"
										aria-colindex={colIndex + 1}
										aria-sort={
											currentSort?.desc === false
												? "ascending"
												: currentSort?.desc === true
													? "descending"
													: isSortable
														? "none"
														: undefined
										}
										data-slot="grid-header-cell"
										tabIndex={-1}
										className={cn("relative", {
											grow: stretchColumns && header.column.id !== "select",
											"border-e":
												showEndBorder && header.column.id !== "select",
											"border-s":
												showStartBorder && header.column.id !== "select",
										})}
										style={{
											...getColumnPinningStyle({ column: header.column, dir }),
											width: `calc(var(--header-${header.id}-size) * 1px)`,
										}}
									>
										{header.isPlaceholder ? null : typeof header.column
												.columnDef.header === "function" ? (
											<div className="size-full px-3 py-1.5">
												{flexRender(
													header.column.columnDef.header,
													header.getContext(),
												)}
											</div>
										) : (
											<DataGridColumnHeader header={header} table={table} />
										)}
									</div>
								);
							})}
						</div>
					))}
				</div>
				<div
					// eslint-disable-next-line react-doctor/prefer-tag-over-role -- virtualized div grid requires ARIA grid roles; table elements break CSS-grid/virtualization
					role="rowgroup"
					data-slot="grid-body"
					className="relative grid"
					style={{
						height: `${virtualTotalSize}px`,
						contain: adjustLayout ? "layout paint" : "strict",
					}}
				>
					{virtualItems.map((virtualItem) => {
						const row = rows[virtualItem.index];
						if (!row) return null;

						const cellSelectionKeys =
							cellSelectionMap?.get(virtualItem.index) ??
							EMPTY_CELL_SELECTION_SET;

						const searchMatchColumns =
							searchMatchesByRow?.get(virtualItem.index) ?? null;
						const isActiveSearchRow =
							activeSearchMatch?.rowIndex === virtualItem.index;

						return (
							<DataGridRow
								key={row.id}
								row={row}
								tableMeta={tableMeta}
								rowMapRef={rowMapRef}
								virtualItem={virtualItem}
								measureElement={measureElement}
								rowHeight={rowHeight}
								columnVisibility={columnVisibility}
								columnPinning={columnPinning}
								focusedCell={focusedCell}
								editingCell={editingCell}
								cellSelectionKeys={cellSelectionKeys}
								searchMatchColumns={searchMatchColumns}
								activeSearchMatch={isActiveSearchRow ? activeSearchMatch : null}
								dir={dir}
								adjustLayout={adjustLayout}
								stretchColumns={stretchColumns}
								readOnly={readOnly}
							/>
						);
					})}
				</div>
				{/* eslint-disable-next-line react-hooks-js/refs -- onRowAdd is a stable render-time function, not a ref accessed during render; ref read happens only inside the handler */}
				{!readOnly && onRowAdd && (
					<div
						// eslint-disable-next-line react-doctor/prefer-tag-over-role -- virtualized div grid requires ARIA grid roles; table elements break CSS-grid/virtualization
						role="rowgroup"
						data-slot="grid-footer"
						ref={footerRef}
						className="sticky bottom-0 z-raised grid border-t border-border bg-surface-5"
					>
						<div
							// eslint-disable-next-line react-doctor/prefer-tag-over-role -- virtualized div grid requires ARIA grid roles; table elements break CSS-grid/virtualization
							role="row"
							aria-rowindex={rows.length + 2}
							data-slot="grid-add-row"
							tabIndex={-1}
							className="flex w-full"
						>
							<div
								// eslint-disable-next-line react-doctor/prefer-tag-over-role -- virtualized div grid requires ARIA grid roles; table elements break CSS-grid/virtualization
								role="gridcell"
								tabIndex={0}
								className="relative flex h-9 grow items-center bg-transparent transition-colors hover:bg-surface-6 focus:bg-surface-6 focus:outline-none"
								style={{
									width: table.getTotalSize(),
									minWidth: table.getTotalSize(),
								}}
								onClick={onRowAdd}
								onKeyDown={onFooterCellKeyDown}
							>
								<div className="sticky start-0 flex items-center gap-2 px-3 text-muted-foreground">
									<Plus className="size-3.5" />
									<span className="text-sm">{t("addRow")}</span>
								</div>
							</div>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
