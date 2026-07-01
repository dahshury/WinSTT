import type { Cell, RowData, TableMeta } from "@tanstack/react-table";

export type Direction = "ltr" | "rtl";

export type RowHeightValue = "short" | "medium" | "tall" | "extra-tall";

export interface CellSelectOption {
	label: string;
	value: string;
	icon?: React.ComponentType<React.ComponentProps<"svg">>;
	count?: number;
}

export type CellOpts =
	| {
			variant: "short-text";
	  }
	| {
			variant: "long-text";
	  }
	| {
			variant: "number";
			min?: number;
			max?: number;
			step?: number;
	  }
	| {
			variant: "select";
			options: CellSelectOption[];
	  }
	| {
			variant: "multi-select";
			options: CellSelectOption[];
	  }
	| {
			variant: "checkbox";
	  }
	| {
			variant: "date";
	  }
	| {
			variant: "url";
	  }
	| {
			variant: "file";
			maxFileSize?: number;
			maxFiles?: number;
			accept?: string;
			multiple?: boolean;
	  };

export interface CellUpdate {
	rowIndex: number;
	columnId: string;
	value: unknown;
}

declare module "@tanstack/react-table" {
	interface ColumnMeta<TData extends RowData, TValue> {
		label?: string | undefined;
		cell?: CellOpts | undefined;
	}

	interface TableMeta<TData extends RowData> {
		dataGridRef?: React.RefObject<HTMLElement | null> | undefined;
		cellMapRef?: React.RefObject<Map<string, HTMLDivElement>> | undefined;
		focusedCell?: CellPosition | null | undefined;
		editingCell?: CellPosition | null | undefined;
		selectionState?: SelectionState | undefined;
		searchOpen?: boolean | undefined;
		getIsCellSelected?:
			| ((rowIndex: number, columnId: string) => boolean)
			| undefined;
		getIsSearchMatch?:
			| ((rowIndex: number, columnId: string) => boolean)
			| undefined;
		getIsActiveSearchMatch?:
			| ((rowIndex: number, columnId: string) => boolean)
			| undefined;
		getVisualRowIndex?: ((rowId: string) => number | undefined) | undefined;
		scrollToCell?:
			| ((
					rowIndex: number,
					columnId: string,
					align?: "auto" | "start" | "center" | "end",
			  ) => void)
			| undefined;
		rowHeight?: RowHeightValue | undefined;
		onRowHeightChange?: ((value: RowHeightValue) => void) | undefined;
		onRowSelect?:
			| ((rowId: string, checked: boolean, shiftKey: boolean) => void)
			| undefined;
		onDataUpdate?:
			| ((params: CellUpdate | Array<CellUpdate>) => void)
			| undefined;
		onRowsDelete?: ((rowIndices: number[]) => void | Promise<void>) | undefined;
		onColumnClick?: ((columnId: string) => void) | undefined;
		onCellClick?:
			| ((rowIndex: number, columnId: string, event?: React.MouseEvent) => void)
			| undefined;
		onCellDoubleClick?:
			| ((rowIndex: number, columnId: string) => void)
			| undefined;
		onCellMouseDown?:
			| ((rowIndex: number, columnId: string, event: React.MouseEvent) => void)
			| undefined;
		onCellMouseEnter?:
			| ((rowIndex: number, columnId: string) => void)
			| undefined;
		onCellMouseUp?: (() => void) | undefined;
		onCellContextMenu?:
			| ((rowIndex: number, columnId: string, event: React.MouseEvent) => void)
			| undefined;
		onCellEditingStart?:
			| ((rowIndex: number, columnId: string) => void)
			| undefined;
		onCellEditingStop?:
			| ((opts?: {
					direction?: NavigationDirection;
					moveToNextRow?: boolean;
			  }) => void)
			| undefined;
		onCellsCopy?: (() => void) | undefined;
		onCellsCut?: (() => void) | undefined;
		onCellsPaste?: ((expand?: boolean) => void) | undefined;
		onSelectionClear?: (() => void) | undefined;
		onFilesUpload?:
			| ((params: {
					files: File[];
					rowIndex: number;
					columnId: string;
			  }) => Promise<FileCellData[]>)
			| undefined;
		onFilesDelete?:
			| ((params: {
					fileIds: string[];
					rowIndex: number;
					columnId: string;
			  }) => void | Promise<void>)
			| undefined;
		contextMenu?: ContextMenuState;
		onContextMenuOpenChange?: ((open: boolean) => void) | undefined;
		pasteDialog?: PasteDialogState;
		onPasteDialogOpenChange?: ((open: boolean) => void) | undefined;
		readOnly?: boolean | undefined;
	}
}

export interface CellPosition {
	rowIndex: number;
	columnId: string;
}

export interface CellRange {
	start: CellPosition;
	end: CellPosition;
}

export interface SelectionState {
	selectedCells: Set<string>;
	selectionRange: CellRange | null;
	isSelecting: boolean;
}

export interface ContextMenuState {
	open: boolean;
	x: number;
	y: number;
}

export interface PasteDialogState {
	open: boolean;
	rowsNeeded: number;
	clipboardText: string;
}

export type NavigationDirection =
	| "up"
	| "down"
	| "left"
	| "right"
	| "home"
	| "end"
	| "ctrl+up"
	| "ctrl+down"
	| "ctrl+home"
	| "ctrl+end"
	| "pageup"
	| "pagedown"
	| "pageleft"
	| "pageright";

export interface SearchState {
	searchMatches: CellPosition[];
	matchIndex: number;
	searchOpen: boolean;
	onSearchOpenChange: (open: boolean) => void;
	searchQuery: string;
	onSearchQueryChange: (query: string) => void;
	onSearch: (query: string) => void;
	onNavigateToNextMatch: () => void;
	onNavigateToPrevMatch: () => void;
}

export interface DataGridCellState {
	isEditing: boolean;
	isFocused: boolean;
	isSelected: boolean;
	isSearchMatch: boolean;
	isActiveSearchMatch: boolean;
	readOnly: boolean;
}

export interface DataGridCellProps<TData> {
	cell: Cell<TData, unknown>;
	tableMeta: TableMeta<TData>;
	rowIndex: number;
	columnId: string;
	rowHeight: RowHeightValue;
	state: DataGridCellState;
}

export interface FileCellData {
	id: string;
	name: string;
	size: number;
	type: string;
	url?: string | undefined;
}

export type TextFilterOperator =
	| "contains"
	| "notContains"
	| "equals"
	| "notEquals"
	| "startsWith"
	| "endsWith"
	| "isEmpty"
	| "isNotEmpty";

export type NumberFilterOperator =
	| "equals"
	| "notEquals"
	| "lessThan"
	| "lessThanOrEqual"
	| "greaterThan"
	| "greaterThanOrEqual"
	| "isBetween"
	| "isEmpty"
	| "isNotEmpty";

export type DateFilterOperator =
	| "equals"
	| "notEquals"
	| "before"
	| "after"
	| "onOrBefore"
	| "onOrAfter"
	| "isBetween"
	| "isEmpty"
	| "isNotEmpty";

export type SelectFilterOperator =
	| "is"
	| "isNot"
	| "isAnyOf"
	| "isNoneOf"
	| "isEmpty"
	| "isNotEmpty";

export type BooleanFilterOperator = "isTrue" | "isFalse";

export type FilterOperator =
	| TextFilterOperator
	| NumberFilterOperator
	| DateFilterOperator
	| SelectFilterOperator
	| BooleanFilterOperator;

export interface FilterValue {
	operator: FilterOperator;
	value?: string | number | string[];
	endValue?: string | number;
}
