import type { ColumnSort, SortDirection, Table } from "@tanstack/react-table";
import {
	ChevronsUpDown,
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	GripVertical,
	Popover,
	PopoverContent,
	PopoverTrigger,
	REMOVE_MENU_ITEM_SHORTCUTS,
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Sortable,
	SortableContent,
	SortableItem,
	SortableItemHandle,
	Trash2,
	useDirection,
	Button,
} from "@/shared/ui/data-grid/data-grid-menu-common";
import * as React from "react";
import { useTranslations } from "use-intl";
import { cn } from "@/shared/lib/cn";

const SORT_ORDERS = [
	{ label: "Asc", value: "asc" },
	{ label: "Desc", value: "desc" },
];

/** Reset a grid's sorting back to its initial state — see
 *  {@link import("./data-grid-filter-menu").resetDataGridFilters}. */
export function resetDataGridSorting<TData>(table: Table<TData>): void {
	table.setSorting(table.initialState.sorting);
}

/**
 * The sort-builder view of the shared table-controls popover: a reorderable
 * list of "<field> <asc|desc>" rules, plus add/reset. The surrounding popover
 * and badge now live in `DataGridTableControls`.
 */
export function DataGridSortPanel<TData>({ table }: { table: Table<TData> }) {
	const t = useTranslations("dataGrid");
	const dir = useDirection();
	const id = React.useId();
	const labelId = React.useId();
	const descriptionId = React.useId();

	const sorting = table.getState().sorting;
	const onSortingChange = table.setSorting;

	const { columnLabels, columns } = (() => {
		const labels = new Map<string, string>();
		const sortingIds = new Set(sorting.map((s) => s.id));
		const availableColumns: { id: string; label: string }[] = [];

		for (const column of table.getAllColumns()) {
			if (!column.getCanSort()) {
				continue;
			}

			const label = column.columnDef.meta?.label ?? column.id;
			labels.set(column.id, label);

			if (!sortingIds.has(column.id)) {
				availableColumns.push({ id: column.id, label });
			}
		}

		return {
			columnLabels: labels,
			columns: availableColumns,
		};
	})();

	const onSortAdd = () => {
		const firstColumn = columns[0];
		if (!firstColumn) {
			return;
		}

		onSortingChange((prevSorting) => [
			...prevSorting,
			{ id: firstColumn.id, desc: false },
		]);
	};

	const onSortUpdate = (sortId: string, updates: Partial<ColumnSort>) => {
		onSortingChange((prevSorting) => {
			if (!prevSorting) {
				return prevSorting;
			}
			return prevSorting.map((sort) =>
				sort.id === sortId ? { ...sort, ...updates } : sort,
			);
		});
	};

	const onSortRemove = (sortId: string) => {
		onSortingChange((prevSorting) =>
			prevSorting.filter((item) => item.id !== sortId),
		);
	};

	const onSortingReset = () => resetDataGridSorting(table);

	return (
		// dnd-kit's context wraps only the rule list now that the popover is
		// hoisted out — every draggable item is still inside it.
		<Sortable
			value={sorting}
			onValueChange={onSortingChange}
			getItemValue={(item) => item.id}
		>
			<div
				aria-describedby={descriptionId}
				aria-labelledby={labelId}
				className="flex flex-col gap-3.5 p-3 pt-1"
				dir={dir}
			>
				<div className="flex flex-col gap-1">
					<h4 className="font-medium leading-none" id={labelId}>
						{sorting.length > 0 ? t("sortByTitle") : t("noSortsTitle")}
					</h4>
					<p
						className={cn(
							"text-muted-foreground text-sm",
							sorting.length > 0 && "sr-only",
						)}
						id={descriptionId}
					>
						{sorting.length > 0 ? t("modifySortingHint") : t("addSortingHint")}
					</p>
				</div>
				{sorting.length > 0 && (
					<SortableContent asChild>
						<ul className="flex max-h-[300px] flex-col gap-2 overflow-y-auto p-1">
							{sorting.map((sort) => (
								<DataTableSortItem
									key={sort.id}
									sort={sort}
									sortItemId={`${id}-sort-${sort.id}`}
									dir={dir}
									columns={columns}
									columnLabels={columnLabels}
									onSortUpdate={onSortUpdate}
									onSortRemove={onSortRemove}
								/>
							))}
						</ul>
					</SortableContent>
				)}
				<div className="flex w-full items-center gap-2">
					<Button
						className="rounded"
						data-nav-initial-focus
						disabled={columns.length === 0}
						onClick={onSortAdd}
					>
						{t("addSort")}
					</Button>
					{sorting.length > 0 && (
						<Button
							className="rounded"
							onClick={onSortingReset}
							variant="outline"
						>
							{t("resetSorting")}
						</Button>
					)}
				</div>
			</div>
		</Sortable>
	);
}

interface DataTableSortItemProps {
	sort: ColumnSort;
	sortItemId: string;
	dir: "ltr" | "rtl";
	columns: { id: string; label: string }[];
	columnLabels: Map<string, string>;
	onSortUpdate: (sortId: string, updates: Partial<ColumnSort>) => void;
	onSortRemove: (sortId: string) => void;
}

function DataTableSortItem({
	sort,
	sortItemId,
	dir,
	columns,
	columnLabels,
	onSortUpdate,
	onSortRemove,
}: DataTableSortItemProps) {
	const t = useTranslations("dataGrid");
	const fieldListboxId = `${sortItemId}-field-listbox`;
	const fieldTriggerId = `${sortItemId}-field-trigger`;
	const directionListboxId = `${sortItemId}-direction-listbox`;

	const [showFieldSelector, setShowFieldSelector] = React.useState(false);
	const [showDirectionSelector, setShowDirectionSelector] =
		React.useState(false);

	const onItemKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (
			event.target instanceof HTMLInputElement ||
			event.target instanceof HTMLTextAreaElement
		) {
			return;
		}

		if (showFieldSelector || showDirectionSelector) {
			return;
		}

		if (REMOVE_MENU_ITEM_SHORTCUTS.has(event.key.toLowerCase())) {
			event.preventDefault();
			onSortRemove(sort.id);
		}
	};

	return (
		// The rule row itself is the card that lifts (there is no drag overlay):
		// while held it gets an opaque plate two steps above the popover's
		// `bg-surface-5` and a shadow to match — see `SortableItem`.
		<SortableItem
			asChild
			className="rounded-md data-dragging:bg-surface-7 data-dragging:shadow-surface-8"
			value={sort.id}
		>
			<div
				id={sortItemId}
				// eslint-disable-next-line react-doctor/prefer-tag-over-role -- element is interactive (tabIndex + onKeyDown); the ARIA role is correct, a semantic <li> tag would be non-interactive
				role="listitem"
				tabIndex={-1}
				className="flex items-center gap-2"
				onKeyDown={onItemKeyDown}
			>
				<Popover open={showFieldSelector} onOpenChange={setShowFieldSelector}>
					<PopoverTrigger asChild>
						<Button
							id={fieldTriggerId}
							aria-controls={fieldListboxId}
							variant="outline"
							className="w-44 justify-between rounded font-normal"
						>
							<span className="truncate">{columnLabels.get(sort.id)}</span>
							<ChevronsUpDown className="opacity-50" />
						</Button>
					</PopoverTrigger>
					<PopoverContent
						id={fieldListboxId}
						dir={dir}
						className="w-(--radix-popover-trigger-width) p-0"
					>
						<Command>
							<CommandInput placeholder="Search fields..." />
							<CommandList>
								<CommandEmpty>{t("noFieldsFound")}</CommandEmpty>
								<CommandGroup>
									{columns.map((column) => (
										<CommandItem
											key={column.id}
											value={column.id}
											onSelect={(value) => onSortUpdate(sort.id, { id: value })}
										>
											<span className="truncate">{column.label}</span>
										</CommandItem>
									))}
								</CommandGroup>
							</CommandList>
						</Command>
					</PopoverContent>
				</Popover>
				<Select
					open={showDirectionSelector}
					onOpenChange={setShowDirectionSelector}
					value={sort.desc ? "desc" : "asc"}
					onValueChange={(value: SortDirection) =>
						onSortUpdate(sort.id, { desc: value === "desc" })
					}
				>
					<SelectTrigger
						aria-controls={directionListboxId}
						className="w-24 rounded"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent
						id={directionListboxId}
						className="min-w-(--radix-select-trigger-width)"
					>
						<SelectGroup>
							{SORT_ORDERS.map((order) => (
								<SelectItem key={order.value} value={order.value}>
									{order.label}
								</SelectItem>
							))}
						</SelectGroup>
					</SelectContent>
				</Select>
				<Button
					aria-controls={sortItemId}
					variant="outline"
					size="icon"
					className="size-8 shrink-0 rounded"
					onClick={() => onSortRemove(sort.id)}
				>
					<Trash2 />
				</Button>
				<SortableItemHandle asChild>
					<Button
						variant="outline"
						size="icon"
						className="size-8 shrink-0 rounded"
					>
						<GripVertical />
					</Button>
				</SortableItemHandle>
			</div>
		</SortableItem>
	);
}
