import type { ColumnSort, SortDirection, Table } from "@tanstack/react-table";
import {
	ArrowDownUp,
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
	SortableOverlay,
	Trash2,
	useDataGridMenuShortcut,
	useDirection,
	Badge,
	Button,
} from "@/shared/ui/data-grid/data-grid-menu-common";
import * as React from "react";
import { useTranslations } from "use-intl";
import { cn } from "@/shared/lib/cn";

const SORT_SHORTCUT_KEY = "s";
const SORT_ORDERS = [
	{ label: "Asc", value: "asc" },
	{ label: "Desc", value: "desc" },
];

interface DataGridSortMenuProps<TData> extends React.ComponentProps<
	typeof PopoverContent
> {
	table: Table<TData>;
	disabled?: boolean;
}

export function DataGridSortMenu<TData>({
	table,
	disabled,
	className,
	...props
}: DataGridSortMenuProps<TData>) {
	const t = useTranslations("dataGrid");
	const dir = useDirection();
	const id = React.useId();
	const labelId = React.useId();
	const descriptionId = React.useId();
	const [open, setOpen] = React.useState(false);
	const addButtonRef = React.useRef<HTMLButtonElement>(null);

	const sorting = table.getState().sorting;
	const onSortingChange = table.setSorting;

	const { columnLabels, columns } = (() => {
		const labels = new Map<string, string>();
		const sortingIds = new Set(sorting.map((s) => s.id));
		const availableColumns: { id: string; label: string }[] = [];

		for (const column of table.getAllColumns()) {
			if (!column.getCanSort()) continue;

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
		if (!firstColumn) return;

		onSortingChange((prevSorting) => [
			...prevSorting,
			{ id: firstColumn.id, desc: false },
		]);
	};

	const onSortUpdate = (sortId: string, updates: Partial<ColumnSort>) => {
		onSortingChange((prevSorting) => {
			if (!prevSorting) return prevSorting;
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

	const onSortingReset = () => onSortingChange(table.initialState.sorting);

	useDataGridMenuShortcut(SORT_SHORTCUT_KEY, setOpen);

	const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
		if (
			REMOVE_MENU_ITEM_SHORTCUTS.has(event.key.toLowerCase()) &&
			sorting.length > 0
		) {
			event.preventDefault();
			onSortingReset();
		}
	};

	return (
		<Sortable
			value={sorting}
			onValueChange={onSortingChange}
			getItemValue={(item) => item.id}
		>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<Button
						dir={dir}
						variant="outline"
						className="font-normal"
						onKeyDown={onTriggerKeyDown}
						disabled={disabled}
					>
						<ArrowDownUp className="text-muted-foreground" />
						{t("sort")}
						{sorting.length > 0 && (
							<Badge
								variant="secondary"
								className="h-[18.24px] rounded-[3.2px] px-[5.12px] font-mono font-normal text-[10.4px]"
							>
								{sorting.length}
							</Badge>
						)}
					</Button>
				</PopoverTrigger>
				<PopoverContent
					aria-labelledby={labelId}
					aria-describedby={descriptionId}
					dir={dir}
					className={cn(
						"flex w-full max-w-(--radix-popover-content-available-width) flex-col gap-3.5 p-4 sm:min-w-[380px]",
						className,
					)}
					{...props}
				>
					<div className="flex flex-col gap-1">
						<h4 id={labelId} className="font-medium leading-none">
							{sorting.length > 0 ? t("sortByTitle") : t("noSortsTitle")}
						</h4>
						<p
							id={descriptionId}
							className={cn(
								"text-muted-foreground text-sm",
								sorting.length > 0 && "sr-only",
							)}
						>
							{sorting.length > 0
								? t("modifySortingHint")
								: t("addSortingHint")}
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
							ref={addButtonRef}
							onClick={onSortAdd}
							disabled={columns.length === 0}
						>
							{t("addSort")}
						</Button>
						{sorting.length > 0 && (
							<Button
								variant="outline"
								className="rounded"
								onClick={onSortingReset}
							>
								{t("resetSorting")}
							</Button>
						)}
					</div>
				</PopoverContent>
			</Popover>
			<SortableOverlay>
				<div dir={dir} className="flex items-center gap-2">
					<div className="h-8 w-44 rounded-sm bg-primary/10" />
					<div className="h-8 w-24 rounded-sm bg-primary/10" />
					<div className="size-8 shrink-0 rounded-sm bg-primary/10" />
					<div className="size-8 shrink-0 rounded-sm bg-primary/10" />
				</div>
			</SortableOverlay>
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
		<SortableItem value={sort.id} asChild>
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
