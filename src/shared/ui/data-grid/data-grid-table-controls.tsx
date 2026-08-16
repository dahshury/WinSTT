import type { Table } from "@tanstack/react-table";
import {
	ArrowUpDownIcon,
	FilterIcon,
	RowInsertIcon,
	Settings02Icon,
} from "@hugeicons/core-free-icons";
import { type KeyboardEvent, useRef } from "react";
import { useTranslations } from "use-intl";
import { FilterMenuTriggerButton } from "@/shared/ui/model-picker/core/FilterMenuTriggerButton";
import {
	NavList,
	NavPopover,
	type NavPopoverHandle,
	type NavPopoverView,
	NavRow,
} from "@/shared/ui/nav-popover";
import {
	DataGridFilterPanel,
	resetDataGridFilters,
} from "./data-grid-filter-menu";
import {
	REMOVE_MENU_ITEM_SHORTCUTS,
	useDataGridMenuShortcut,
} from "./data-grid-menu-common";
import {
	DataGridRowHeightPanel,
	rowHeightLabel,
} from "./data-grid-row-height-menu";
import { DataGridSortPanel, resetDataGridSorting } from "./data-grid-sort-menu";
import {
	columnVisibilitySummary,
	DataGridColumnsPanel,
} from "./data-grid-view-menu";

const FILTER_SHORTCUT_KEY = "f";
const SORT_SHORTCUT_KEY = "s";

/** Widths the four views ask the frame to ease between. The filter builder
 *  needs room for field + operator + value + two icon buttons on one line; the
 *  row-height list needs almost none. This spread is the reason the frame
 *  animates width at all. */
const WIDTH = {
	columns: 260,
	filters: 480,
	root: 300,
	rowHeight: 220,
	sort: 400,
} as const;

/**
 * Every table control in one drill-down popover: Filters, Sort, Row height and
 * Columns, each a row showing its current state and drilling into its own view.
 *
 * They used to be four sibling triggers opening four popovers of wildly
 * different widths (176px through 480px) with no shared vocabulary. Folding
 * them in also collapses the grid's busiest chrome down to a single button.
 *
 * Ctrl+Shift+F / Ctrl+Shift+S still jump straight to Filters / Sort — they open
 * the popover *at* that view rather than toggling a menu of their own — and
 * Backspace/Delete on a row still clears that dimension, as it did on the old
 * triggers.
 */
export function DataGridTableControls<TData>({
	showSortControl = true,
	table,
}: {
	showSortControl?: boolean | undefined;
	table: Table<TData>;
}) {
	const t = useTranslations("dataGrid");
	const handleRef = useRef<NavPopoverHandle | null>(null);

	const { columnFilters, sorting } = table.getState();

	useDataGridMenuShortcut(FILTER_SHORTCUT_KEY, () =>
		handleRef.current?.toggleAt("filters"),
	);
	useDataGridMenuShortcut(SORT_SHORTCUT_KEY, () => {
		if (showSortControl) {
			handleRef.current?.toggleAt("sort");
		}
	});

	const clearOn = (
		event: KeyboardEvent<HTMLButtonElement>,
		active: boolean,
		reset: () => void,
	) => {
		if (REMOVE_MENU_ITEM_SHORTCUTS.has(event.key.toLowerCase()) && active) {
			event.preventDefault();
			reset();
		}
	};

	const views: NavPopoverView[] = [
		{
			id: "filters",
			render: () => <DataGridFilterPanel table={table} />,
			title: t("filter"),
			widthPx: WIDTH.filters,
		},
		...(showSortControl
			? [
					{
						id: "sort",
						render: () => <DataGridSortPanel table={table} />,
						title: t("sort"),
						widthPx: WIDTH.sort,
					},
				]
			: []),
		{
			id: "rowHeight",
			render: () => <DataGridRowHeightPanel table={table} />,
			title: t("rowHeight"),
			widthPx: WIDTH.rowHeight,
		},
		{
			id: "columns",
			render: () => <DataGridColumnsPanel table={table} />,
			title: t("view"),
			widthPx: WIDTH.columns,
		},
	];

	const activeCount =
		columnFilters.length + (showSortControl ? sorting.length : 0);

	return (
		<NavPopover
			dataSlot="data-grid-table-controls"
			handleRef={handleRef}
			renderRoot={(push) => (
				<NavList ariaLabel={t("tableControls")}>
					<NavRow
						badge={columnFilters.length}
						icon={FilterIcon}
						label={t("filter")}
						onKeyDown={(event) =>
							clearOn(event, columnFilters.length > 0, () =>
								resetDataGridFilters(table),
							)
						}
						onOpen={push}
						viewId="filters"
					/>
					{showSortControl ? (
						<NavRow
							badge={sorting.length}
							icon={ArrowUpDownIcon}
							label={t("sort")}
							onKeyDown={(event) =>
								clearOn(event, sorting.length > 0, () =>
									resetDataGridSorting(table),
								)
							}
							onOpen={push}
							viewId="sort"
						/>
					) : null}
					<NavRow
						icon={RowInsertIcon}
						label={t("rowHeight")}
						onOpen={push}
						value={rowHeightLabel(table.options.meta?.rowHeight)}
						viewId="rowHeight"
					/>
					<NavRow
						icon={Settings02Icon}
						label={t("view")}
						onOpen={push}
						value={columnVisibilitySummary(table)}
						viewId="columns"
					/>
				</NavList>
			)}
			rootTitle={t("tableControls")}
			trigger={(props) => (
				<FilterMenuTriggerButton
					buttonProps={props}
					count={activeCount}
					label={t("tableControls")}
				/>
			)}
			views={views}
			widthPx={WIDTH.root}
		/>
	);
}
