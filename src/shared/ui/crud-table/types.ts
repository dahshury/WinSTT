import type { IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import type { ZodType } from "zod";

/** Default rows per page when a {@link CrudTableProps} table is `paginated`. */
export const DEFAULT_PAGE_SIZE = 10;

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
