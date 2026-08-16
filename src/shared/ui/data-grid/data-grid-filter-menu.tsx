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

const OPERATORS_WITHOUT_VALUE = new Set([
	"isEmpty",
	"isNotEmpty",
	"isTrue",
	"isFalse",
]);

/** Reset a grid's filters back to its initial state. Shared with the table
 *  controls, whose "Filters" row clears the dimension with Backspace/Delete —
 *  the affordance the standalone menu's trigger used to carry. */
export function resetDataGridFilters<TData>(table: Table<TData>): void {
	table.setColumnFilters(table.initialState.columnFilters ?? []);
}

/**
 * The filter-builder view of the shared table-controls popover: a reorderable
 * list of "where <field> <operator> <value>" rules, plus add/reset. Previously
 * this was its own popover with its own trigger; the surrounding popover and
 * badge now live in `DataGridTableControls`.
 */
export function DataGridFilterPanel<TData>({ table }: { table: Table<TData> }) {
	const t = useTranslations("dataGrid");
	const dir = useDirection();
	const id = React.useId();
	const labelId = React.useId();
	const descriptionId = React.useId();

	const columnFilters = table.getState().columnFilters;

	const { columnLabels, columns, columnVariants } = (() => {
		const labels = new Map<string, string>();
		const variants = new Map<string, string>();
		const filteringIds = new Set(columnFilters.map((f) => f.id));
		const availableColumns: { id: string; label: string }[] = [];

		for (const column of table.getAllColumns()) {
			if (!column.getCanFilter()) {
				continue;
			}

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
		if (!firstColumn) {
			return;
		}

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
			if (!prevFilters) {
				return prevFilters;
			}
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

	const onFiltersReset = () => resetDataGridFilters(table);

	return (
		// dnd-kit's context wraps only the rule list now that the popover is
		// hoisted out — every draggable item is still inside it.
		<Sortable
			value={columnFilters}
			onValueChange={table.setColumnFilters}
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
						{columnFilters.length > 0
							? t("filterByTitle")
							: t("noFiltersTitle")}
					</h4>
					<p
						className={cn(
							"text-muted-foreground text-sm",
							columnFilters.length > 0 && "sr-only",
						)}
						id={descriptionId}
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
						data-nav-initial-focus
						disabled={columns.length === 0}
						onClick={onFilterAdd}
					>
						{t("addFilter")}
					</Button>
					{columnFilters.length > 0 && (
						<Button
							className="rounded"
							onClick={onFiltersReset}
							variant="outline"
						>
							{t("resetFilters")}
						</Button>
					)}
				</div>
			</div>
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
		// Same lift as the sort rules: the row is the card, plated two steps
		// above the popover's `bg-surface-5` while it is held.
		<SortableItem
			asChild
			className="rounded-md data-dragging:bg-surface-7 data-dragging:shadow-surface-8"
			value={filter.id}
		>
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
