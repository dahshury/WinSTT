import {
	type ColumnDef,
	type ColumnFiltersState,
	getCoreRowModel,
	getFilteredRowModel,
	getSortedRowModel,
	type Row,
	type RowSelectionState,
	type SortingState,
	type TableMeta,
	type TableOptions,
	type Updater,
	useReactTable,
} from "@tanstack/react-table";
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import * as React from "react";
import { toast } from "@/shared/ui/data-grid/primitives/toast";
import { useDirection } from "@/shared/ui/data-grid/primitives/direction";

import { useAsRef } from "@/shared/ui/data-grid/model/use-as-ref";
import { useIsomorphicLayoutEffect } from "@/shared/ui/data-grid/model/use-isomorphic-layout-effect";
import { useLazyRef } from "@/shared/ui/data-grid/model/use-lazy-ref";
import {
	getCellKey,
	getEmptyCellValue,
	getIsFileCellData,
	getIsInPopover,
	getRowHeightValue,
	getScrollDirection,
	matchSelectOption,
	parseCellKey,
	parseTsv,
	scrollCellIntoView,
} from "@/shared/ui/data-grid/lib/data-grid";
import type {
	CellPosition,
	CellUpdate,
	ContextMenuState,
	Direction,
	FileCellData,
	NavigationDirection,
	PasteDialogState,
	RowHeightValue,
	SelectionState,
} from "@/shared/ui/data-grid/types";

const DEFAULT_ROW_HEIGHT = "short";
const OVERSCAN = 6;
const VIEWPORT_OFFSET = 1;
const HORIZONTAL_PAGE_SIZE = 5;
const SCROLL_SYNC_RETRY_COUNT = 16;
const MIN_COLUMN_SIZE = 60;
const MAX_COLUMN_SIZE = 800;
const SEARCH_SHORTCUT_KEY = "f";
const NON_NAVIGABLE_COLUMN_IDS = new Set(["select", "actions"]);
const AUTO_SCROLL_EDGE_ZONE = 50;
const AUTO_SCROLL_SPEED_RAMP_ZONE = AUTO_SCROLL_EDGE_ZONE * 3;
const AUTO_SCROLL_MIN_SPEED = 8;
const AUTO_SCROLL_MAX_SPEED = 40;
const AUTO_SCROLL_SELECTION_THROTTLE_MS = 32;

const DOMAIN_REGEX = /^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}.*)?$/;
const TRUTHY_BOOLEANS = new Set(["true", "1", "yes", "checked"]);
const VALID_BOOLEANS = new Set([
	"true",
	"false",
	"1",
	"0",
	"yes",
	"no",
	"checked",
	"unchecked",
]);

function restoreFocus(element: HTMLDivElement | null) {
	if (element && document.activeElement !== element) {
		requestAnimationFrame(() => {
			element.focus();
		});
	}
}

interface DataGridState {
	sorting: SortingState;
	columnFilters: ColumnFiltersState;
	rowHeight: RowHeightValue;
	rowSelection: RowSelectionState;
	selectionState: SelectionState;
	focusedCell: CellPosition | null;
	editingCell: CellPosition | null;
	cutCells: Set<string>;
	contextMenu: ContextMenuState;
	searchQuery: string;
	searchMatches: CellPosition[];
	matchIndex: number;
	searchOpen: boolean;
	lastClickedRowId: string | null;
	pasteDialog: PasteDialogState;
}

interface DataGridStore {
	subscribe: (callback: () => void) => () => void;
	getState: () => DataGridState;
	setState: <K extends keyof DataGridState>(
		key: K,
		value: DataGridState[K],
	) => void;
	notify: () => void;
	batch: (fn: () => void) => void;
}

function useStore<T>(
	store: DataGridStore,
	selector: (state: DataGridState) => T,
): T {
	const getSnapshot = () => selector(store.getState());

	return React.useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

interface UseDataGridProps<TData> extends Omit<
	TableOptions<TData>,
	"pageCount" | "getCoreRowModel"
> {
	onDataChange?: (data: TData[]) => void;
	onRowAdd?: (
		event?: React.MouseEvent<HTMLDivElement>,
	) => Partial<CellPosition> | Promise<Partial<CellPosition> | null> | null;
	onRowsAdd?: (count: number) => void | Promise<void>;
	onRowsDelete?: (rows: TData[], rowIndices: number[]) => void | Promise<void>;
	onPaste?: (updates: Array<CellUpdate>) => void | Promise<void>;
	onFilesUpload?: (params: {
		files: File[];
		rowIndex: number;
		columnId: string;
	}) => Promise<FileCellData[]>;
	onFilesDelete?: (params: {
		fileIds: string[];
		rowIndex: number;
		columnId: string;
	}) => void | Promise<void>;
	rowHeight?: RowHeightValue;
	onRowHeightChange?: (rowHeight: RowHeightValue) => void;
	overscan?: number;
	dir?: Direction;
	autoFocus?: boolean | Partial<CellPosition>;
	enableSingleCellSelection?: boolean;
	enableColumnSelection?: boolean;
	enableSearch?: boolean;
	enablePaste?: boolean;
	readOnly?: boolean;
}

function useDataGrid<TData>({
	data,
	columns,
	rowHeight: rowHeightProp = DEFAULT_ROW_HEIGHT,
	overscan = OVERSCAN,
	dir: dirProp,
	initialState,
	...props
}: UseDataGridProps<TData>) {
	const dir = useDirection(dirProp);
	const dataGridRef = React.useRef<HTMLDivElement>(null);
	const tableRef = React.useRef<ReturnType<typeof useReactTable<TData>>>(null);
	const rowVirtualizerRef =
		React.useRef<Virtualizer<HTMLDivElement, Element>>(null);
	const headerRef = React.useRef<HTMLDivElement>(null);
	const rowMapRef = React.useRef<Map<number, HTMLDivElement>>(
		React.useState(() => new Map<number, HTMLDivElement>())[0],
	);
	const cellMapRef = React.useState<{ current: Map<string, HTMLDivElement> }>(
		() => ({ current: new Map<string, HTMLDivElement>() }),
	)[0];
	const footerRef = React.useRef<HTMLDivElement>(null);
	const focusGuardRef = React.useRef(false);

	const propsRef = useAsRef({
		...props,
		data,
		columns,
		initialState,
	});

	const listenersRef = useLazyRef(() => new Set<() => void>());

	const stateRef = useLazyRef<DataGridState>(() => {
		return {
			sorting: initialState?.sorting ?? [],
			columnFilters: initialState?.columnFilters ?? [],
			rowHeight: rowHeightProp,
			rowSelection: initialState?.rowSelection ?? {},
			selectionState: {
				selectedCells: new Set(),
				selectionRange: null,
				isSelecting: false,
			},
			focusedCell: null,
			editingCell: null,
			cutCells: new Set(),
			contextMenu: {
				open: false,
				x: 0,
				y: 0,
			},
			searchQuery: "",
			searchMatches: [],
			matchIndex: -1,
			searchOpen: false,
			lastClickedRowId: null,
			pasteDialog: {
				open: false,
				rowsNeeded: 0,
				clipboardText: "",
			},
		};
	});

	// eslint-disable-next-line react-doctor/react-compiler-no-manual-memoization -- store carries internal mutable closure state (isBatching/pendingNotification) and must keep a single stable identity across renders; it is the central external-store object consumed by useSyncExternalStore and dozens of callbacks. Inlining (IIFE) would recreate it every render and break the grid.
	const store = React.useMemo<DataGridStore>(() => {
		let isBatching = false;
		let pendingNotification = false;

		return {
			subscribe: (callback) => {
				listenersRef.current.add(callback);
				return () => listenersRef.current.delete(callback);
			},
			getState: () => stateRef.current,
			setState: (key, value) => {
				if (Object.is(stateRef.current[key], value)) return;
				stateRef.current[key] = value;

				if (isBatching) {
					pendingNotification = true;
				} else {
					if (!pendingNotification) {
						pendingNotification = true;
						queueMicrotask(() => {
							pendingNotification = false;
							store.notify();
						});
					}
				}
			},
			notify: () => {
				for (const listener of listenersRef.current) {
					listener();
				}
			},
			batch: (fn) => {
				if (isBatching) {
					fn();
					return;
				}

				isBatching = true;
				const wasPending = pendingNotification;
				pendingNotification = false;

				try {
					fn();
				} finally {
					isBatching = false;
					if (pendingNotification || wasPending) {
						pendingNotification = false;
						store.notify();
					}
				}
			},
		};
	}, [listenersRef, stateRef]);

	const focusedCell = useStore(store, (state) => state.focusedCell);
	const editingCell = useStore(store, (state) => state.editingCell);
	const selectionState = useStore(store, (state) => state.selectionState);
	const searchQuery = useStore(store, (state) => state.searchQuery);
	const searchMatches = useStore(store, (state) => state.searchMatches);
	const matchIndex = useStore(store, (state) => state.matchIndex);
	const searchOpen = useStore(store, (state) => state.searchOpen);
	const sorting = useStore(store, (state) => state.sorting);
	const columnFilters = useStore(store, (state) => state.columnFilters);
	const rowSelection = useStore(store, (state) => state.rowSelection);
	const rowHeight = useStore(store, (state) => state.rowHeight);
	const contextMenu = useStore(store, (state) => state.contextMenu);
	const pasteDialog = useStore(store, (state) => state.pasteDialog);

	const rowHeightValue = getRowHeightValue(rowHeight);

	const prevCellSelectionMapRef = useLazyRef(
		() => new Map<number, Set<string>>(),
	);

	// Memoize per-row selection sets to prevent unnecessary row re-renders
	// Each row gets a stable Set reference that only changes when its cells' selection changes
	// eslint-disable-next-line react-doctor/react-compiler-no-manual-memoization -- factory reads and mutates prevCellSelectionMapRef.current during render to recycle stable Set identities; the explicit memo guarantees this runs once per selectedCells change. The compiler does not guarantee the timing of this render-phase ref mutation, so removing the memo risks unstable per-row Set identities (extra row re-renders).
	const cellSelectionMap = React.useMemo(() => {
		const selectedCells = selectionState.selectedCells;

		if (selectedCells.size === 0) {
			prevCellSelectionMapRef.current.clear();
			return null;
		}

		const newRowCells = new Map<number, Set<string>>();
		for (const cellKey of selectedCells) {
			const { rowIndex } = parseCellKey(cellKey);
			let rowSet = newRowCells.get(rowIndex);
			if (!rowSet) {
				rowSet = new Set<string>();
				newRowCells.set(rowIndex, rowSet);
			}
			rowSet.add(cellKey);
		}

		const stableMap = new Map<number, Set<string>>();
		for (const [rowIndex, newSet] of newRowCells) {
			const prevSet = prevCellSelectionMapRef.current.get(rowIndex);
			if (
				prevSet &&
				prevSet.size === newSet.size &&
				[...newSet].every((key) => prevSet.has(key))
			) {
				stableMap.set(rowIndex, prevSet);
			} else {
				stableMap.set(rowIndex, newSet);
			}
		}

		prevCellSelectionMapRef.current = stableMap;
		return stableMap;
	}, [selectionState.selectedCells, prevCellSelectionMapRef]);

	const visualRowIndexCacheRef = React.useRef<{
		rows: Row<TData>[] | null;
		map: Map<string, number>;
	} | null>(null);

	// Pre-compute visual row index map for O(1) lookups (used by select column)
	// Cache is invalidated when row model identity changes (sorting/filtering)
	const getVisualRowIndex = (rowId: string): number | undefined => {
		const rows = tableRef.current?.getRowModel().rows;
		if (!rows) return undefined;

		if (visualRowIndexCacheRef.current?.rows !== rows) {
			const map = new Map<string, number>();
			for (const [i, row] of rows.entries()) {
				map.set(row.id, i + 1);
			}
			visualRowIndexCacheRef.current = { rows, map };
		}

		return visualRowIndexCacheRef.current.map.get(rowId);
	};

	const columnIds = columns
		.map((c) => {
			if (c.id) return c.id;
			if ("accessorKey" in c) return c.accessorKey as string;
			return undefined;
		})
		.filter((id): id is string => Boolean(id));

	const navigableColumnIds = columnIds.filter(
		(c) => !NON_NAVIGABLE_COLUMN_IDS.has(c),
	);

	const onDataUpdate = (updates: CellUpdate | Array<CellUpdate>) => {
		if (propsRef.current.readOnly) return;

		const updateArray = Array.isArray(updates) ? updates : [updates];

		if (updateArray.length === 0) return;

		const currentTable = tableRef.current;
		const currentData = propsRef.current.data;
		const rows = currentTable?.getRowModel().rows;

		// Build an index map once to avoid repeated O(n) indexOf() lookups in the loop
		const dataIndexMap = new Map<TData, number>();
		for (let i = 0; i < currentData.length; i++) {
			const item = currentData[i];
			if (item !== undefined && !dataIndexMap.has(item)) {
				dataIndexMap.set(item, i);
			}
		}

		const rowUpdatesMap = new Map<
			number,
			Array<Omit<CellUpdate, "rowIndex">>
		>();

		for (const update of updateArray) {
			if (!rows || !currentTable) {
				const existingUpdates = rowUpdatesMap.get(update.rowIndex) ?? [];
				existingUpdates.push({
					columnId: update.columnId,
					value: update.value,
				});
				rowUpdatesMap.set(update.rowIndex, existingUpdates);
			} else {
				const row = rows[update.rowIndex];
				if (!row) continue;

				const originalData = row.original;
				const originalRowIndex = dataIndexMap.get(originalData) ?? -1;

				const targetIndex =
					originalRowIndex !== -1 ? originalRowIndex : update.rowIndex;

				const existingUpdates = rowUpdatesMap.get(targetIndex) ?? [];
				existingUpdates.push({
					columnId: update.columnId,
					value: update.value,
				});
				rowUpdatesMap.set(targetIndex, existingUpdates);
			}
		}

		const maxUpdateIndex =
			rowUpdatesMap.size > 0
				? Math.max(...Array.from(rowUpdatesMap.keys()))
				: -1;
		const dataLength = Math.max(currentData.length, maxUpdateIndex + 1);

		const newData: TData[] = new Array(dataLength);

		for (let i = 0; i < dataLength; i++) {
			const updates = rowUpdatesMap.get(i);
			// Fall back to the table's row data for rows not yet in currentData
			const existingRow = currentData[i] ?? rows?.[i]?.original;

			if (existingRow == null) continue;

			if (updates) {
				const updatedRow = { ...existingRow } as Record<string, unknown>;
				for (const { columnId, value } of updates) {
					updatedRow[columnId] = value;
				}
				newData[i] = updatedRow as TData;
			} else {
				newData[i] = existingRow;
			}
		}

		propsRef.current.onDataChange?.(newData);
	};

	const getIsCellSelected = (rowIndex: number, columnId: string) => {
		const currentSelectionState = store.getState().selectionState;
		return currentSelectionState.selectedCells.has(
			getCellKey(rowIndex, columnId),
		);
	};

	const onSelectionClear = () => {
		store.batch(() => {
			store.setState("selectionState", {
				selectedCells: new Set(),
				selectionRange: null,
				isSelecting: false,
			});
			store.setState("rowSelection", {});
		});
	};

	const selectAll = () => {
		const allCells = new Set<string>();
		const currentTable = tableRef.current;
		const rows = currentTable?.getRowModel().rows ?? [];
		const rowCount = rows.length ?? propsRef.current.data.length;

		for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
			for (const columnId of columnIds) {
				allCells.add(getCellKey(rowIndex, columnId));
			}
		}

		const firstColumnId = columnIds[0];
		const lastColumnId = columnIds[columnIds.length - 1];

		store.setState("selectionState", {
			selectedCells: allCells,
			selectionRange:
				columnIds.length > 0 && rowCount > 0 && firstColumnId && lastColumnId
					? {
							start: { rowIndex: 0, columnId: firstColumnId },
							end: { rowIndex: rowCount - 1, columnId: lastColumnId },
						}
					: null,
			isSelecting: false,
		});
	};

	const selectColumn = (columnId: string) => {
		const currentTable = tableRef.current;
		const rows = currentTable?.getRowModel().rows ?? [];
		const rowCount = rows.length ?? propsRef.current.data.length;

		if (rowCount === 0) return;

		const selectedCells = new Set<string>();

		for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
			selectedCells.add(getCellKey(rowIndex, columnId));
		}

		store.setState("selectionState", {
			selectedCells,
			selectionRange: {
				start: { rowIndex: 0, columnId },
				end: { rowIndex: rowCount - 1, columnId },
			},
			isSelecting: false,
		});
	};

	const selectRange = (
		start: CellPosition,
		end: CellPosition,
		isSelecting = false,
	) => {
		const startColIndex = columnIds.indexOf(start.columnId);
		const endColIndex = columnIds.indexOf(end.columnId);

		const minRow = Math.min(start.rowIndex, end.rowIndex);
		const maxRow = Math.max(start.rowIndex, end.rowIndex);
		const minCol = Math.min(startColIndex, endColIndex);
		const maxCol = Math.max(startColIndex, endColIndex);

		const selectedCells = new Set<string>();

		for (let rowIndex = minRow; rowIndex <= maxRow; rowIndex++) {
			for (let colIndex = minCol; colIndex <= maxCol; colIndex++) {
				const columnId = columnIds[colIndex];
				if (columnId) {
					selectedCells.add(getCellKey(rowIndex, columnId));
				}
			}
		}

		store.setState("selectionState", {
			selectedCells,
			selectionRange: { start, end },
			isSelecting,
		});
	};

	const dragDepsRef = useAsRef({
		selectRange,
		dir,
		rowHeightValue,
		columnIds,
	});

	const serializeCellsToTsv = () => {
		const currentState = store.getState();

		let selectedCellsArray: string[];
		if (!currentState.selectionState.selectedCells.size) {
			if (!currentState.focusedCell) return null;
			const focusedCellKey = getCellKey(
				currentState.focusedCell.rowIndex,
				currentState.focusedCell.columnId,
			);
			selectedCellsArray = [focusedCellKey];
		} else {
			selectedCellsArray = Array.from(
				currentState.selectionState.selectedCells,
			);
		}

		const currentTable = tableRef.current;
		const rows = currentTable?.getRowModel().rows;
		if (!rows) return null;

		const selectedColumnIds: string[] = [];
		const seenColumnIds = new Set<string>();
		const cellData = new Map<string, string>();
		const rowIndices = new Set<number>();
		const rowCellMaps = new Map<
			number,
			Map<string, ReturnType<Row<TData>["getVisibleCells"]>[number]>
		>();
		const navigableCells: string[] = [];

		for (const cellKey of selectedCellsArray) {
			const { rowIndex, columnId } = parseCellKey(cellKey);

			if (columnId && NON_NAVIGABLE_COLUMN_IDS.has(columnId)) {
				continue;
			}

			navigableCells.push(cellKey);

			if (columnId && !seenColumnIds.has(columnId)) {
				seenColumnIds.add(columnId);
				selectedColumnIds.push(columnId);
			}

			rowIndices.add(rowIndex);

			const row = rows[rowIndex];
			if (row) {
				let cellMap = rowCellMaps.get(rowIndex);
				if (!cellMap) {
					cellMap = new Map(row.getVisibleCells().map((c) => [c.column.id, c]));
					rowCellMaps.set(rowIndex, cellMap);
				}
				const cell = cellMap.get(columnId);
				if (cell) {
					const value = cell.getValue();
					const cellVariant = cell.column.columnDef?.meta?.cell?.variant;

					let serializedValue = "";
					if (cellVariant === "file" || cellVariant === "multi-select") {
						serializedValue = value ? JSON.stringify(value) : "";
					} else if (value instanceof Date) {
						serializedValue = value.toISOString();
					} else {
						serializedValue = String(value ?? "");
					}

					cellData.set(cellKey, serializedValue);
				}
			}
		}

		const colIndices = new Set<number>();
		const columnIdToIndex = new Map<string, number>();
		for (let i = 0; i < selectedColumnIds.length; i++) {
			const id = selectedColumnIds[i];
			if (id !== undefined) columnIdToIndex.set(id, i);
		}
		for (const cellKey of navigableCells) {
			const { columnId } = parseCellKey(cellKey);
			const colIndex = columnIdToIndex.get(columnId) ?? -1;
			if (colIndex >= 0) {
				colIndices.add(colIndex);
			}
		}

		const sortedRowIndices = Array.from(rowIndices).sort((a, b) => a - b);
		const sortedColIndices = Array.from(colIndices).sort((a, b) => a - b);
		const sortedColumnIds = sortedColIndices.map((i) => selectedColumnIds[i]);

		const tsvData = sortedRowIndices
			.map((rowIndex) =>
				sortedColumnIds
					.map((columnId) => {
						const cellKey = `${rowIndex}:${columnId}`;
						return cellData.get(cellKey) ?? "";
					})
					.join("\t"),
			)
			.join("\n");

		return { tsvData, selectedCellsArray: navigableCells };
	};

	const onCellsCopy = async () => {
		const result = serializeCellsToTsv();
		if (!result) return;

		const { tsvData, selectedCellsArray } = result;

		try {
			await navigator.clipboard.writeText(tsvData);

			const currentState = store.getState();
			if (currentState.cutCells.size > 0) {
				store.setState("cutCells", new Set());
			}

			toast.success(
				`${selectedCellsArray.length} cell${
					selectedCellsArray.length !== 1 ? "s" : ""
				} copied`,
			);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to copy to clipboard",
			);
		}
	};

	const onCellsCut = async () => {
		if (propsRef.current.readOnly) return;

		const result = serializeCellsToTsv();
		if (!result) return;

		const { tsvData, selectedCellsArray } = result;

		try {
			await navigator.clipboard.writeText(tsvData);

			store.setState("cutCells", new Set(selectedCellsArray));

			toast.success(
				`${selectedCellsArray.length} cell${
					selectedCellsArray.length !== 1 ? "s" : ""
				} cut`,
			);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to cut to clipboard",
			);
		}
	};

	const onCellsPaste = async (expandRows = false) => {
		if (propsRef.current.readOnly) return;

		const currentState = store.getState();
		if (!currentState.focusedCell) return;

		const currentTable = tableRef.current;
		const rows = currentTable?.getRowModel().rows;
		if (!rows) return;

		try {
			let clipboardText = currentState.pasteDialog.clipboardText;

			if (!clipboardText) {
				clipboardText = await navigator.clipboard.readText();
				if (!clipboardText) return;
			}

			const rawPastedData = parseTsv(clipboardText, navigableColumnIds.length);

			// Fill entire selection when clipboard has a single value and multiple cells are selected
			const selectionCells = currentState.selectionState.selectedCells;
			const isSingleCellClipboard =
				rawPastedData.length === 1 && (rawPastedData[0]?.length ?? 0) === 1;

			let pastedData = rawPastedData;
			let startRowIndex = currentState.focusedCell.rowIndex;
			let startColIndex = navigableColumnIds.indexOf(
				currentState.focusedCell.columnId,
			);

			if (isSingleCellClipboard && selectionCells.size > 1) {
				const singleValue = rawPastedData[0]?.[0] ?? "";
				let minRow = Infinity;
				let maxRow = -Infinity;
				let minColIdx = Infinity;
				let maxColIdx = -Infinity;

				const navColIndexMap = new Map<string, number>();
				for (let i = 0; i < navigableColumnIds.length; i++) {
					const id = navigableColumnIds[i];
					if (id !== undefined) navColIndexMap.set(id, i);
				}

				for (const cellKey of selectionCells) {
					const { rowIndex, columnId } = parseCellKey(cellKey);
					const colIdx = navColIndexMap.get(columnId) ?? -1;
					if (colIdx === -1) continue;
					minRow = Math.min(minRow, rowIndex);
					maxRow = Math.max(maxRow, rowIndex);
					minColIdx = Math.min(minColIdx, colIdx);
					maxColIdx = Math.max(maxColIdx, colIdx);
				}

				if (minRow !== Infinity) {
					startRowIndex = minRow;
					startColIndex = minColIdx;
					const numRows = maxRow - minRow + 1;
					const numCols = maxColIdx - minColIdx + 1;
					pastedData = Array.from({ length: numRows }, () =>
						Array.from({ length: numCols }, () => singleValue),
					);
				}
			}

			if (startColIndex === -1) return;

			const rowCount = rows.length ?? propsRef.current.data.length;
			const rowsNeeded = startRowIndex + pastedData.length - rowCount;

			if (
				rowsNeeded > 0 &&
				!expandRows &&
				propsRef.current.onRowAdd &&
				!currentState.pasteDialog.clipboardText
			) {
				store.setState("pasteDialog", {
					open: true,
					rowsNeeded,
					clipboardText,
				});
				return;
			}

			if (expandRows && rowsNeeded > 0) {
				const expectedRowCount = rowCount + rowsNeeded;

				if (propsRef.current.onRowsAdd) {
					await propsRef.current.onRowsAdd(rowsNeeded);
				} else if (propsRef.current.onRowAdd) {
					for (let i = 0; i < rowsNeeded; i++) {
						// eslint-disable-next-line react-doctor/async-await-in-loop -- rows must be appended sequentially; each onRowAdd() mutates the backing data store and the next append depends on the prior row existing. Parallelizing would race the store and corrupt row order.
						await propsRef.current.onRowAdd();
					}
				}

				let attempts = 0;
				const maxAttempts = 50;
				let currentTableRowCount =
					tableRef.current?.getRowModel().rows.length ?? 0;

				while (
					currentTableRowCount < expectedRowCount &&
					attempts < maxAttempts
				) {
					// eslint-disable-next-line react-doctor/async-await-in-loop -- sequential polling: each iteration waits 100ms then re-reads the row count to detect when the async data sync has caught up. Iterations are inherently dependent (poll-until-ready), not parallelizable.
					await new Promise((resolve) => setTimeout(resolve, 100));
					currentTableRowCount =
						tableRef.current?.getRowModel().rows.length ?? 0;
					attempts++;
				}
			}

			const updates: Array<CellUpdate> = [];
			const tableColumns = currentTable?.getAllColumns() ?? [];
			let cellsUpdated = 0;
			let endRowIndex = startRowIndex;
			let endColIndex = startColIndex;

			const updatedTable = tableRef.current;
			const updatedRows = updatedTable?.getRowModel().rows;
			const currentRowCount = updatedRows?.length ?? 0;

			let cellsSkipped = 0;

			const columnMap = new Map(tableColumns.map((c) => [c.id, c]));

			for (
				let pasteRowIdx = 0;
				pasteRowIdx < pastedData.length;
				pasteRowIdx++
			) {
				const pasteRow = pastedData[pasteRowIdx];
				if (!pasteRow) continue;

				const targetRowIndex = startRowIndex + pasteRowIdx;
				if (targetRowIndex >= currentRowCount) break;

				for (
					let pasteColIdx = 0;
					pasteColIdx < pasteRow.length;
					pasteColIdx++
				) {
					const targetColIndex = startColIndex + pasteColIdx;
					if (targetColIndex >= navigableColumnIds.length) break;

					const targetColumnId = navigableColumnIds[targetColIndex];
					if (!targetColumnId) continue;

					const pastedValue = pasteRow[pasteColIdx] ?? "";
					const column = columnMap.get(targetColumnId);
					const cellOpts = column?.columnDef?.meta?.cell;
					const cellVariant = cellOpts?.variant;

					let processedValue: unknown = pastedValue;
					let shouldSkip = false;

					switch (cellVariant) {
						case "number": {
							if (!pastedValue) {
								processedValue = null;
							} else {
								const num = Number.parseFloat(pastedValue);
								if (Number.isNaN(num)) shouldSkip = true;
								else processedValue = num;
							}
							break;
						}

						case "checkbox": {
							if (!pastedValue) {
								processedValue = false;
							} else {
								const lower = pastedValue.toLowerCase();
								if (VALID_BOOLEANS.has(lower)) {
									processedValue = TRUTHY_BOOLEANS.has(lower);
								} else {
									shouldSkip = true;
								}
							}
							break;
						}

						case "date": {
							if (!pastedValue) {
								processedValue = null;
							} else {
								const date = new Date(pastedValue);
								if (Number.isNaN(date.getTime())) shouldSkip = true;
								else processedValue = date;
							}
							break;
						}

						case "select": {
							const options = cellOpts?.options ?? [];
							if (!pastedValue) {
								processedValue = null;
							} else {
								const matched = matchSelectOption(pastedValue, options);
								if (matched) processedValue = matched;
								else shouldSkip = true;
							}
							break;
						}

						case "multi-select": {
							const options = cellOpts?.options ?? [];
							let values: string[] = [];
							try {
								const parsed = JSON.parse(pastedValue);
								if (Array.isArray(parsed)) {
									values = parsed.filter(
										(v): v is string => typeof v === "string",
									);
								}
							} catch {
								values = pastedValue
									? pastedValue.split(",").map((v) => v.trim())
									: [];
							}

							const validated = values.flatMap((v) => {
								const matched = matchSelectOption(v, options);
								return matched ? [matched] : [];
							});

							if (values.length > 0 && validated.length === 0) {
								shouldSkip = true;
							} else {
								processedValue = validated;
							}
							break;
						}

						case "file": {
							if (!pastedValue) {
								processedValue = [];
							} else {
								try {
									const parsed = JSON.parse(pastedValue);
									if (!Array.isArray(parsed)) {
										shouldSkip = true;
									} else {
										const validFiles = parsed.filter(getIsFileCellData);
										if (parsed.length > 0 && validFiles.length === 0) {
											shouldSkip = true;
										} else {
											processedValue = validFiles;
										}
									}
								} catch {
									shouldSkip = true;
								}
							}
							break;
						}

						case "url": {
							if (!pastedValue) {
								processedValue = "";
							} else {
								const firstChar = pastedValue[0];
								if (firstChar === "[" || firstChar === "{") {
									shouldSkip = true;
								} else {
									try {
										new URL(pastedValue);
										processedValue = pastedValue;
									} catch {
										if (DOMAIN_REGEX.test(pastedValue)) {
											processedValue = pastedValue;
										} else {
											shouldSkip = true;
										}
									}
								}
							}
							break;
						}

						default: {
							if (!pastedValue) {
								processedValue = "";
								break;
							}

							if (ISO_DATE_REGEX.test(pastedValue)) {
								const date = new Date(pastedValue);
								if (!Number.isNaN(date.getTime())) {
									processedValue = date.toLocaleDateString();
									break;
								}
							}

							const firstChar = pastedValue[0];
							if (
								firstChar === "[" ||
								firstChar === "{" ||
								firstChar === "t" ||
								firstChar === "f"
							) {
								try {
									const parsed = JSON.parse(pastedValue);

									if (Array.isArray(parsed)) {
										if (parsed.length > 0 && parsed.every(getIsFileCellData)) {
											processedValue = parsed.map((f) => f.name).join(", ");
										} else if (parsed.every((v) => typeof v === "string")) {
											processedValue = (parsed as string[]).join(", ");
										}
									} else if (typeof parsed === "boolean") {
										processedValue = parsed ? "Checked" : "Unchecked";
									}
								} catch {
									const lower = pastedValue.toLowerCase();
									if (lower === "true" || lower === "false") {
										processedValue = lower === "true" ? "Checked" : "Unchecked";
									}
								}
							}
						}
					}

					if (shouldSkip) {
						cellsSkipped++;
						endRowIndex = Math.max(endRowIndex, targetRowIndex);
						endColIndex = Math.max(endColIndex, targetColIndex);
						continue;
					}

					updates.push({
						rowIndex: targetRowIndex,
						columnId: targetColumnId,
						value: processedValue,
					});
					cellsUpdated++;

					endRowIndex = Math.max(endRowIndex, targetRowIndex);
					endColIndex = Math.max(endColIndex, targetColIndex);
				}
			}

			if (updates.length > 0) {
				if (propsRef.current.onPaste) {
					await propsRef.current.onPaste(updates);
				}

				const allUpdates = [...updates];

				if (currentState.cutCells.size > 0) {
					const columnById = new Map(tableColumns.map((c) => [c.id, c]));

					for (const cellKey of currentState.cutCells) {
						const { rowIndex, columnId } = parseCellKey(cellKey);
						const column = columnById.get(columnId);
						const cellVariant = column?.columnDef?.meta?.cell?.variant;
						const emptyValue = getEmptyCellValue(cellVariant);
						allUpdates.push({ rowIndex, columnId, value: emptyValue });
					}

					store.setState("cutCells", new Set());
				}

				onDataUpdate(allUpdates);

				if (cellsSkipped > 0) {
					toast.success(
						`${cellsUpdated} cell${
							cellsUpdated !== 1 ? "s" : ""
						} pasted, ${cellsSkipped} skipped`,
					);
				} else {
					toast.success(
						`${cellsUpdated} cell${cellsUpdated !== 1 ? "s" : ""} pasted`,
					);
				}

				const endColumnId = navigableColumnIds[endColIndex];
				if (endColumnId) {
					selectRange(
						{
							rowIndex: startRowIndex,
							columnId: currentState.focusedCell.columnId,
						},
						{ rowIndex: endRowIndex, columnId: endColumnId },
					);
				}

				restoreFocus(dataGridRef.current);
			} else if (cellsSkipped > 0) {
				toast.error(
					`${cellsSkipped} cell${
						cellsSkipped !== 1 ? "s" : ""
					} skipped pasting for invalid data`,
				);
			}

			if (currentState.pasteDialog.open) {
				store.setState("pasteDialog", {
					open: false,
					rowsNeeded: 0,
					clipboardText: "",
				});
			}
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to paste. Please try again.",
			);
		}
	};

	// Release focus guard after delay to allow async data re-renders to settle.
	// 300ms accounts for db sync and virtualized cell mounting
	const releaseFocusGuard = (immediate = false) => {
		if (immediate) {
			focusGuardRef.current = false;
			return;
		}

		setTimeout(() => {
			focusGuardRef.current = false;
		}, 300);
	};

	const focusCellWrapper = (rowIndex: number, columnId: string) => {
		focusGuardRef.current = true;

		requestAnimationFrame(() => {
			const cellKey = getCellKey(rowIndex, columnId);
			const cellWrapperElement = cellMapRef.current.get(cellKey);

			if (!cellWrapperElement) {
				const container = dataGridRef.current;
				if (container) {
					container.focus();
				}
				releaseFocusGuard();
				return;
			}

			cellWrapperElement.focus();
			releaseFocusGuard();
		});
	};

	const focusCell = (rowIndex: number, columnId: string) => {
		store.batch(() => {
			store.setState("focusedCell", { rowIndex, columnId });
			store.setState("editingCell", null);
		});

		const currentState = store.getState();

		if (currentState.searchOpen) return;

		focusCellWrapper(rowIndex, columnId);
	};

	const onRowsDelete = async (rowIndices: number[]) => {
		if (
			propsRef.current.readOnly ||
			!propsRef.current.onRowsDelete ||
			rowIndices.length === 0
		)
			return;

		const currentTable = tableRef.current;
		const rows = currentTable?.getRowModel().rows;

		if (!rows || rows.length === 0) return;

		const currentState = store.getState();
		const currentFocusedColumn =
			currentState.focusedCell?.columnId ?? navigableColumnIds[0];

		const minDeletedRowIndex = Math.min(...rowIndices);

		const rowsToDelete: TData[] = [];
		for (const rowIndex of rowIndices) {
			const row = rows[rowIndex];
			if (row) {
				rowsToDelete.push(row.original);
			}
		}

		await propsRef.current.onRowsDelete(rowsToDelete, rowIndices);

		store.batch(() => {
			store.setState("selectionState", {
				selectedCells: new Set(),
				selectionRange: null,
				isSelecting: false,
			});
			store.setState("rowSelection", {});
			store.setState("editingCell", null);
		});

		requestAnimationFrame(() => {
			const currentTable = tableRef.current;
			const currentRows = currentTable?.getRowModel().rows ?? [];
			const newRowCount = currentRows.length ?? propsRef.current.data.length;

			if (newRowCount > 0 && currentFocusedColumn) {
				const targetRowIndex = Math.min(minDeletedRowIndex, newRowCount - 1);
				focusCell(targetRowIndex, currentFocusedColumn);
			}
		});
	};

	const navigateCell = (direction: NavigationDirection) => {
		const currentState = store.getState();
		if (!currentState.focusedCell) return;

		const { rowIndex, columnId } = currentState.focusedCell;
		const currentColIndex = navigableColumnIds.indexOf(columnId);
		const rowVirtualizer = rowVirtualizerRef.current;
		const currentTable = tableRef.current;
		const rows = currentTable?.getRowModel().rows ?? [];
		const rowCount = rows.length ?? propsRef.current.data.length;

		let newRowIndex = rowIndex;
		let newColumnId = columnId;

		const isRtl = dir === "rtl";

		switch (direction) {
			case "up":
				newRowIndex = Math.max(0, rowIndex - 1);
				break;
			case "down":
				newRowIndex = Math.min(rowCount - 1, rowIndex + 1);
				break;
			case "left":
				if (isRtl) {
					if (currentColIndex < navigableColumnIds.length - 1) {
						const nextColumnId = navigableColumnIds[currentColIndex + 1];
						if (nextColumnId) newColumnId = nextColumnId;
					}
				} else {
					if (currentColIndex > 0) {
						const prevColumnId = navigableColumnIds[currentColIndex - 1];
						if (prevColumnId) newColumnId = prevColumnId;
					}
				}
				break;
			case "right":
				if (isRtl) {
					if (currentColIndex > 0) {
						const prevColumnId = navigableColumnIds[currentColIndex - 1];
						if (prevColumnId) newColumnId = prevColumnId;
					}
				} else {
					if (currentColIndex < navigableColumnIds.length - 1) {
						const nextColumnId = navigableColumnIds[currentColIndex + 1];
						if (nextColumnId) newColumnId = nextColumnId;
					}
				}
				break;
			case "home":
				if (navigableColumnIds.length > 0) {
					newColumnId = navigableColumnIds[0] ?? columnId;
				}
				break;
			case "end":
				if (navigableColumnIds.length > 0) {
					newColumnId =
						navigableColumnIds[navigableColumnIds.length - 1] ?? columnId;
				}
				break;
			case "ctrl+home":
				newRowIndex = 0;
				if (navigableColumnIds.length > 0) {
					newColumnId = navigableColumnIds[0] ?? columnId;
				}
				break;
			case "ctrl+end":
				newRowIndex = Math.max(0, rowCount - 1);
				if (navigableColumnIds.length > 0) {
					newColumnId =
						navigableColumnIds[navigableColumnIds.length - 1] ?? columnId;
				}
				break;
			case "ctrl+up":
				newRowIndex = 0;
				break;
			case "ctrl+down":
				newRowIndex = Math.max(0, rowCount - 1);
				break;
			case "pageup":
				if (rowVirtualizer) {
					const visibleRange = rowVirtualizer.getVirtualItems();
					const pageSize = visibleRange.length ?? 10;
					newRowIndex = Math.max(0, rowIndex - pageSize);
				} else {
					newRowIndex = Math.max(0, rowIndex - 10);
				}
				break;
			case "pagedown":
				if (rowVirtualizer) {
					const visibleRange = rowVirtualizer.getVirtualItems();
					const pageSize = visibleRange.length ?? 10;
					newRowIndex = Math.min(rowCount - 1, rowIndex + pageSize);
				} else {
					newRowIndex = Math.min(rowCount - 1, rowIndex + 10);
				}
				break;
			case "pageleft":
				if (currentColIndex > 0) {
					const targetIndex = Math.max(
						0,
						currentColIndex - HORIZONTAL_PAGE_SIZE,
					);
					const targetColumnId = navigableColumnIds[targetIndex];
					if (targetColumnId) newColumnId = targetColumnId;
				}
				break;
			case "pageright":
				if (currentColIndex < navigableColumnIds.length - 1) {
					const targetIndex = Math.min(
						navigableColumnIds.length - 1,
						currentColIndex + HORIZONTAL_PAGE_SIZE,
					);
					const targetColumnId = navigableColumnIds[targetIndex];
					if (targetColumnId) newColumnId = targetColumnId;
				}
				break;
		}

		if (newRowIndex !== rowIndex || newColumnId !== columnId) {
			focusCell(newRowIndex, newColumnId);

			// Calculate and apply scrolls synchronously to avoid flashing
			const container = dataGridRef.current;
			if (!container) return;

			const targetRow = rowMapRef.current.get(newRowIndex);
			const cellKey = getCellKey(newRowIndex, newColumnId);
			const targetCell = cellMapRef.current.get(cellKey);

			// If target row is not rendered, scroll it into view first
			if (!targetRow) {
				if (rowVirtualizer) {
					const align =
						direction === "up" ||
						direction === "pageup" ||
						direction === "ctrl+up" ||
						direction === "ctrl+home"
							? "start"
							: direction === "down" ||
								  direction === "pagedown" ||
								  direction === "ctrl+down" ||
								  direction === "ctrl+end"
								? "end"
								: "center";

					rowVirtualizer.scrollToIndex(newRowIndex, { align });

					// Wait for row to render before horizontal scroll
					if (newColumnId !== columnId) {
						requestAnimationFrame(() => {
							const cellKeyRetry = getCellKey(newRowIndex, newColumnId);
							const targetCellRetry = cellMapRef.current.get(cellKeyRetry);

							if (targetCellRetry) {
								const scrollDirection = getScrollDirection(direction);

								scrollCellIntoView({
									container,
									targetCell: targetCellRetry,
									tableRef,
									viewportOffset: VIEWPORT_OFFSET,
									direction: scrollDirection,
									isRtl: dir === "rtl",
								});
							}
						});
					}
				} else {
					// Use direct scroll calculation when virtualizer is not available
					const rowHeightValue = getRowHeightValue(rowHeight);
					const estimatedScrollTop = newRowIndex * rowHeightValue;
					container.scrollTop = estimatedScrollTop;
				}

				return;
			}

			// Vertical scrolling for rendered rows that changed
			if (newRowIndex !== rowIndex && targetRow) {
				requestAnimationFrame(() => {
					const containerRect = container.getBoundingClientRect();
					const headerHeight =
						headerRef.current?.getBoundingClientRect().height ?? 0;
					const footerHeight =
						footerRef.current?.getBoundingClientRect().height ?? 0;
					const viewportTop =
						containerRect.top + headerHeight + VIEWPORT_OFFSET;
					const viewportBottom =
						containerRect.bottom - footerHeight - VIEWPORT_OFFSET;

					const rowRect = targetRow.getBoundingClientRect();
					const isFullyVisible =
						rowRect.top >= viewportTop && rowRect.bottom <= viewportBottom;

					if (!isFullyVisible) {
						// Only apply vertical scroll for vertical navigation
						const isVerticalNavigation =
							direction === "up" ||
							direction === "down" ||
							direction === "pageup" ||
							direction === "pagedown" ||
							direction === "ctrl+up" ||
							direction === "ctrl+down" ||
							direction === "ctrl+home" ||
							direction === "ctrl+end";

						if (isVerticalNavigation) {
							if (
								direction === "down" ||
								direction === "pagedown" ||
								direction === "ctrl+down" ||
								direction === "ctrl+end"
							) {
								container.scrollTop += rowRect.bottom - viewportBottom;
							} else {
								container.scrollTop -= viewportTop - rowRect.top;
							}
						}
					}
				});
			}

			// Horizontal scrolling for rendered cells
			if (newColumnId !== columnId && targetCell) {
				requestAnimationFrame(() => {
					const scrollDirection = getScrollDirection(direction);

					scrollCellIntoView({
						container,
						targetCell,
						tableRef,
						viewportOffset: VIEWPORT_OFFSET,
						direction: scrollDirection,
						isRtl: dir === "rtl",
					});
				});
			}
		}
	};

	const onCellEditingStart = (rowIndex: number, columnId: string) => {
		if (propsRef.current.readOnly) return;

		store.batch(() => {
			store.setState("focusedCell", { rowIndex, columnId });
			store.setState("editingCell", { rowIndex, columnId });
		});
	};

	const onCellEditingStop = (opts?: {
		moveToNextRow?: boolean;
		direction?: NavigationDirection;
	}) => {
		const currentState = store.getState();
		const currentEditing = currentState.editingCell;

		store.setState("editingCell", null);

		if (opts?.moveToNextRow && currentEditing) {
			const { rowIndex, columnId } = currentEditing;
			const currentTable = tableRef.current;
			const rows = currentTable?.getRowModel().rows ?? [];
			const rowCount = rows.length ?? propsRef.current.data.length;

			const nextRowIndex = rowIndex + 1;
			if (nextRowIndex < rowCount) {
				requestAnimationFrame(() => {
					focusCell(nextRowIndex, columnId);
				});
			}
		} else if (opts?.direction && currentEditing) {
			const { rowIndex, columnId } = currentEditing;
			focusCell(rowIndex, columnId);
			requestAnimationFrame(() => {
				navigateCell(opts.direction ?? "right");
			});
		} else if (currentEditing) {
			const { rowIndex, columnId } = currentEditing;
			focusCellWrapper(rowIndex, columnId);
		}
	};

	const onSearchOpenChange = (open: boolean) => {
		if (open) {
			store.setState("searchOpen", true);
			return;
		}

		const currentState = store.getState();
		const currentMatch =
			currentState.matchIndex >= 0 &&
			currentState.searchMatches[currentState.matchIndex];

		store.batch(() => {
			store.setState("searchOpen", false);
			store.setState("searchQuery", "");
			store.setState("searchMatches", []);
			store.setState("matchIndex", -1);

			if (currentMatch) {
				store.setState("focusedCell", {
					rowIndex: currentMatch.rowIndex,
					columnId: currentMatch.columnId,
				});
			}
		});

		if (dataGridRef.current && document.activeElement !== dataGridRef.current) {
			dataGridRef.current.focus();
		}
	};

	const onSearch = (query: string) => {
		if (!query.trim()) {
			store.batch(() => {
				store.setState("searchMatches", []);
				store.setState("matchIndex", -1);
			});
			return;
		}

		const matches: CellPosition[] = [];
		const currentTable = tableRef.current;
		const rows = currentTable?.getRowModel().rows ?? [];

		const lowerQuery = query.toLowerCase();

		for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
			const row = rows[rowIndex];
			if (!row) continue;

			const cellById = new Map(
				row.getVisibleCells().map((c) => [c.column.id, c]),
			);

			for (const columnId of columnIds) {
				const cell = cellById.get(columnId);
				if (!cell) continue;

				const value = cell.getValue();
				const stringValue = String(value ?? "").toLowerCase();

				// eslint-disable-next-line react-doctor/js-set-map-lookups -- this is String.prototype.includes (substring search), not an array membership test; there is no array to hoist into a Set.
				if (stringValue.includes(lowerQuery)) {
					matches.push({ rowIndex, columnId });
				}
			}
		}

		store.batch(() => {
			store.setState("searchMatches", matches);
			store.setState("matchIndex", matches.length > 0 ? 0 : -1);
		});

		if (matches.length > 0 && matches[0]) {
			const firstMatch = matches[0];
			rowVirtualizerRef.current?.scrollToIndex(firstMatch.rowIndex, {
				align: "center",
			});
		}
	};

	const onSearchQueryChange = (query: string) =>
		store.setState("searchQuery", query);

	const onNavigateToPrevMatch = () => {
		const currentState = store.getState();
		if (currentState.searchMatches.length === 0) return;

		const prevIndex =
			currentState.matchIndex - 1 < 0
				? currentState.searchMatches.length - 1
				: currentState.matchIndex - 1;
		const match = currentState.searchMatches[prevIndex];

		if (match) {
			rowVirtualizerRef.current?.scrollToIndex(match.rowIndex, {
				align: "center",
			});

			requestAnimationFrame(() => {
				store.setState("matchIndex", prevIndex);
				requestAnimationFrame(() => {
					focusCell(match.rowIndex, match.columnId);
				});
			});
		}
	};

	const onNavigateToNextMatch = () => {
		const currentState = store.getState();
		if (currentState.searchMatches.length === 0) return;

		const nextIndex =
			(currentState.matchIndex + 1) % currentState.searchMatches.length;
		const match = currentState.searchMatches[nextIndex];

		if (match) {
			rowVirtualizerRef.current?.scrollToIndex(match.rowIndex, {
				align: "center",
			});

			requestAnimationFrame(() => {
				store.setState("matchIndex", nextIndex);
				requestAnimationFrame(() => {
					focusCell(match.rowIndex, match.columnId);
				});
			});
		}
	};

	const searchMatchSet = (() => {
		return new Set(
			searchMatches.map((m) => getCellKey(m.rowIndex, m.columnId)),
		);
	})();

	const getIsSearchMatch = (rowIndex: number, columnId: string) => {
		return searchMatchSet.has(getCellKey(rowIndex, columnId));
	};

	const getIsActiveSearchMatch = (rowIndex: number, columnId: string) => {
		const currentState = store.getState();
		if (currentState.matchIndex < 0) return false;
		const currentMatch = currentState.searchMatches[currentState.matchIndex];
		return (
			currentMatch?.rowIndex === rowIndex && currentMatch?.columnId === columnId
		);
	};

	// Compute search match data for targeted row re-renders
	const searchMatchesByRow = (() => {
		if (searchMatches.length === 0) return null;
		const rowMap = new Map<number, Set<string>>();
		for (const match of searchMatches) {
			let columnSet = rowMap.get(match.rowIndex);
			if (!columnSet) {
				columnSet = new Set<string>();
				rowMap.set(match.rowIndex, columnSet);
			}
			columnSet.add(match.columnId);
		}
		return rowMap;
	})();

	const activeSearchMatch = (() => {
		if (matchIndex < 0 || searchMatches.length === 0) return null;
		return searchMatches[matchIndex] ?? null;
	})();

	const blurCell = () => {
		const currentState = store.getState();
		if (
			currentState.editingCell &&
			document.activeElement instanceof HTMLElement
		) {
			document.activeElement.blur();
		}

		store.batch(() => {
			store.setState("focusedCell", null);
			store.setState("editingCell", null);
		});
	};

	const scrollToCell = (rowIndex: number, columnId: string) => {
		requestAnimationFrame(() => {
			const container = dataGridRef.current;
			const cellKey = getCellKey(rowIndex, columnId);
			const targetCell = cellMapRef.current.get(cellKey);

			if (container && targetCell) {
				scrollCellIntoView({
					container,
					targetCell,
					tableRef,
					viewportOffset: VIEWPORT_OFFSET,
					isRtl: dir === "rtl",
				});
			}
		});
	};

	const onCellClick = (
		rowIndex: number,
		columnId: string,
		event?: React.MouseEvent,
	) => {
		if (event?.button === 2) return;

		const currentState = store.getState();
		const currentFocused = currentState.focusedCell;

		if (event) {
			if (event.ctrlKey || event.metaKey) {
				event.preventDefault();
				const cellKey = getCellKey(rowIndex, columnId);
				const newSelectedCells = new Set(
					currentState.selectionState.selectedCells,
				);

				if (newSelectedCells.has(cellKey)) {
					newSelectedCells.delete(cellKey);
				} else {
					newSelectedCells.add(cellKey);
				}

				store.setState("selectionState", {
					selectedCells: newSelectedCells,
					selectionRange: null,
					isSelecting: false,
				});
				focusCell(rowIndex, columnId);
				scrollToCell(rowIndex, columnId);
				return;
			}

			if (event.shiftKey && currentState.focusedCell) {
				event.preventDefault();
				selectRange(currentState.focusedCell, { rowIndex, columnId });
				scrollToCell(rowIndex, columnId);
				return;
			}
		}

		const hasSelectedCells = currentState.selectionState.selectedCells.size > 0;
		const hasSelectedRows = Object.keys(currentState.rowSelection).length > 0;

		if (hasSelectedCells && !currentState.selectionState.isSelecting) {
			const cellKey = getCellKey(rowIndex, columnId);
			const isClickingSelectedCell =
				currentState.selectionState.selectedCells.has(cellKey);

			if (!isClickingSelectedCell) {
				onSelectionClear();
			} else {
				focusCell(rowIndex, columnId);
				scrollToCell(rowIndex, columnId);
				return;
			}
		} else if (hasSelectedRows && columnId !== "select") {
			onSelectionClear();
		}

		if (
			currentFocused?.rowIndex === rowIndex &&
			currentFocused?.columnId === columnId
		) {
			onCellEditingStart(rowIndex, columnId);
		} else {
			focusCell(rowIndex, columnId);
			scrollToCell(rowIndex, columnId);
		}
	};

	const onCellDoubleClick = (
		rowIndex: number,
		columnId: string,
		event?: React.MouseEvent,
	) => {
		if (event?.defaultPrevented) return;

		onCellEditingStart(rowIndex, columnId);
	};

	const onCellMouseDown = (
		rowIndex: number,
		columnId: string,
		event: React.MouseEvent,
	) => {
		if (event.button === 2) {
			return;
		}

		event.preventDefault();

		if (!event.ctrlKey && !event.metaKey && !event.shiftKey) {
			const cellKey = getCellKey(rowIndex, columnId);
			store.batch(() => {
				store.setState("selectionState", {
					selectedCells: propsRef.current.enableSingleCellSelection
						? new Set([cellKey])
						: new Set(),
					selectionRange: {
						start: { rowIndex, columnId },
						end: { rowIndex, columnId },
					},
					isSelecting: true,
				});
				store.setState("rowSelection", {});
			});
		}
	};

	const onCellMouseEnter = (rowIndex: number, columnId: string) => {
		const currentState = store.getState();
		if (
			currentState.selectionState.isSelecting &&
			currentState.selectionState.selectionRange
		) {
			const start = currentState.selectionState.selectionRange.start;
			const end = { rowIndex, columnId };

			if (
				currentState.focusedCell?.rowIndex !== start.rowIndex ||
				currentState.focusedCell?.columnId !== start.columnId
			) {
				focusCell(start.rowIndex, start.columnId);
			}

			selectRange(start, end, true);
		}
	};

	const onCellMouseUp = () => {
		const currentState = store.getState();
		store.setState("selectionState", {
			...currentState.selectionState,
			isSelecting: false,
		});
	};

	const onCellContextMenu = (
		rowIndex: number,
		columnId: string,
		event: React.MouseEvent,
	) => {
		event.preventDefault();
		event.stopPropagation();

		const currentState = store.getState();
		const cellKey = getCellKey(rowIndex, columnId);
		const isTargetCellSelected =
			currentState.selectionState.selectedCells.has(cellKey);

		if (!isTargetCellSelected) {
			store.batch(() => {
				store.setState("selectionState", {
					selectedCells: new Set([cellKey]),
					selectionRange: {
						start: { rowIndex, columnId },
						end: { rowIndex, columnId },
					},
					isSelecting: false,
				});
				store.setState("focusedCell", { rowIndex, columnId });
			});
		}

		store.setState("contextMenu", {
			open: true,
			x: event.clientX,
			y: event.clientY,
		});
	};

	const onContextMenuOpenChange = (open: boolean) => {
		if (!open) {
			const currentMenu = store.getState().contextMenu;
			store.setState("contextMenu", {
				open: false,
				x: currentMenu.x,
				y: currentMenu.y,
			});
		}
	};

	const onSortingChange = (updater: Updater<SortingState>) => {
		const currentState = store.getState();
		const newSorting =
			typeof updater === "function" ? updater(currentState.sorting) : updater;
		store.setState("sorting", newSorting);

		propsRef.current.onSortingChange?.(newSorting);
	};

	const onColumnFiltersChange = (updater: Updater<ColumnFiltersState>) => {
		const currentState = store.getState();
		const newColumnFilters =
			typeof updater === "function"
				? updater(currentState.columnFilters)
				: updater;
		store.setState("columnFilters", newColumnFilters);

		propsRef.current.onColumnFiltersChange?.(newColumnFilters);
	};

	const onRowSelectionChange = (updater: Updater<RowSelectionState>) => {
		const currentState = store.getState();
		const newRowSelection =
			typeof updater === "function"
				? updater(currentState.rowSelection)
				: updater;

		const selectedRows = Object.keys(newRowSelection).filter(
			(key) => newRowSelection[key],
		);

		const selectedCells = new Set<string>();
		const rows = tableRef.current?.getRowModel().rows ?? [];

		const rowIndexById = new Map<string, number>();
		for (let i = 0; i < rows.length; i++) {
			const r = rows[i];
			if (r) rowIndexById.set(r.id, i);
		}

		for (const rowId of selectedRows) {
			const rowIndex = rowIndexById.get(rowId) ?? -1;
			if (rowIndex === -1) continue;

			for (const columnId of columnIds) {
				selectedCells.add(getCellKey(rowIndex, columnId));
			}
		}

		store.batch(() => {
			store.setState("rowSelection", newRowSelection);
			store.setState("selectionState", {
				selectedCells,
				selectionRange: null,
				isSelecting: false,
			});
			store.setState("focusedCell", null);
			store.setState("editingCell", null);
		});

		propsRef.current.onRowSelectionChange?.(updater);
	};

	const onRowSelect = (rowId: string, selected: boolean, shiftKey: boolean) => {
		const currentState = store.getState();
		const rows = tableRef.current?.getRowModel().rows ?? [];
		const currentRowIndex = rows.findIndex((r) => r.id === rowId);
		const currentRow = currentRowIndex >= 0 ? rows[currentRowIndex] : null;
		if (!currentRow) return;

		if (shiftKey && currentState.lastClickedRowId !== null) {
			const lastClickedRowIndex = rows.findIndex(
				(r) => r.id === currentState.lastClickedRowId,
			);
			if (lastClickedRowIndex >= 0) {
				const startIndex = Math.min(lastClickedRowIndex, currentRowIndex);
				const endIndex = Math.max(lastClickedRowIndex, currentRowIndex);

				const newRowSelection: RowSelectionState = {
					...currentState.rowSelection,
				};

				for (let i = startIndex; i <= endIndex; i++) {
					const row = rows[i];
					if (row) {
						newRowSelection[row.id] = selected;
					}
				}

				onRowSelectionChange(newRowSelection);
			} else {
				onRowSelectionChange({
					...currentState.rowSelection,
					[currentRow.id]: selected,
				});
			}
		} else {
			onRowSelectionChange({
				...currentState.rowSelection,
				[currentRow.id]: selected,
			});
		}

		store.setState("lastClickedRowId", rowId);
	};

	const onRowHeightChange = (updater: Updater<RowHeightValue>) => {
		const currentState = store.getState();
		const newRowHeight =
			typeof updater === "function" ? updater(currentState.rowHeight) : updater;
		store.setState("rowHeight", newRowHeight);
		propsRef.current.onRowHeightChange?.(newRowHeight);
	};

	const onColumnClick = (columnId: string) => {
		if (!propsRef.current.enableColumnSelection) {
			onSelectionClear();
			return;
		}

		selectColumn(columnId);
	};

	const onPasteDialogOpenChange = (open: boolean) => {
		if (!open) {
			store.setState("pasteDialog", {
				open: false,
				rowsNeeded: 0,
				clipboardText: "",
			});
		}
	};

	const defaultColumn: Partial<ColumnDef<TData>> = {
		// Cell is rendered directly in DataGridRow to bypass flexRender's
		// unstable cell.getContext() (https://github.com/TanStack/table/issues/4794)
		minSize: MIN_COLUMN_SIZE,
		maxSize: MAX_COLUMN_SIZE,
	};

	const tableMeta: TableMeta<TData> = ((): TableMeta<TData> => {
		return {
			...propsRef.current.meta,
			dataGridRef,
			cellMapRef,
			get focusedCell() {
				return store.getState().focusedCell;
			},
			get editingCell() {
				return store.getState().editingCell;
			},
			get selectionState() {
				return store.getState().selectionState;
			},
			get searchOpen() {
				return store.getState().searchOpen;
			},
			get contextMenu() {
				return store.getState().contextMenu;
			},
			get pasteDialog() {
				return store.getState().pasteDialog;
			},
			get rowHeight() {
				return store.getState().rowHeight;
			},
			get readOnly() {
				return propsRef.current.readOnly;
			},
			getIsCellSelected,
			getIsSearchMatch,
			getIsActiveSearchMatch,
			getVisualRowIndex,
			scrollToCell: (rowIndex, columnId, align = "auto") => {
				const container = dataGridRef.current;
				if (!container) return;

				rowVirtualizerRef.current?.scrollToIndex(rowIndex, { align });

				const scrollRowIntoView = (retries = 1) => {
					requestAnimationFrame(() => {
						const targetRow = rowMapRef.current.get(rowIndex);
						if (!targetRow) {
							if (retries > 0) scrollRowIntoView(retries - 1);
							return;
						}

						const headerBottom =
							headerRef.current?.getBoundingClientRect().bottom ??
							container.getBoundingClientRect().top;

						const viewportTop = headerBottom + VIEWPORT_OFFSET;

						const rowRect = targetRow.getBoundingClientRect();

						if (rowRect.top < viewportTop) {
							container.scrollTop -= viewportTop - rowRect.top;
						}

						const cellKey = getCellKey(rowIndex, columnId);
						const targetCell = cellMapRef.current.get(cellKey);
						if (targetCell) {
							scrollCellIntoView({
								container,
								targetCell,
								tableRef,
								viewportOffset: VIEWPORT_OFFSET,
								isRtl: dir === "rtl",
							});
						}
					});
				};

				scrollRowIntoView();
			},
			onRowHeightChange,
			onRowSelect,
			onDataUpdate,
			onRowsDelete: propsRef.current.onRowsDelete ? onRowsDelete : undefined,
			onColumnClick,
			onCellClick,
			onCellDoubleClick,
			onCellMouseDown,
			onCellMouseEnter,
			onCellMouseUp,
			onCellContextMenu,
			onCellEditingStart,
			onCellEditingStop,
			onCellsCopy,
			onCellsCut,
			onCellsPaste,
			onSelectionClear,
			onFilesUpload: propsRef.current.onFilesUpload
				? propsRef.current.onFilesUpload
				: undefined,
			onFilesDelete: propsRef.current.onFilesDelete
				? propsRef.current.onFilesDelete
				: undefined,
			onContextMenuOpenChange,
			onPasteDialogOpenChange,
		};
	})();

	const getMemoizedCoreRowModel = getCoreRowModel();
	const getMemoizedFilteredRowModel = getFilteredRowModel();
	const getMemoizedSortedRowModel = getSortedRowModel();

	// Memoize state object to reduce shallow equality checks
	const tableState = {
		...propsRef.current.state,
		sorting,
		columnFilters,
		rowSelection,
	};

	const tableOptions = (() => {
		return {
			...propsRef.current,
			data,
			columns,
			defaultColumn,
			initialState: propsRef.current.initialState,
			state: tableState,
			onRowSelectionChange,
			onSortingChange,
			onColumnFiltersChange,
			columnResizeMode: "onChange",
			columnResizeDirection: dir,
			getCoreRowModel: getMemoizedCoreRowModel,
			getFilteredRowModel: getMemoizedFilteredRowModel,
			getSortedRowModel: getMemoizedSortedRowModel,
			meta: tableMeta,
		} as TableOptions<TData>;
	})();

	// eslint-disable-next-line react-hooks-js/incompatible-library -- useReactTable (TanStack Table) returns a table instance whose methods are recreated each render and cannot be memoized by the React Compiler; this is library-internal and not addressable from our code.
	const table = useReactTable(tableOptions);

	if (!tableRef.current) {
		tableRef.current = table;
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: columnSizingInfo and columnSizing are used for calculating the column size vars
	// eslint-disable-next-line react-doctor/react-compiler-no-manual-memoization, react-hooks-js/exhaustive-deps -- the React Compiler memoizes on `table` identity and cannot track the nested `table.getState().columnSizingInfo`/`columnSizing` reads, so the explicit memo + nested-state dep array is required to recompute the column-size CSS vars when sizing changes; inlining would either never recompute or recompute every render.
	const columnSizeVars = React.useMemo(() => {
		const headers = table.getFlatHeaders();
		const colSizes: { [key: string]: number } = {};
		for (const header of headers) {
			colSizes[`--header-${header.id}-size`] = header.getSize();
			colSizes[`--col-${header.column.id}-size`] = header.column.getSize();
		}
		return colSizes;
		// eslint-disable-next-line react-doctor/exhaustive-deps -- memo deps read nested mutable table state (table.getState().columnSizingInfo/columnSizing) the compiler cannot track; the explicit deps are required and must not be replaced by `table` (recreates every render).
	}, [table.getState().columnSizingInfo, table.getState().columnSizing]);

	const isFirefox = React.useSyncExternalStore(
		() => () => {},
		() => {
			if (typeof window === "undefined" || typeof navigator === "undefined") {
				return false;
			}
			return navigator.userAgent.indexOf("Firefox") !== -1;
		},
		() => false,
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: columnPinning is used for calculating the adjustLayout
	// eslint-disable-next-line react-doctor/react-compiler-no-manual-memoization, react-hooks-js/exhaustive-deps -- the React Compiler memoizes on `table` identity and cannot track the nested `table.getState().columnPinning` read, so the explicit memo + nested-state dep array is required to recompute the Firefox pinned-column layout flag only when pinning changes.
	const adjustLayout = React.useMemo(() => {
		const columnPinning = table.getState().columnPinning;
		return (
			isFirefox &&
			((columnPinning.left?.length ?? 0) > 0 ||
				(columnPinning.right?.length ?? 0) > 0)
		);
		// eslint-disable-next-line react-doctor/exhaustive-deps -- memo deps read nested mutable table state (table.getState().columnPinning) the compiler cannot track; the explicit deps are required and must not be replaced by `table` (recreates every render).
	}, [isFirefox, table.getState().columnPinning]);

	const rowVirtualizer = useVirtualizer({
		count: table.getRowModel().rows.length,
		getScrollElement: () => dataGridRef.current,
		estimateSize: () => rowHeightValue,
		overscan,
		...(!isFirefox
			? {
					measureElement: (element: Element) =>
						element.getBoundingClientRect().height,
				}
			: {}),
		scrollPaddingStart:
			(headerRef.current?.getBoundingClientRect().bottom ?? 0) -
			(dataGridRef.current?.getBoundingClientRect().top ?? 0) +
			VIEWPORT_OFFSET,
		// Add extra row buffer to absorb virtual position drift after render measurements
		scrollPaddingEnd:
			(dataGridRef.current?.getBoundingClientRect().bottom ?? 0) -
			(footerRef.current?.getBoundingClientRect().top ??
				dataGridRef.current?.getBoundingClientRect().bottom ??
				0) +
			rowHeightValue +
			VIEWPORT_OFFSET,
	});

	if (!rowVirtualizerRef.current) {
		rowVirtualizerRef.current = rowVirtualizer;
	}

	const onScrollToRow = async (opts: Partial<CellPosition>) => {
		const rowIndex = opts?.rowIndex ?? 0;
		const columnId = opts?.columnId;

		focusGuardRef.current = true;

		const navigableIds = propsRef.current.columns.flatMap((c) => {
			const id =
				c.id ?? ("accessorKey" in c ? (c.accessorKey as string) : undefined);
			return id && !NON_NAVIGABLE_COLUMN_IDS.has(id) ? [id] : [];
		});

		const targetColumnId = columnId ?? navigableIds[0];

		if (!targetColumnId) {
			releaseFocusGuard(true);
			return;
		}

		async function onScrollAndFocus(retryCount: number) {
			if (!targetColumnId) return;
			const currentRowCount = propsRef.current.data.length;

			// If the requested row doesn't exist yet, wait for data to update
			if (rowIndex >= currentRowCount && retryCount > 0) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				await onScrollAndFocus(retryCount - 1);
				return;
			}

			const safeRowIndex = Math.min(rowIndex, Math.max(0, currentRowCount - 1));

			const isBottomHalf = safeRowIndex > currentRowCount / 2;
			rowVirtualizer.scrollToIndex(safeRowIndex, {
				align: isBottomHalf ? "end" : "start",
			});

			await new Promise((resolve) => requestAnimationFrame(resolve));

			// Adjust scroll position to account for sticky header/footer
			const container = dataGridRef.current;
			const targetRow = rowMapRef.current.get(safeRowIndex);

			if (container && targetRow) {
				const containerRect = container.getBoundingClientRect();
				const headerHeight =
					headerRef.current?.getBoundingClientRect().height ?? 0;
				const footerHeight =
					footerRef.current?.getBoundingClientRect().height ?? 0;

				const viewportTop = containerRect.top + headerHeight + VIEWPORT_OFFSET;
				const viewportBottom =
					containerRect.bottom - footerHeight - VIEWPORT_OFFSET;

				const rowRect = targetRow.getBoundingClientRect();
				const isFullyVisible =
					rowRect.top >= viewportTop && rowRect.bottom <= viewportBottom;

				if (!isFullyVisible) {
					if (rowRect.top < viewportTop) {
						// Scroll up as row is partially hidden by header
						container.scrollTop -= viewportTop - rowRect.top;
					} else if (rowRect.bottom > viewportBottom) {
						// Scroll down as row is partially hidden by footer
						container.scrollTop += rowRect.bottom - viewportBottom;
					}
				}
			}

			store.batch(() => {
				store.setState("focusedCell", {
					rowIndex: safeRowIndex,
					columnId: targetColumnId,
				});
				store.setState("editingCell", null);
			});

			const cellKey = getCellKey(safeRowIndex, targetColumnId);
			const cellElement = cellMapRef.current.get(cellKey);

			if (cellElement) {
				cellElement.focus();
				releaseFocusGuard();
			} else if (retryCount > 0) {
				await new Promise((resolve) => requestAnimationFrame(resolve));
				await onScrollAndFocus(retryCount - 1);
			} else {
				dataGridRef.current?.focus();
				releaseFocusGuard();
			}
		}

		await onScrollAndFocus(SCROLL_SYNC_RETRY_COUNT);
	};

	const onRowAdd = async (event?: React.MouseEvent<HTMLDivElement>) => {
		if (propsRef.current.readOnly || !propsRef.current.onRowAdd) return;

		const initialRowCount = propsRef.current.data.length;

		let result: Partial<CellPosition> | null;
		try {
			result = await propsRef.current.onRowAdd(event);
		} catch {
			// Callback threw an error, don't proceed with scroll/focus
			return;
		}

		if (result === null || event?.defaultPrevented) return;

		onSelectionClear();

		// onScrollToRow will handle retries if the row isn't rendered yet
		const targetRowIndex = result.rowIndex ?? initialRowCount;
		const targetColumnId = result.columnId;

		onScrollToRow({
			rowIndex: targetRowIndex,
			columnId: targetColumnId,
		} as Partial<CellPosition>);
	};

	const onDataGridKeyDown = (event: KeyboardEvent) => {
		const currentState = store.getState();
		const { key, ctrlKey, metaKey, shiftKey, altKey } = event;
		const isCtrlPressed = ctrlKey || metaKey;

		if (
			propsRef.current.enableSearch &&
			isCtrlPressed &&
			!shiftKey &&
			key === SEARCH_SHORTCUT_KEY
		) {
			event.preventDefault();
			onSearchOpenChange(true);
			return;
		}

		if (
			propsRef.current.enableSearch &&
			currentState.searchOpen &&
			!currentState.editingCell
		) {
			if (key === "Enter") {
				event.preventDefault();
				if (shiftKey) {
					onNavigateToPrevMatch();
				} else {
					onNavigateToNextMatch();
				}
				return;
			}
			if (key === "Escape") {
				event.preventDefault();
				onSearchOpenChange(false);
				return;
			}
			return;
		}

		// Cell editing keyboard events (Enter, Tab, Escape) are handled by the cell variants
		// to ensure proper value commitment before navigation
		if (currentState.editingCell) return;

		if (
			isCtrlPressed &&
			(key === "Backspace" || key === "Delete") &&
			!propsRef.current.readOnly &&
			propsRef.current.onRowsDelete
		) {
			const rowIndices = new Set<number>();

			const selectedRowIds = Object.keys(currentState.rowSelection);
			if (selectedRowIds.length > 0) {
				const currentTable = tableRef.current;
				const rows = currentTable?.getRowModel().rows ?? [];
				for (const row of rows) {
					if (currentState.rowSelection[row.id]) {
						rowIndices.add(row.index);
					}
				}
			} else if (currentState.selectionState.selectedCells.size > 0) {
				for (const cellKey of currentState.selectionState.selectedCells) {
					const { rowIndex } = parseCellKey(cellKey);
					rowIndices.add(rowIndex);
				}
			} else if (currentState.focusedCell) {
				rowIndices.add(currentState.focusedCell.rowIndex);
			}

			if (rowIndices.size > 0) {
				event.preventDefault();
				onRowsDelete(Array.from(rowIndices));
			}
			return;
		}

		if (!currentState.focusedCell) return;

		let direction: NavigationDirection | null = null;

		if (isCtrlPressed && !shiftKey && key === "a") {
			event.preventDefault();
			selectAll();
			return;
		}

		if (isCtrlPressed && !shiftKey && key === "c") {
			event.preventDefault();
			onCellsCopy();
			return;
		}

		if (
			isCtrlPressed &&
			!shiftKey &&
			key === "x" &&
			!propsRef.current.readOnly
		) {
			event.preventDefault();
			onCellsCut();
			return;
		}

		if (
			propsRef.current.enablePaste &&
			isCtrlPressed &&
			!shiftKey &&
			key === "v" &&
			!propsRef.current.readOnly
		) {
			event.preventDefault();
			onCellsPaste();
			return;
		}

		if (
			(key === "Delete" || key === "Backspace") &&
			!isCtrlPressed &&
			!propsRef.current.readOnly
		) {
			const cellsToClear =
				currentState.selectionState.selectedCells.size > 0
					? Array.from(currentState.selectionState.selectedCells)
					: currentState.focusedCell
						? [
								getCellKey(
									currentState.focusedCell.rowIndex,
									currentState.focusedCell.columnId,
								),
							]
						: [];

			if (cellsToClear.length > 0) {
				event.preventDefault();

				const updates: Array<{
					rowIndex: number;
					columnId: string;
					value: unknown;
				}> = [];

				const currentTable = tableRef.current;
				const tableColumns = currentTable?.getAllColumns() ?? [];
				const columnById = new Map(tableColumns.map((c) => [c.id, c]));

				for (const cellKey of cellsToClear) {
					const { rowIndex, columnId } = parseCellKey(cellKey);
					const column = columnById.get(columnId);
					const cellVariant = column?.columnDef?.meta?.cell?.variant;
					const emptyValue = getEmptyCellValue(cellVariant);
					updates.push({ rowIndex, columnId, value: emptyValue });
				}

				onDataUpdate(updates);

				if (currentState.selectionState.selectedCells.size > 0) {
					onSelectionClear();
				}

				if (currentState.cutCells.size > 0) {
					store.setState("cutCells", new Set());
				}
			}
			return;
		}

		if (
			key === "Enter" &&
			shiftKey &&
			!propsRef.current.readOnly &&
			propsRef.current.onRowAdd
		) {
			event.preventDefault();
			const initialRowCount = propsRef.current.data.length;
			const currentColumnId = currentState.focusedCell.columnId;

			Promise.resolve(propsRef.current.onRowAdd())
				.then(async (result) => {
					if (result === null) return;

					onSelectionClear();

					const targetRowIndex = result.rowIndex ?? initialRowCount;
					const targetColumnId = result.columnId ?? currentColumnId;

					onScrollToRow({
						rowIndex: targetRowIndex,
						columnId: targetColumnId,
					});
				})
				.catch(() => {
					// Callback threw an error, don't proceed with scroll/focus
				});
			return;
		}

		switch (key) {
			case "ArrowUp":
				if (altKey && !isCtrlPressed && !shiftKey) {
					direction = "pageup";
				} else if (isCtrlPressed && shiftKey) {
					const selectionEdge =
						currentState.selectionState.selectionRange?.end ||
						currentState.focusedCell;
					const currentColIndex = navigableColumnIds.indexOf(
						selectionEdge.columnId,
					);
					const selectionStart =
						currentState.selectionState.selectionRange?.start ||
						currentState.focusedCell;

					selectRange(selectionStart, {
						rowIndex: 0,
						columnId:
							navigableColumnIds[currentColIndex] ?? selectionEdge.columnId,
					});

					const rowVirtualizer = rowVirtualizerRef.current;
					if (rowVirtualizer) {
						rowVirtualizer.scrollToIndex(0, { align: "start" });
					}

					restoreFocus(dataGridRef.current);

					event.preventDefault();
					return;
				} else if (isCtrlPressed && !shiftKey) {
					direction = "ctrl+up";
				} else {
					direction = "up";
				}
				break;
			case "ArrowDown":
				if (altKey && !isCtrlPressed && !shiftKey) {
					direction = "pagedown";
				} else if (isCtrlPressed && shiftKey) {
					const rowCount =
						tableRef.current?.getRowModel().rows.length ||
						propsRef.current.data.length;
					const selectionEdge =
						currentState.selectionState.selectionRange?.end ||
						currentState.focusedCell;
					const currentColIndex = navigableColumnIds.indexOf(
						selectionEdge.columnId,
					);
					const selectionStart =
						currentState.selectionState.selectionRange?.start ||
						currentState.focusedCell;

					selectRange(selectionStart, {
						rowIndex: Math.max(0, rowCount - 1),
						columnId:
							navigableColumnIds[currentColIndex] ?? selectionEdge.columnId,
					});

					const rowVirtualizer = rowVirtualizerRef.current;
					if (rowVirtualizer) {
						rowVirtualizer.scrollToIndex(Math.max(0, rowCount - 1), {
							align: "end",
						});
					}

					restoreFocus(dataGridRef.current);

					event.preventDefault();
					return;
				} else if (isCtrlPressed && !shiftKey) {
					direction = "ctrl+down";
				} else {
					direction = "down";
				}
				break;
			case "ArrowLeft":
				if (isCtrlPressed && shiftKey) {
					const selectionEdge =
						currentState.selectionState.selectionRange?.end ||
						currentState.focusedCell;
					const selectionStart =
						currentState.selectionState.selectionRange?.start ||
						currentState.focusedCell;
					const targetColumnId =
						dir === "rtl"
							? navigableColumnIds[navigableColumnIds.length - 1]
							: navigableColumnIds[0];

					if (targetColumnId) {
						selectRange(selectionStart, {
							rowIndex: selectionEdge.rowIndex,
							columnId: targetColumnId,
						});

						const container = dataGridRef.current;
						const cellKey = getCellKey(selectionEdge.rowIndex, targetColumnId);
						const targetCell = cellMapRef.current.get(cellKey);
						if (container && targetCell) {
							scrollCellIntoView({
								container,
								targetCell,
								tableRef,
								viewportOffset: VIEWPORT_OFFSET,
								direction: "home",
								isRtl: dir === "rtl",
							});
						}

						restoreFocus(container);
					}
					event.preventDefault();
					return;
				} else if (isCtrlPressed && !shiftKey) {
					direction = "home";
				} else {
					direction = "left";
				}
				break;
			case "ArrowRight":
				if (isCtrlPressed && shiftKey) {
					const selectionEdge =
						currentState.selectionState.selectionRange?.end ||
						currentState.focusedCell;
					const selectionStart =
						currentState.selectionState.selectionRange?.start ||
						currentState.focusedCell;
					const targetColumnId =
						dir === "rtl"
							? navigableColumnIds[0]
							: navigableColumnIds[navigableColumnIds.length - 1];

					if (targetColumnId) {
						selectRange(selectionStart, {
							rowIndex: selectionEdge.rowIndex,
							columnId: targetColumnId,
						});

						const container = dataGridRef.current;
						const cellKey = getCellKey(selectionEdge.rowIndex, targetColumnId);
						const targetCell = cellMapRef.current.get(cellKey);
						if (container && targetCell) {
							scrollCellIntoView({
								container,
								targetCell,
								tableRef,
								viewportOffset: VIEWPORT_OFFSET,
								direction: "end",
								isRtl: dir === "rtl",
							});
						}

						restoreFocus(container);
					}
					event.preventDefault();
					return;
				} else if (isCtrlPressed && !shiftKey) {
					direction = "end";
				} else {
					direction = "right";
				}
				break;
			case "Home":
				direction = isCtrlPressed ? "ctrl+home" : "home";
				break;
			case "End":
				direction = isCtrlPressed ? "ctrl+end" : "end";
				break;
			case "PageUp":
				direction = altKey ? "pageleft" : "pageup";
				break;
			case "PageDown":
				direction = altKey ? "pageright" : "pagedown";
				break;
			case "Escape":
				event.preventDefault();
				if (
					currentState.selectionState.selectedCells.size > 0 ||
					Object.keys(currentState.rowSelection).length > 0
				) {
					onSelectionClear();
				} else {
					blurCell();
				}
				return;
			case "Tab":
				event.preventDefault();
				if (dir === "rtl") {
					direction = event.shiftKey ? "right" : "left";
				} else {
					direction = event.shiftKey ? "left" : "right";
				}
				break;
		}

		if (direction) {
			event.preventDefault();

			if (shiftKey && key !== "Tab" && currentState.focusedCell) {
				const selectionEdge =
					currentState.selectionState.selectionRange?.end ||
					currentState.focusedCell;

				const currentColIndex = navigableColumnIds.indexOf(
					selectionEdge.columnId,
				);
				let newRowIndex = selectionEdge.rowIndex;
				let newColumnId = selectionEdge.columnId;

				const isRtl = dir === "rtl";

				const rowCount =
					tableRef.current?.getRowModel().rows.length ||
					propsRef.current.data.length;

				switch (direction) {
					case "up":
						newRowIndex = Math.max(0, selectionEdge.rowIndex - 1);
						break;
					case "down":
						newRowIndex = Math.min(rowCount - 1, selectionEdge.rowIndex + 1);
						break;
					case "left":
						if (isRtl) {
							if (currentColIndex < navigableColumnIds.length - 1) {
								const nextColumnId = navigableColumnIds[currentColIndex + 1];
								if (nextColumnId) newColumnId = nextColumnId;
							}
						} else {
							if (currentColIndex > 0) {
								const prevColumnId = navigableColumnIds[currentColIndex - 1];
								if (prevColumnId) newColumnId = prevColumnId;
							}
						}
						break;
					case "right":
						if (isRtl) {
							if (currentColIndex > 0) {
								const prevColumnId = navigableColumnIds[currentColIndex - 1];
								if (prevColumnId) newColumnId = prevColumnId;
							}
						} else {
							if (currentColIndex < navigableColumnIds.length - 1) {
								const nextColumnId = navigableColumnIds[currentColIndex + 1];
								if (nextColumnId) newColumnId = nextColumnId;
							}
						}
						break;
					case "home":
						if (navigableColumnIds.length > 0) {
							newColumnId = navigableColumnIds[0] ?? newColumnId;
						}
						break;
					case "end":
						if (navigableColumnIds.length > 0) {
							newColumnId =
								navigableColumnIds[navigableColumnIds.length - 1] ??
								newColumnId;
						}
						break;
				}

				const selectionStart =
					currentState.selectionState.selectionRange?.start ||
					currentState.focusedCell;

				selectRange(selectionStart, {
					rowIndex: newRowIndex,
					columnId: newColumnId,
				});

				const container = dataGridRef.current;
				const targetRow = rowMapRef.current.get(newRowIndex);
				const cellKey = getCellKey(newRowIndex, newColumnId);
				const targetCell = cellMapRef.current.get(cellKey);

				if (
					newRowIndex !== selectionEdge.rowIndex &&
					(direction === "up" || direction === "down")
				) {
					if (container && targetRow) {
						const containerRect = container.getBoundingClientRect();
						const headerHeight =
							headerRef.current?.getBoundingClientRect().height ?? 0;
						const footerHeight =
							footerRef.current?.getBoundingClientRect().height ?? 0;

						const viewportTop =
							containerRect.top + headerHeight + VIEWPORT_OFFSET;
						const viewportBottom =
							containerRect.bottom - footerHeight - VIEWPORT_OFFSET;

						const rowRect = targetRow.getBoundingClientRect();
						const isFullyVisible =
							rowRect.top >= viewportTop && rowRect.bottom <= viewportBottom;

						if (!isFullyVisible) {
							const scrollNeeded =
								direction === "down"
									? rowRect.bottom - viewportBottom
									: viewportTop - rowRect.top;

							if (direction === "down") {
								container.scrollTop += scrollNeeded;
							} else {
								container.scrollTop -= scrollNeeded;
							}

							restoreFocus(container);
						}
					} else {
						const rowVirtualizer = rowVirtualizerRef.current;
						if (rowVirtualizer) {
							const align = direction === "up" ? "start" : "end";
							rowVirtualizer.scrollToIndex(newRowIndex, { align });

							restoreFocus(container);
						}
					}
				}

				if (
					newColumnId !== selectionEdge.columnId &&
					(direction === "left" ||
						direction === "right" ||
						direction === "home" ||
						direction === "end")
				) {
					if (container && targetCell) {
						scrollCellIntoView({
							container,
							targetCell,
							tableRef,
							viewportOffset: VIEWPORT_OFFSET,
							direction,
							isRtl,
						});
					}
				}
			} else {
				if (currentState.selectionState.selectedCells.size > 0) {
					onSelectionClear();
				}
				navigateCell(direction);
			}
		}
	};

	const searchState = (() => {
		if (!propsRef.current.enableSearch) return undefined;

		return {
			searchMatches,
			matchIndex,
			searchOpen,
			onSearchOpenChange,
			searchQuery,
			onSearchQueryChange,
			onSearch,
			onNavigateToNextMatch,
			onNavigateToPrevMatch,
		};
	})();

	const onDataGridKeyDownRef = useAsRef(onDataGridKeyDown);
	React.useEffect(() => {
		const dataGridElement = dataGridRef.current;
		if (!dataGridElement) return;

		const handleKeyDown = (event: KeyboardEvent) =>
			onDataGridKeyDownRef.current(event);
		dataGridElement.addEventListener("keydown", handleKeyDown);
		return () => {
			dataGridElement.removeEventListener("keydown", handleKeyDown);
		};
	}, [onDataGridKeyDownRef]);

	const onSearchOpenChangeRef = useAsRef(onSearchOpenChange);
	const onSelectionClearRef = useAsRef(onSelectionClear);
	React.useEffect(() => {
		function onGlobalKeyDown(event: KeyboardEvent) {
			const dataGridElement = dataGridRef.current;
			if (!dataGridElement) return;

			const target = event.target;
			if (!(target instanceof HTMLElement)) return;

			const { key, ctrlKey, metaKey, shiftKey } = event;
			const isCommandPressed = ctrlKey || metaKey;

			if (
				propsRef.current.enableSearch &&
				isCommandPressed &&
				!shiftKey &&
				key === SEARCH_SHORTCUT_KEY
			) {
				const isInInput =
					target.tagName === "INPUT" || target.tagName === "TEXTAREA";
				const isInDataGrid = dataGridElement.contains(target);
				const isInSearchInput = target.closest('[role="search"]') !== null;

				if (isInDataGrid || isInSearchInput || !isInInput) {
					event.preventDefault();
					event.stopPropagation();

					const nextSearchOpen = !store.getState().searchOpen;
					onSearchOpenChangeRef.current(nextSearchOpen);

					if (nextSearchOpen && !isInDataGrid && !isInSearchInput) {
						requestAnimationFrame(() => {
							dataGridElement.focus();
						});
					}
					return;
				}
			}

			const isInDataGrid = dataGridElement.contains(target);
			if (!isInDataGrid) return;

			if (key === "Escape") {
				const currentState = store.getState();
				const hasSelections =
					currentState.selectionState.selectedCells.size > 0 ||
					Object.keys(currentState.rowSelection).length > 0;

				if (hasSelections) {
					event.preventDefault();
					event.stopPropagation();
					onSelectionClearRef.current();
				}
			}
		}

		window.addEventListener("keydown", onGlobalKeyDown, true);
		return () => {
			window.removeEventListener("keydown", onGlobalKeyDown, true);
		};
	}, [propsRef, onSearchOpenChangeRef, store, onSelectionClearRef]);

	const focusCellRef = useAsRef(focusCell);
	const navigableColumnIdsRef = useAsRef(navigableColumnIds);
	React.useEffect(() => {
		const currentState = store.getState();
		const autoFocus = propsRef.current.autoFocus;
		const currentNavigableColumnIds = navigableColumnIdsRef.current;

		if (
			autoFocus &&
			data.length > 0 &&
			columns.length > 0 &&
			!currentState.focusedCell
		) {
			if (currentNavigableColumnIds.length > 0) {
				const rafId = requestAnimationFrame(() => {
					if (typeof autoFocus === "object") {
						const { rowIndex, columnId } = autoFocus;
						if (columnId) {
							focusCellRef.current(rowIndex ?? 0, columnId);
						}
						return;
					}

					const firstColumnId = currentNavigableColumnIds[0];
					if (firstColumnId) {
						focusCellRef.current(0, firstColumnId);
					}
				});
				return () => cancelAnimationFrame(rafId);
			}
		}

		return undefined;
	}, [store, propsRef, data, columns, navigableColumnIdsRef, focusCellRef]);

	// Restore focus to container when virtualized cells are unmounted
	React.useEffect(() => {
		const container = dataGridRef.current;
		if (!container) return;

		function onFocusOut(event: FocusEvent) {
			if (focusGuardRef.current) return;

			const currentContainer = dataGridRef.current;
			if (!currentContainer) return;

			const currentState = store.getState();

			if (!currentState.focusedCell || currentState.editingCell) return;

			const relatedTarget = event.relatedTarget;

			const isFocusMovingOutsideGrid =
				!relatedTarget || !currentContainer.contains(relatedTarget as Node);

			const isFocusMovingToPopover = getIsInPopover(relatedTarget);

			if (isFocusMovingOutsideGrid && !isFocusMovingToPopover) {
				const { rowIndex, columnId } = currentState.focusedCell;
				const cellKey = getCellKey(rowIndex, columnId);
				const cellElement = cellMapRef.current.get(cellKey);

				requestAnimationFrame(() => {
					if (focusGuardRef.current) return;

					if (cellElement && document.body.contains(cellElement)) {
						cellElement.focus();
					} else {
						currentContainer.focus();
					}
				});
			}
		}

		container.addEventListener("focusout", onFocusOut);

		return () => {
			container.removeEventListener("focusout", onFocusOut);
		};
		// eslint-disable-next-line react-doctor/exhaustive-deps -- the focusout listener subscribes once per store identity and reads all live values through stable refs (dataGridRef/focusGuardRef/cellMapRef); listing them would force a needless re-subscribe every render
	}, [store]);

	const blurCellRef = useAsRef(blurCell);
	React.useEffect(() => {
		function onOutsideClick(event: MouseEvent) {
			if (event.button === 2) {
				return;
			}

			if (
				dataGridRef.current &&
				!dataGridRef.current.contains(event.target as Node)
			) {
				const elements = document.elementsFromPoint(
					event.clientX,
					event.clientY,
				);

				// Compensate for event.target bubbling up
				const isInsidePopover = elements.some((element) =>
					getIsInPopover(element),
				);

				if (!isInsidePopover) {
					blurCellRef.current();
					const currentState = store.getState();
					if (
						currentState.selectionState.selectedCells.size > 0 ||
						Object.keys(currentState.rowSelection).length > 0
					) {
						onSelectionClearRef.current();
					}
				}
			}
		}

		document.addEventListener("mousedown", onOutsideClick);
		return () => {
			document.removeEventListener("mousedown", onOutsideClick);
		};
	}, [store, blurCellRef, onSelectionClearRef]);

	React.useEffect(() => {
		function onSelectStart(event: Event) {
			event.preventDefault();
		}

		function onContextMenu(event: Event) {
			event.preventDefault();
		}

		function onCleanup() {
			document.removeEventListener("selectstart", onSelectStart);
			document.removeEventListener("contextmenu", onContextMenu);
			document.body.style.userSelect = "";
		}

		const onUnsubscribe = store.subscribe(() => {
			const currentState = store.getState();
			if (currentState.selectionState.isSelecting) {
				document.addEventListener("selectstart", onSelectStart);
				document.addEventListener("contextmenu", onContextMenu);
				document.body.style.userSelect = "none";
			} else {
				onCleanup();
			}
		});

		return () => {
			onCleanup();
			onUnsubscribe();
		};
	}, [store]);

	React.useEffect(() => {
		let rafId: number | null = null;
		let mouseX = 0;
		let mouseY = 0;
		let mouseReady = false;
		let active = false;
		let lastSelectionTime = 0;
		let resizeObserver: ResizeObserver | null = null;

		let cachedRect: DOMRect | null = null;
		let cachedHdrH = 0;
		let cachedFtrH = 0;
		let cachedLpw = 0;
		let cachedRpw = 0;

		function getAutoScrollSpeed(dist: number): number {
			const t = Math.min(dist / AUTO_SCROLL_SPEED_RAMP_ZONE, 1);
			return Math.round(
				AUTO_SCROLL_MIN_SPEED +
					(AUTO_SCROLL_MAX_SPEED - AUTO_SCROLL_MIN_SPEED) * t,
			);
		}

		function cacheLayout(container: HTMLDivElement) {
			cachedRect = container.getBoundingClientRect();
			cachedHdrH = headerRef.current?.getBoundingClientRect().height ?? 0;
			cachedFtrH = footerRef.current?.getBoundingClientRect().height ?? 0;
			const tbl = tableRef.current;
			if (tbl) {
				cachedLpw = tbl
					.getLeftVisibleLeafColumns()
					.reduce((s, c) => s + c.getSize(), 0);
				cachedRpw = tbl
					.getRightVisibleLeafColumns()
					.reduce((s, c) => s + c.getSize(), 0);
			}
		}

		function tick() {
			if (!active) return;
			const container = dataGridRef.current;
			const tbl = tableRef.current;

			if (!container || !tbl) {
				onAutoScrollStop();
				return;
			}

			if (!mouseReady || !cachedRect) {
				rafId = requestAnimationFrame(tick);
				return;
			}

			const rect = cachedRect;
			const { dir } = dragDepsRef.current;
			const hasNegativeScroll = container.scrollLeft < 0;
			const isActuallyRtl = dir === "rtl" || hasNegativeScroll;

			const dataTop = rect.top + cachedHdrH;
			const dataBottom = rect.bottom - cachedFtrH;

			const scrollAreaLeft = isActuallyRtl
				? rect.left + cachedRpw
				: rect.left + cachedLpw;
			const scrollAreaRight = isActuallyRtl
				? rect.right - cachedLpw
				: rect.right - cachedRpw;

			let dy = 0;
			let dx = 0;

			if (mouseY < dataTop) dy = -getAutoScrollSpeed(dataTop - mouseY);
			else if (mouseY > dataBottom)
				dy = getAutoScrollSpeed(mouseY - dataBottom);

			if (mouseX < scrollAreaLeft)
				dx = -getAutoScrollSpeed(scrollAreaLeft - mouseX);
			else if (mouseX > scrollAreaRight)
				dx = getAutoScrollSpeed(mouseX - scrollAreaRight);

			if (dx === 0 && dy === 0) {
				rafId = requestAnimationFrame(tick);
				return;
			}

			container.scrollTop += dy;
			container.scrollLeft += dx;

			const now = performance.now();
			if (now - lastSelectionTime < AUTO_SCROLL_SELECTION_THROTTLE_MS) {
				rafId = requestAnimationFrame(tick);
				return;
			}

			const { rowHeightValue: rh, columnIds } = dragDepsRef.current;
			if (columnIds.length === 0) {
				rafId = requestAnimationFrame(tick);
				return;
			}

			const totalRows = tbl.getRowModel().rows.length;
			const clampedY = Math.max(dataTop, Math.min(mouseY, dataBottom));
			const absY = container.scrollTop + (clampedY - dataTop);
			const rowIndex = Math.max(
				0,
				Math.min(Math.floor(absY / rh), totalRows - 1),
			);

			const st = store.getState();
			const range = st.selectionState.selectionRange;

			let columnId: string | undefined;

			if (dx !== 0) {
				const clampedX = Math.max(rect.left, Math.min(mouseX, rect.right));
				const relX = clampedX - rect.left;

				const leftZoneWidth = isActuallyRtl ? cachedRpw : cachedLpw;
				const rightZoneWidth = isActuallyRtl ? cachedLpw : cachedRpw;

				if (relX < leftZoneWidth) {
					const columns = isActuallyRtl
						? tbl.getRightVisibleLeafColumns()
						: tbl.getLeftVisibleLeafColumns();
					columnId = columns[0]?.id ?? columnIds[0] ?? "";
					let cx = 0;
					for (const col of columns) {
						if (relX < cx + col.getSize()) {
							columnId = col.id;
							break;
						}
						cx += col.getSize();
					}
				} else if (relX > rect.width - rightZoneWidth) {
					const columns = isActuallyRtl
						? tbl.getLeftVisibleLeafColumns()
						: tbl.getRightVisibleLeafColumns();
					columnId = columns[0]?.id ?? columnIds[columnIds.length - 1] ?? "";
					let cx = rect.width - rightZoneWidth;
					for (const col of columns) {
						if (relX < cx + col.getSize()) {
							columnId = col.id;
							break;
						}
						cx += col.getSize();
					}
				} else {
					const center = tbl.getCenterVisibleLeafColumns();
					const centerZoneWidth = rect.width - leftZoneWidth - rightZoneWidth;
					const distFromVisualLeft = relX - leftZoneWidth;

					let absX: number;
					if (isActuallyRtl) {
						const scrollFromRight = hasNegativeScroll
							? -container.scrollLeft
							: container.scrollWidth -
								container.clientWidth -
								container.scrollLeft;
						absX = scrollFromRight + (centerZoneWidth - distFromVisualLeft);
					} else {
						absX = container.scrollLeft + distFromVisualLeft;
					}

					columnId =
						center[center.length - 1]?.id ??
						columnIds[columnIds.length - 1] ??
						"";
					let cw = 0;
					for (const col of center) {
						cw += col.getSize();
						if (absX < cw) {
							columnId = col.id;
							break;
						}
					}
				}
			}

			if (!columnId) {
				columnId = range?.end.columnId ?? columnIds[0] ?? "";
			}

			if (
				range &&
				(rowIndex !== range.end.rowIndex || columnId !== range.end.columnId)
			) {
				dragDepsRef.current.selectRange(
					range.start,
					{ rowIndex, columnId },
					true,
				);
				lastSelectionTime = now;
			}

			rafId = requestAnimationFrame(tick);
		}

		function onMove(event: MouseEvent) {
			mouseX = event.clientX;
			mouseY = event.clientY;
			mouseReady = true;
		}

		function onUp() {
			onAutoScrollStop();
			const st = store.getState();
			if (st.selectionState.isSelecting) {
				store.setState("selectionState", {
					...st.selectionState,
					isSelecting: false,
				});
			}
		}

		function onAutoScrollStart() {
			if (active) return;

			const container = dataGridRef.current;
			if (!container) return;

			active = true;
			mouseReady = false;
			cachedRect = null;
			lastSelectionTime = 0;
			document.addEventListener("mousemove", onMove);
			document.addEventListener("mouseup", onUp);
			resizeObserver = new ResizeObserver(() => {
				const currentContainer = dataGridRef.current;
				if (currentContainer) cacheLayout(currentContainer);
			});
			resizeObserver.observe(container);
			rafId = requestAnimationFrame(() => {
				const currentContainer = dataGridRef.current;
				if (currentContainer) cacheLayout(currentContainer);
				rafId = requestAnimationFrame(tick);
			});
		}

		function onAutoScrollStop() {
			if (!active) return;
			active = false;
			cachedRect = null;
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
			resizeObserver?.disconnect();
			resizeObserver = null;
			if (rafId !== null) {
				cancelAnimationFrame(rafId);
				rafId = null;
			}
		}

		if (store.getState().selectionState.isSelecting) onAutoScrollStart();

		const onUnsubscribe = store.subscribe(() => {
			const st = store.getState();
			if (st.selectionState.isSelecting && !active) onAutoScrollStart();
			else if (!st.selectionState.isSelecting && active) onAutoScrollStop();
		});

		return () => {
			onAutoScrollStop();
			onUnsubscribe();
		};
	}, [store, dragDepsRef]);

	useIsomorphicLayoutEffect(() => {
		const rafId = requestAnimationFrame(() => {
			rowVirtualizer.measure();
		});
		return () => cancelAnimationFrame(rafId);
	}, [
		rowHeight,
		table.getState().columnFilters,
		table.getState().columnOrder,
		table.getState().columnPinning,
		table.getState().columnSizing,
		table.getState().columnVisibility,
		table.getState().expanded,
		table.getState().globalFilter,
		table.getState().grouping,
		table.getState().rowSelection,
		table.getState().sorting,
	]);

	const virtualTotalSize = rowVirtualizer.getTotalSize();
	const virtualItems = rowVirtualizer.getVirtualItems();
	const measureElement = rowVirtualizer.measureElement;

	return {
		dataGridRef,
		headerRef,
		rowMapRef,
		footerRef,
		dir,
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
		onRowAdd: propsRef.current.onRowAdd ? onRowAdd : undefined,
		adjustLayout,
	};
}

export { useDataGrid };
