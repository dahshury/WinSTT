import type { Column } from "@tanstack/react-table";
import { CalendarIcon, Check } from "@/shared/ui/data-grid/primitives/icons";
import * as React from "react";
import { useTranslations } from "use-intl";
import { Button } from "@/shared/ui/data-grid/primitives/button";
import { Calendar } from "@/shared/ui/data-grid/primitives/calendar";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/shared/ui/data-grid/primitives/command";
import { Input } from "@/shared/ui/data-grid/primitives/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/shared/ui/data-grid/primitives/popover";
import { useDebouncedCallback } from "@/shared/ui/data-grid/model/use-debounced-callback";
import { formatDate } from "@/shared/ui/data-grid/lib/format";
import { cn } from "@/shared/lib/cn";
import type { FilterOperator } from "@/shared/ui/data-grid/types";

const FILTER_DEBOUNCE_MS = 300;

export interface DataGridFilterInputVariantProps<TData> {
	operator: FilterOperator;
	dir: "ltr" | "rtl";
	placeholder: string;
	value: string | number | string[] | undefined;
	endValue?: string | number | undefined;
	column: Column<TData>;
	inputId: string;
	onValueChange: (value: string | number | string[] | undefined) => void;
	onEndValueChange?:
		| ((value: string | number | string[] | undefined) => void)
		| undefined;
}

export function DataGridNumberFilterInput<TData>({
	operator,
	placeholder,
	value,
	endValue,
	inputId,
	onValueChange,
	onEndValueChange,
}: DataGridFilterInputVariantProps<TData>) {
	// eslint-disable-next-line react-doctor/no-derived-useState -- local mirror lets the input update instantly while the parent value prop is only pushed after a debounce; not a derived/synced copy
	const [localValue, setLocalValue] = React.useState(value);
	// eslint-disable-next-line react-doctor/no-derived-useState -- local mirror lets the input update instantly while the parent endValue prop is only pushed after a debounce; not a derived/synced copy
	const [localEndValue, setLocalEndValue] = React.useState(endValue);

	const debouncedOnChange = useDebouncedCallback(
		(newValue: string | number | string[] | undefined) => {
			onValueChange(newValue);
		},
		FILTER_DEBOUNCE_MS,
	);

	const debouncedOnEndValueChange = useDebouncedCallback(
		(newValue: string | number | string[] | undefined) => {
			onEndValueChange?.(newValue);
		},
		FILTER_DEBOUNCE_MS,
	);

	if (operator === "isBetween") {
		return (
			<div className="flex gap-2">
				<Input
					id={inputId}
					type="number"
					inputMode="numeric"
					placeholder="Start"
					value={(localValue as number | undefined) ?? ""}
					onChange={(event) => {
						const val = event.target.value;
						const newValue = val === "" ? undefined : Number(val);
						setLocalValue(newValue);
						debouncedOnChange(newValue);
					}}
					className="h-8 w-full flex-1 rounded"
				/>
				<Input
					id={`${inputId}-end`}
					type="number"
					inputMode="numeric"
					placeholder="End"
					value={(localEndValue as number | undefined) ?? ""}
					onChange={(event) => {
						const val = event.target.value;
						const newValue = val === "" ? undefined : Number(val);
						setLocalEndValue(newValue);
						debouncedOnEndValueChange(newValue);
					}}
					className="h-8 w-full flex-1 rounded"
				/>
			</div>
		);
	}

	return (
		<Input
			id={inputId}
			type="number"
			inputMode="numeric"
			placeholder={placeholder}
			value={(localValue as number | undefined) ?? ""}
			onChange={(event) => {
				const val = event.target.value;
				const newValue = val === "" ? undefined : Number(val);
				setLocalValue(newValue);
				debouncedOnChange(newValue);
			}}
			className="h-8 w-full rounded"
		/>
	);
}

export function DataGridDateFilterInput<TData>({
	operator,
	dir,
	value,
	endValue,
	inputId,
	onValueChange,
	onEndValueChange,
}: DataGridFilterInputVariantProps<TData>) {
	const [showValueSelector, setShowValueSelector] = React.useState(false);
	// eslint-disable-next-line react-doctor/no-derived-useState -- local mirror lets the input update instantly while the parent value prop is only pushed after a debounce; not a derived/synced copy
	const [localValue, setLocalValue] = React.useState(value);
	// eslint-disable-next-line react-doctor/no-derived-useState -- local mirror lets the input update instantly while the parent endValue prop is only pushed after a debounce; not a derived/synced copy
	const [localEndValue, setLocalEndValue] = React.useState(endValue);

	const inputListboxId = `${inputId}-listbox`;

	if (operator === "isBetween") {
		const startDate =
			localValue && typeof localValue === "string"
				? new Date(localValue)
				: undefined;
		const endDate =
			localEndValue && typeof localEndValue === "string"
				? new Date(localEndValue)
				: undefined;

		const isSameDate =
			startDate &&
			endDate &&
			startDate.toDateString() === endDate.toDateString();

		const displayValue =
			startDate && endDate && !isSameDate
				? `${formatDate(startDate, { month: "short" })} - ${formatDate(endDate, { month: "short" })}`
				: startDate
					? formatDate(startDate, { month: "short" })
					: "Pick a range";

		return (
			<Popover open={showValueSelector} onOpenChange={setShowValueSelector}>
				<PopoverTrigger asChild>
					<Button
						id={inputId}
						aria-controls={inputListboxId}
						dir={dir}
						variant="outline"
						className={cn(
							"h-8 w-full justify-start rounded font-normal",
							!startDate && "text-muted-foreground",
						)}
					>
						<CalendarIcon />
						<span className="truncate">{displayValue}</span>
					</Button>
				</PopoverTrigger>
				<PopoverContent
					id={inputListboxId}
					dir={dir}
					align="start"
					className="w-auto p-0"
				>
					<Calendar
						autoFocus
						captionLayout="dropdown"
						mode="range"
						selected={
							startDate && endDate
								? { from: startDate, to: endDate }
								: startDate
									? { from: startDate, to: startDate }
									: undefined
						}
						onSelect={(rangeValue) => {
							const range = rangeValue as
								| { from?: Date; to?: Date }
								| undefined;
							const fromValue = range?.from
								? range.from.toISOString()
								: undefined;
							const toValue = range?.to ? range.to.toISOString() : undefined;
							setLocalValue(fromValue);
							setLocalEndValue(toValue);
							onValueChange(fromValue);
							onEndValueChange?.(toValue);
						}}
					/>
				</PopoverContent>
			</Popover>
		);
	}

	const dateValue =
		localValue && typeof localValue === "string"
			? new Date(localValue)
			: undefined;

	return (
		<Popover open={showValueSelector} onOpenChange={setShowValueSelector}>
			<PopoverTrigger asChild>
				<Button
					id={inputId}
					aria-controls={inputListboxId}
					dir={dir}
					variant="outline"
					className={cn(
						"h-8 w-full justify-start rounded font-normal",
						!dateValue && "text-muted-foreground",
					)}
				>
					<CalendarIcon />
					<span className="truncate">
						{dateValue
							? formatDate(dateValue, { month: "short" })
							: "Pick a date"}
					</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent
				id={inputListboxId}
				dir={dir}
				align="start"
				className="w-auto p-0"
			>
				<Calendar
					autoFocus
					captionLayout="dropdown"
					mode="single"
					selected={dateValue}
					onSelect={(selectValue) => {
						const date = selectValue as Date | undefined;
						const newValue = date ? date.toISOString() : undefined;
						setLocalValue(newValue);
						onValueChange(newValue);
						setShowValueSelector(false);
					}}
				/>
			</PopoverContent>
		</Popover>
	);
}

export function DataGridSelectFilterInput<TData>({
	operator,
	dir,
	placeholder,
	value,
	column,
	inputId,
	onValueChange,
}: DataGridFilterInputVariantProps<TData>) {
	const t = useTranslations("dataGrid");
	const [showValueSelector, setShowValueSelector] = React.useState(false);

	const cellVariant = column.columnDef.meta?.cell;
	const selectOptions =
		cellVariant?.variant === "select" || cellVariant?.variant === "multi-select"
			? cellVariant.options
			: [];

	const inputListboxId = `${inputId}-listbox`;
	const isMultiValueOperator =
		operator === "isAnyOf" || operator === "isNoneOf";

	if (isMultiValueOperator) {
		const selectedValues = Array.isArray(value) ? value : [];
		const selectedOptions = selectOptions.filter((option) =>
			selectedValues.includes(option.value),
		);

		const selectedOptionsWithIcons = selectedOptions.filter(
			(selectedOption) => selectedOption.icon,
		);

		return (
			<Popover open={showValueSelector} onOpenChange={setShowValueSelector}>
				<PopoverTrigger asChild>
					<Button
						id={inputId}
						aria-controls={inputListboxId}
						dir={dir}
						variant="outline"
						className="h-8 w-full justify-start rounded font-normal"
					>
						{selectedOptions.length === 0 ? (
							<span className="text-muted-foreground">{placeholder}</span>
						) : (
							<>
								{selectedOptionsWithIcons.length > 0 && (
									<div className="flex items-center -space-x-2 rtl:space-x-reverse">
										{selectedOptionsWithIcons.map(
											(selectedOption) =>
												selectedOption.icon && (
													<div
														key={selectedOption.value}
														className="rounded-full border border-border bg-surface-6 p-0.5"
													>
														<selectedOption.icon className="size-3.5" />
													</div>
												),
										)}
									</div>
								)}
								<span className="truncate">
									{selectedOptions.length > 1
										? `${selectedOptions.length} selected`
										: selectedOptions[0]?.label}
								</span>
							</>
						)}
					</Button>
				</PopoverTrigger>
				<PopoverContent
					id={inputListboxId}
					dir={dir}
					align="start"
					className="w-48 p-0"
				>
					<Command>
						<CommandInput placeholder="Search options..." />
						<CommandList>
							<CommandEmpty>{t("noOptionsFound")}</CommandEmpty>
							<CommandGroup>
								{selectOptions.map((option) => {
									const isSelected = selectedValues.includes(option.value);
									return (
										<CommandItem
											key={option.value}
											value={option.value}
											onSelect={() => {
												const newValues = isSelected
													? selectedValues.filter((v) => v !== option.value)
													: [...selectedValues, option.value];
												onValueChange(
													newValues.length > 0 ? newValues : undefined,
												);
											}}
										>
											{option.icon && <option.icon />}
											<span className="truncate">{option.label}</span>
											{option.count && (
												<span className="ms-auto font-mono text-xs">
													{option.count}
												</span>
											)}
											<Check
												className={cn(
													"ms-auto",
													isSelected ? "opacity-100" : "opacity-0",
												)}
											/>
										</CommandItem>
									);
								})}
							</CommandGroup>
						</CommandList>
					</Command>
				</PopoverContent>
			</Popover>
		);
	}

	const selectedOption = selectOptions.find(
		(opt) => opt.value === (value as string),
	);

	return (
		<Popover open={showValueSelector} onOpenChange={setShowValueSelector}>
			<PopoverTrigger asChild>
				<Button
					id={inputId}
					aria-controls={inputListboxId}
					dir={dir}
					variant="outline"
					className="h-8 w-full justify-start rounded font-normal"
				>
					{selectedOption ? (
						<>
							{selectedOption.icon && <selectedOption.icon />}
							<span className="truncate">{selectedOption.label}</span>
						</>
					) : (
						<span className="text-muted-foreground">{placeholder}</span>
					)}
				</Button>
			</PopoverTrigger>
			<PopoverContent
				id={inputListboxId}
				dir={dir}
				align="start"
				className="w-[200px] p-0"
			>
				<Command>
					<CommandInput placeholder="Search options..." />
					<CommandList>
						<CommandEmpty>{t("noOptionsFound")}</CommandEmpty>
						<CommandGroup>
							{selectOptions.map((option) => (
								<CommandItem
									key={option.value}
									value={option.value}
									onSelect={() => {
										onValueChange(option.value);
										setShowValueSelector(false);
									}}
								>
									{option.icon && <option.icon />}
									<span className="truncate">{option.label}</span>
									{option.count && (
										<span className="ms-auto font-mono text-xs">
											{option.count}
										</span>
									)}
									<Check
										className={cn(
											"ms-auto",
											value === option.value ? "opacity-100" : "opacity-0",
										)}
									/>
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

export function DataGridTextFilterInput<TData>({
	operator,
	placeholder,
	value,
	endValue,
	inputId,
	onValueChange,
	onEndValueChange,
}: DataGridFilterInputVariantProps<TData>) {
	// eslint-disable-next-line react-doctor/no-derived-useState -- local mirror lets the input update instantly while the parent value prop is only pushed after a debounce; not a derived/synced copy
	const [localValue, setLocalValue] = React.useState(value);
	// eslint-disable-next-line react-doctor/no-derived-useState -- local mirror lets the input update instantly while the parent endValue prop is only pushed after a debounce; not a derived/synced copy
	const [localEndValue, setLocalEndValue] = React.useState(endValue);

	const debouncedOnChange = useDebouncedCallback(
		(newValue: string | number | string[] | undefined) => {
			onValueChange(newValue);
		},
		FILTER_DEBOUNCE_MS,
	);

	const debouncedOnEndValueChange = useDebouncedCallback(
		(newValue: string | number | string[] | undefined) => {
			onEndValueChange?.(newValue);
		},
		FILTER_DEBOUNCE_MS,
	);

	if (operator === "isBetween") {
		return (
			<div className="flex gap-2">
				<Input
					id={inputId}
					type="text"
					placeholder="Start"
					className="h-8 w-full flex-1 rounded"
					value={(localValue as string | undefined) ?? ""}
					onChange={(event) => {
						const val = event.target.value;
						const newValue = val === "" ? undefined : val;
						setLocalValue(newValue);
						debouncedOnChange(newValue);
					}}
				/>
				<Input
					id={`${inputId}-end`}
					type="text"
					placeholder="End"
					className="h-8 w-full flex-1 rounded"
					value={(localEndValue as string | undefined) ?? ""}
					onChange={(event) => {
						const val = event.target.value;
						const newValue = val === "" ? undefined : val;
						setLocalEndValue(newValue);
						debouncedOnEndValueChange(newValue);
					}}
				/>
			</div>
		);
	}

	return (
		<Input
			id={inputId}
			type="text"
			placeholder={placeholder}
			className="h-8 w-full rounded"
			value={(localValue as string | undefined) ?? ""}
			onChange={(event) => {
				const val = event.target.value;
				const newValue = val === "" ? undefined : val;
				setLocalValue(newValue);
				debouncedOnChange(newValue);
			}}
		/>
	);
}
