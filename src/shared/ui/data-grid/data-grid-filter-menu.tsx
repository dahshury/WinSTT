import type { Column, ColumnFilter, Table } from "@tanstack/react-table";
import {
	Check,
	ChevronsUpDown,
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	GripVertical,
	ListFilter,
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
import {
	type DataGridFilterInputVariantProps,
	DataGridDateFilterInput,
	DataGridNumberFilterInput,
	DataGridSelectFilterInput,
	DataGridTextFilterInput,
} from "@/shared/ui/data-grid/data-grid-filter-inputs";
import {
	getDefaultOperator,
	getOperatorsForVariant,
} from "@/shared/ui/data-grid/lib/data-grid-filters";
import { cn } from "@/shared/lib/cn";
import type { FilterOperator, FilterValue } from "@/shared/ui/data-grid/types";

const FILTER_SHORTCUT_KEY = "f";
const OPERATORS_WITHOUT_VALUE = new Set([
	"isEmpty",
	"isNotEmpty",
	"isTrue",
	"isFalse",
]);

interface DataGridFilterMenuProps<TData> extends React.ComponentProps<
	typeof PopoverContent
> {
	table: Table<TData>;
	disabled?: boolean;
}

export function DataGridFilterMenu<TData>({
	table,
	disabled,
	className,
	...props
}: DataGridFilterMenuProps<TData>) {
	const t = useTranslations("dataGrid");
	const dir = useDirection();
	const id = React.useId();
	const labelId = React.useId();
	const descriptionId = React.useId();
	const [open, setOpen] = React.useState(false);
	const addButtonRef = React.useRef<HTMLButtonElement>(null);

	const columnFilters = table.getState().columnFilters;

	const { columnLabels, columns, columnVariants } = (() => {
		const labels = new Map<string, string>();
		const variants = new Map<string, string>();
		const filteringIds = new Set(columnFilters.map((f) => f.id));
		const availableColumns: { id: string; label: string }[] = [];

		for (const column of table.getAllColumns()) {
			if (!column.getCanFilter()) continue;

			const label = column.columnDef.meta?.label ?? column.id;
			const variant = column.columnDef.meta?.cell?.variant ?? "short-text";

			labels.set(column.id, label);
			variants.set(column.id, variant);

			if (!filteringIds.has(column.id)) {
				availableColumns.push({ id: column.id, label });
			}
		}

		return {
			columnLabels: labels,
			columns: availableColumns,
			columnVariants: variants,
		};
	})();

	const onFilterAdd = () => {
		const firstColumn = columns[0];
		if (!firstColumn) return;

		const variant = columnVariants.get(firstColumn.id) ?? "short-text";
		const defaultOperator = getDefaultOperator(variant);

		table.setColumnFilters((prevFilters) => [
			...prevFilters,
			{
				id: firstColumn.id,
				value: {
					operator: defaultOperator,
					value: "",
				},
			},
		]);
	};

	const onFilterUpdate = (filterId: string, updates: Partial<ColumnFilter>) => {
		table.setColumnFilters((prevFilters) => {
			if (!prevFilters) return prevFilters;
			return prevFilters.map((filter) =>
				filter.id === filterId ? { ...filter, ...updates } : filter,
			);
		});
	};

	const onFilterRemove = (filterId: string) => {
		table.setColumnFilters((prevFilters) =>
			prevFilters.filter((item) => item.id !== filterId),
		);
	};

	const onFiltersReset = () => {
		table.setColumnFilters(table.initialState.columnFilters ?? []);
	};

	useDataGridMenuShortcut(FILTER_SHORTCUT_KEY, setOpen);

	const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
		if (
			REMOVE_MENU_ITEM_SHORTCUTS.has(event.key.toLowerCase()) &&
			columnFilters.length > 0
		) {
			event.preventDefault();
			onFiltersReset();
		}
	};

	return (
		<Sortable
			value={columnFilters}
			onValueChange={table.setColumnFilters}
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
						<ListFilter className="text-muted-foreground" />
						{t("filter")}
						{columnFilters.length > 0 && (
							<Badge
								variant="secondary"
								className="h-[18.24px] rounded-[3.2px] px-[5.12px] font-mono font-normal text-[10.4px]"
							>
								{columnFilters.length}
							</Badge>
						)}
					</Button>
				</PopoverTrigger>
				<PopoverContent
					aria-labelledby={labelId}
					aria-describedby={descriptionId}
					dir={dir}
					className={cn(
						"flex w-full max-w-(--radix-popover-content-available-width) flex-col gap-3.5 p-4 sm:min-w-[480px]",
						className,
					)}
					{...props}
				>
					<div className="flex flex-col gap-1">
						<h4 id={labelId} className="font-medium leading-none">
							{columnFilters.length > 0
								? t("filterByTitle")
								: t("noFiltersTitle")}
						</h4>
						<p
							id={descriptionId}
							className={cn(
								"text-muted-foreground text-sm",
								columnFilters.length > 0 && "sr-only",
							)}
						>
							{columnFilters.length > 0
								? t("modifyFiltersHint")
								: t("addFiltersHint")}
						</p>
					</div>
					{columnFilters.length > 0 && (
						<SortableContent asChild>
							<div
								// eslint-disable-next-line react-doctor/prefer-tag-over-role -- list container for SortableContent (dnd-kit asChild); its items are interactive role="listitem" divs, so the matching role="list" is correct here
								role="list"
								className="flex max-h-[400px] flex-col gap-2 overflow-y-auto p-1"
							>
								{columnFilters.map((filter, index) => (
									<DataGridFilterItem
										key={filter.id}
										filter={filter}
										index={index}
										filterItemId={`${id}-filter-${filter.id}`}
										dir={dir}
										columns={columns}
										columnLabels={columnLabels}
										columnVariants={columnVariants}
										table={table}
										onFilterUpdate={onFilterUpdate}
										onFilterRemove={onFilterRemove}
									/>
								))}
							</div>
						</SortableContent>
					)}
					<div className="flex w-full items-center gap-2">
						<Button
							className="rounded"
							ref={addButtonRef}
							onClick={onFilterAdd}
							disabled={columns.length === 0}
						>
							{t("addFilter")}
						</Button>
						{columnFilters.length > 0 && (
							<Button
								variant="outline"
								className="rounded"
								onClick={onFiltersReset}
							>
								{t("resetFilters")}
							</Button>
						)}
					</div>
				</PopoverContent>
			</Popover>
			<SortableOverlay>
				<div dir={dir} className="flex items-center gap-2">
					<div className="h-8 min-w-[72px] rounded-sm bg-primary/10" />
					<div className="h-8 w-32 rounded-sm bg-primary/10" />
					<div className="h-8 w-32 rounded-sm bg-primary/10" />
					<div className="h-8 w-36 rounded-sm bg-primary/10" />
					<div className="size-8 shrink-0 rounded-sm bg-primary/10" />
					<div className="size-8 shrink-0 rounded-sm bg-primary/10" />
				</div>
			</SortableOverlay>
		</Sortable>
	);
}

interface DataGridFilterItemProps<TData> {
	filter: ColumnFilter;
	index: number;
	filterItemId: string;
	dir: "ltr" | "rtl";
	columns: { id: string; label: string }[];
	columnLabels: Map<string, string>;
	columnVariants: Map<string, string>;
	table: Table<TData>;
	onFilterUpdate: (filterId: string, updates: Partial<ColumnFilter>) => void;
	onFilterRemove: (filterId: string) => void;
}

function DataGridFilterItem<TData>({
	filter,
	index,
	filterItemId,
	dir,
	columns,
	columnLabels,
	columnVariants,
	table,
	onFilterUpdate,
	onFilterRemove,
}: DataGridFilterItemProps<TData>) {
	const t = useTranslations("dataGrid");
	const fieldListboxId = `${filterItemId}-field-listbox`;
	const fieldTriggerId = `${filterItemId}-field-trigger`;
	const operatorListboxId = `${filterItemId}-operator-listbox`;
	const inputId = `${filterItemId}-input`;

	const [showFieldSelector, setShowFieldSelector] = React.useState(false);
	const [showOperatorSelector, setShowOperatorSelector] = React.useState(false);

	const variant = columnVariants.get(filter.id) ?? "short-text";
	const filterValue = filter.value as FilterValue | undefined;
	const operator = filterValue?.operator ?? getDefaultOperator(variant);

	const operators = getOperatorsForVariant(variant);
	const needsValue = !OPERATORS_WITHOUT_VALUE.has(operator);

	const column = table.getColumn(filter.id);

	const onItemKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (
			event.target instanceof HTMLInputElement ||
			event.target instanceof HTMLTextAreaElement
		) {
			return;
		}

		if (showFieldSelector || showOperatorSelector) {
			return;
		}

		if (REMOVE_MENU_ITEM_SHORTCUTS.has(event.key.toLowerCase())) {
			event.preventDefault();
			onFilterRemove(filter.id);
		}
	};

	const onOperatorChange = (newOperator: FilterOperator) => {
		onFilterUpdate(filter.id, {
			value: {
				operator: newOperator,
				value: filterValue?.value,
				endValue: filterValue?.endValue,
			},
		});
	};

	const onValueChange = (newValue: string | number | string[] | undefined) => {
		onFilterUpdate(filter.id, {
			value: {
				operator,
				value: newValue,
				endValue: filterValue?.endValue,
			},
		});
	};

	const onEndValueChange = (
		newValue: string | number | string[] | undefined,
	) => {
		onFilterUpdate(filter.id, {
			value: {
				operator,
				value: filterValue?.value,
				endValue: newValue as string | number | undefined,
			},
		});
	};

	return (
		<SortableItem value={filter.id} asChild>
			<div
				// eslint-disable-next-line react-doctor/prefer-tag-over-role -- element is interactive (onKeyDown/tabIndex); the ARIA role is correct, a semantic <li> tag would be non-interactive
				role="listitem"
				id={filterItemId}
				tabIndex={-1}
				className="flex items-center gap-2"
				onKeyDown={onItemKeyDown}
			>
				<div className="min-w-[72px] text-center">
					{index === 0 ? (
						<span className="text-muted-foreground text-sm">{t("where")}</span>
					) : (
						<span className="text-muted-foreground text-sm">{t("and")}</span>
					)}
				</div>
				<Popover open={showFieldSelector} onOpenChange={setShowFieldSelector}>
					<PopoverTrigger asChild>
						<Button
							id={fieldTriggerId}
							aria-controls={fieldListboxId}
							dir={dir}
							variant="outline"
							className="w-32 justify-between rounded font-normal"
						>
							<span className="truncate">{columnLabels.get(filter.id)}</span>
							<ChevronsUpDown className="opacity-50" />
						</Button>
					</PopoverTrigger>
					<PopoverContent
						id={fieldListboxId}
						dir={dir}
						align="start"
						className="w-40 p-0"
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
											onSelect={(value) => {
												const newVariant =
													columnVariants.get(value) ?? "short-text";
												const newOperator = getDefaultOperator(newVariant);

												table.setColumnFilters((prevFilters) =>
													prevFilters.map((f) =>
														f.id === filter.id
															? {
																	id: value,
																	value: {
																		operator: newOperator,
																		value: "",
																	},
																}
															: f,
													),
												);
												setShowFieldSelector(false);
											}}
										>
											<span className="truncate">{column.label}</span>
											<Check
												className={cn(
													"ms-auto",
													column.id === filter.id ? "opacity-100" : "opacity-0",
												)}
											/>
										</CommandItem>
									))}
								</CommandGroup>
							</CommandList>
						</Command>
					</PopoverContent>
				</Popover>
				<Select
					open={showOperatorSelector}
					onOpenChange={setShowOperatorSelector}
					value={operator}
					onValueChange={onOperatorChange}
				>
					<SelectTrigger
						aria-controls={operatorListboxId}
						className="w-32 rounded lowercase"
					>
						<div className="truncate">
							<SelectValue />
						</div>
					</SelectTrigger>
					<SelectContent id={operatorListboxId}>
						<SelectGroup>
							{operators.map((op) => (
								<SelectItem
									key={op.value}
									value={op.value}
									className="lowercase"
								>
									{op.label}
								</SelectItem>
							))}
						</SelectGroup>
					</SelectContent>
				</Select>
				<div className="min-w-36 max-w-60 flex-1">
					{needsValue && column ? (
						<DataGridFilterInput
							key={filter.id}
							variant={variant}
							operator={operator}
							column={column}
							inputId={inputId}
							dir={dir}
							value={filterValue?.value}
							endValue={filterValue?.endValue}
							onValueChange={onValueChange}
							onEndValueChange={onEndValueChange}
						/>
					) : (
						<div
							id={inputId}
							// eslint-disable-next-line react-doctor/prefer-tag-over-role -- <output> renders inline by default and would break the fixed h-8 w-full block placeholder box layout
							role="status"
							aria-label={`${columnLabels.get(filter.id)} filter is empty`}
							aria-live="polite"
							className="h-8 w-full rounded border border-border bg-surface-6/40"
						/>
					)}
				</div>
				<Button
					aria-controls={filterItemId}
					variant="outline"
					size="icon"
					className="size-8 rounded"
					onClick={() => onFilterRemove(filter.id)}
				>
					<Trash2 />
				</Button>
				<SortableItemHandle asChild>
					<Button variant="outline" size="icon" className="size-8 rounded">
						<GripVertical />
					</Button>
				</SortableItemHandle>
			</div>
		</SortableItem>
	);
}

interface DataGridFilterInputProps<TData> {
	variant: string;
	operator: FilterOperator;
	dir: "ltr" | "rtl";
	placeholder?: string | undefined;
	value: string | number | string[] | undefined;
	endValue?: string | number | undefined;
	column: Column<TData>;
	inputId: string;
	onValueChange: (value: string | number | string[] | undefined) => void;
	onEndValueChange?:
		| ((value: string | number | string[] | undefined) => void)
		| undefined;
}

function DataGridFilterInput<TData>({
	variant,
	operator,
	dir,
	placeholder = "Value",
	value,
	endValue,
	column,
	inputId,
	onValueChange,
	onEndValueChange,
}: DataGridFilterInputProps<TData>) {
	const variantProps: DataGridFilterInputVariantProps<TData> = {
		operator,
		dir,
		placeholder,
		value,
		endValue,
		column,
		inputId,
		onValueChange,
		onEndValueChange,
	};

	if (variant === "number") {
		return <DataGridNumberFilterInput {...variantProps} />;
	}

	if (variant === "date") {
		return <DataGridDateFilterInput {...variantProps} />;
	}

	const isSelectVariant = variant === "select" || variant === "multi-select";
	const cellVariant = column.columnDef.meta?.cell;
	const hasSelectOptions =
		(cellVariant?.variant === "select" ||
			cellVariant?.variant === "multi-select") &&
		cellVariant.options.length > 0;

	if (isSelectVariant && hasSelectOptions) {
		return <DataGridSelectFilterInput {...variantProps} />;
	}

	return <DataGridTextFilterInput {...variantProps} />;
}
