import { Button as BaseButton } from "@base-ui/react/button";
import { Input } from "@base-ui/react/input";
import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ChangeEvent, type ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, surfaceClasses, useSurface } from "@/shared/lib/surface";
import { Tooltip } from "@/shared/ui/tooltip";
import type { CalendarSystem } from "./calendar-system";
import {
	computeDayState,
	formatTimeInput,
	getCalendarGrid,
	type HeaderSegment,
	isDateValue,
	isRangeValue,
	isSameDay,
	NAV_BUTTON_CLASS,
	parseTimeInput,
	setTimePartOf,
	startOfDay,
	STATE_CLASSES,
	WEEKDAY_LABELS_MON,
	WEEKDAY_LABELS_SUN,
} from "./calendar-grid";
import type {
	CalendarMode,
	CalendarPreset,
	DateRange,
	DayState,
} from "./types";

interface MonthGridProps {
	caption?: string | undefined;
	classMap: Map<number, string>;
	fillWidth: boolean;
	formatTooltip?: ((date: Date, weight?: number) => string) | undefined;
	hovered: Date | null;
	isDisabled?: ((date: Date) => boolean) | undefined;
	mode: CalendarMode;
	monthDate: Date;
	onDayClick: (date: Date) => void;
	onDayHover: (date: Date | null) => void;
	renderDayBadge?: ((date: Date, weight?: number) => ReactNode) | undefined;
	selected: Date | DateRange | null;
	showOutsideDays: boolean;
	system: CalendarSystem;
	today: Date;
	weekStartsOn: 0 | 1;
	weightMap: Map<number, number>;
}

function DayBadge({
	cellDate,
	render,
	weight,
}: {
	cellDate: Date;
	render: (date: Date, weight?: number) => ReactNode;
	weight?: number | undefined;
}) {
	return (
		<span className="text-[10px] opacity-70">{render(cellDate, weight)}</span>
	);
}

function DayCell({
	cellDate,
	monthDate,
	showOutsideDays,
	classMap,
	weightMap,
	formatTooltip,
	renderDayBadge,
	today,
	mode,
	dayState,
	disabled,
	fillWidth,
	system,
	onDayHover,
	onDayClick,
}: {
	cellDate: Date;
	monthDate: Date;
	showOutsideDays: boolean;
	classMap: Map<number, string>;
	weightMap: Map<number, number>;
	formatTooltip?: ((date: Date, weight?: number) => string) | undefined;
	renderDayBadge?: ((date: Date, weight?: number) => ReactNode) | undefined;
	today: Date;
	mode: CalendarMode;
	dayState: DayState;
	disabled: boolean;
	fillWidth: boolean;
	system: CalendarSystem;
	onDayHover: (date: Date | null) => void;
	onDayClick: (date: Date) => void;
}) {
	// Lift the highlighted "today" cell one step above the calendar substrate so
	// it reads as raised. Hook stays at the top, before any early return.
	const todayLevel = Math.min(useSurface() + 1, 8);
	const inMonth = system.isSameDisplayMonth(cellDate, monthDate);
	const widthClass = fillWidth ? "w-full" : "w-(--cell-size)";
	if (!(inMonth || showOutsideDays)) {
		return (
			<td
				aria-label="empty"
				className={cn("h-(--cell-size) p-0", widthClass)}
				key={cellDate.toISOString()}
			/>
		);
	}
	const key = startOfDay(cellDate).getTime();
	const variantClass = classMap.get(key);
	const isToday = isSameDay(cellDate, today);
	const weight = weightMap.get(key);
	const tooltipText = disabled ? undefined : formatTooltip?.(cellDate, weight);
	const stateClass = dayState ? STATE_CLASSES[dayState] : "";
	const useVariant = !dayState && variantClass;

	const innerClass = cn(
		"inline-flex h-(--cell-size) flex-col items-center justify-center gap-0 rounded-md p-0 font-normal text-sm leading-none",
		widthClass,
		useVariant ? variantClass : "",
		!(useVariant || dayState || disabled) && "hover:bg-surface-hover",
		!inMonth && "text-foreground-muted opacity-50",
		isToday &&
			!(useVariant || dayState) &&
			cn("text-foreground", surfaceBg(todayLevel)),
		isToday && "ring-1 ring-border ring-inset",
		stateClass,
		disabled && "cursor-not-allowed text-foreground-muted opacity-30",
	);

	const inner = (
		<>
			<span>{system.dayNumber(cellDate)}</span>
			{renderDayBadge ? (
				<DayBadge cellDate={cellDate} render={renderDayBadge} weight={weight} />
			) : null}
		</>
	);

	const cellNode =
		mode === "none" || disabled ? (
			<span aria-disabled={disabled || undefined} className={innerClass}>
				{inner}
			</span>
		) : (
			<BaseButton
				className={cn(innerClass, "cursor-pointer")}
				onClick={() => onDayClick(cellDate)}
				onFocus={() => onDayHover(cellDate)}
				onMouseEnter={() => onDayHover(cellDate)}
				onMouseLeave={() => onDayHover(null)}
				type="button"
			>
				{inner}
			</BaseButton>
		);

	return (
		<td
			className={cn("p-0 text-center text-sm", fillWidth && "w-full")}
			key={cellDate.toISOString()}
		>
			{tooltipText ? (
				<Tooltip content={tooltipText}>{cellNode}</Tooltip>
			) : (
				cellNode
			)}
		</td>
	);
}

function MonthGrid({
	monthDate,
	weekStartsOn,
	showOutsideDays,
	classMap,
	weightMap,
	formatTooltip,
	renderDayBadge,
	today,
	mode,
	selected,
	hovered,
	isDisabled,
	fillWidth,
	system,
	caption,
	onDayHover,
	onDayClick,
}: MonthGridProps) {
	const grid = getCalendarGrid(
		system.startOfDisplayMonth(monthDate),
		weekStartsOn,
	);
	const weekdayLabels =
		weekStartsOn === 1 ? WEEKDAY_LABELS_MON : WEEKDAY_LABELS_SUN;
	const rowClass = fillWidth ? "grid w-full grid-cols-7" : "flex";
	const cellWidthClass = fillWidth ? "w-full" : "w-(--cell-size)";
	return (
		<div className={cn("flex flex-col gap-2", fillWidth && "min-w-0 flex-1")}>
			{caption ? (
				<span className="text-center font-medium text-foreground-secondary text-xs-tight">
					{caption}
				</span>
			) : null}
			<table
				aria-label={system.monthLabel(monthDate)}
				className="w-full border-collapse"
			>
				<thead>
					<tr className={rowClass}>
						{weekdayLabels.map((label) => (
							<th
								className={cn(
									"rounded-md font-normal text-[0.8rem] text-foreground-muted",
									cellWidthClass,
								)}
								key={label}
								scope="col"
							>
								{label}
							</th>
						))}
					</tr>
				</thead>
				<tbody className="flex flex-col gap-1 pt-1">
					{Array.from({ length: 6 }, (_, weekIdx) => (
						<tr
							className={rowClass}
							key={`week-${monthDate.toISOString()}-${weekIdx}`}
						>
							{grid.slice(weekIdx * 7, weekIdx * 7 + 7).map((cellDate) => (
								<DayCell
									cellDate={cellDate}
									classMap={classMap}
									dayState={computeDayState(cellDate, mode, selected, hovered)}
									disabled={isDisabled?.(cellDate) ?? false}
									fillWidth={fillWidth}
									formatTooltip={formatTooltip}
									key={cellDate.toISOString()}
									mode={mode}
									monthDate={monthDate}
									onDayClick={onDayClick}
									onDayHover={onDayHover}
									renderDayBadge={renderDayBadge}
									showOutsideDays={showOutsideDays}
									system={system}
									today={today}
									weightMap={weightMap}
								/>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function CalendarHeader({
	segments,
	prevLabel,
	nextLabel,
	onPrev,
	onNext,
}: {
	segments: HeaderSegment[];
	prevLabel: string;
	nextLabel: string;
	onPrev: () => void;
	onNext: () => void;
}) {
	return (
		<div className="flex items-center justify-between gap-1 pt-1">
			<BaseButton
				aria-label={prevLabel}
				className={NAV_BUTTON_CLASS}
				onClick={onPrev}
				type="button"
			>
				<HugeiconsIcon icon={ArrowLeft01Icon} size={16} />
			</BaseButton>
			<div className="flex flex-1 items-center justify-center gap-1">
				{segments.map((seg) =>
					seg.onClick ? (
						<BaseButton
							className="rounded-md px-2 py-1 font-medium text-foreground text-sm hover:bg-surface-hover"
							key={seg.label}
							onClick={seg.onClick}
							type="button"
						>
							{seg.label}
						</BaseButton>
					) : (
						<span
							className="px-2 py-1 font-medium text-foreground text-sm"
							key={seg.label}
						>
							{seg.label}
						</span>
					),
				)}
			</div>
			<BaseButton
				aria-label={nextLabel}
				className={NAV_BUTTON_CLASS}
				onClick={onNext}
				type="button"
			>
				<HugeiconsIcon icon={ArrowRight01Icon} size={16} />
			</BaseButton>
		</div>
	);
}

function PickerGrid({
	cells,
	activeDate,
	today,
	onPick,
}: {
	cells: { date: Date; label: string }[];
	activeDate: Date | null;
	today: Date;
	onPick: (date: Date) => void;
}) {
	return (
		<div className="grid w-full grid-cols-3 gap-2 pt-2">
			{cells.map((cell) => {
				const isActive = activeDate ? isSameDay(cell.date, activeDate) : false;
				const isCurrent = isSameDay(cell.date, today);
				return (
					<BaseButton
						className={cn(
							"rounded-md py-2 text-foreground-secondary text-sm hover:bg-surface-hover hover:text-foreground",
							isActive && "bg-teal text-white hover:bg-teal hover:text-white",
							isCurrent && !isActive && "ring-1 ring-border ring-inset",
						)}
						key={cell.label + cell.date.toISOString()}
						onClick={() => onPick(cell.date)}
						type="button"
					>
						{cell.label}
					</BaseButton>
				);
			})}
		</div>
	);
}

function PresetList({
	presets,
	onPick,
}: {
	presets: CalendarPreset[];
	onPick: (preset: CalendarPreset) => void;
}) {
	return (
		<div className="flex w-32 flex-col gap-1 border-border border-r pr-3">
			{presets.map((preset) => (
				<BaseButton
					className="rounded-md px-2 py-1.5 text-left text-foreground-secondary text-sm hover:bg-surface-hover hover:text-foreground"
					key={preset.label}
					onClick={() => onPick(preset)}
					type="button"
				>
					{preset.label}
				</BaseButton>
			))}
		</div>
	);
}

function TimeField({
	id,
	label,
	value,
	onChange,
}: {
	id: string;
	label: string;
	value: Date | null;
	onChange: (next: Date) => void;
}) {
	const commitTime = (e: ChangeEvent<HTMLInputElement>) => {
		if (!value) {
			return;
		}
		const parsed = parseTimeInput(e.target.value);
		if (!parsed) {
			return;
		}
		onChange(setTimePartOf(value, parsed[0], parsed[1]));
	};
	// Lift one step above the surrounding substrate so the input reads as
	// elevated against deeper containers (popups, dialogs).
	const substrate = useSurface();
	const inputLevel = Math.min(substrate + 1, 8);
	return (
		<label
			className="flex flex-col gap-1 text-foreground-muted text-xs"
			htmlFor={id}
		>
			{label}
			<Input
				aria-label={label}
				className={cn(
					"rounded-md px-2 py-1 font-mono text-foreground text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50",
					surfaceClasses(inputLevel),
				)}
				disabled={!value}
				id={id}
				onChange={commitTime}
				type="time"
				value={formatTimeInput(value)}
			/>
		</label>
	);
}

function renderTimeFields(
	mode: CalendarMode,
	selected: Date | DateRange | null,
	makeHandler: (which: "from" | "to" | "single") => (next: Date) => void,
): ReactNode {
	if (mode === "single") {
		const value = isDateValue(selected) ? selected : null;
		return (
			<div className="flex justify-end gap-3 pt-1">
				<TimeField
					id="cal-time"
					label="Time"
					onChange={makeHandler("single")}
					value={value}
				/>
			</div>
		);
	}
	if (mode === "range" && isRangeValue(selected)) {
		return (
			<div className="flex justify-end gap-3 pt-1">
				<TimeField
					id="cal-time-from"
					label="Start time"
					onChange={makeHandler("from")}
					value={selected.from}
				/>
				<TimeField
					id="cal-time-to"
					label="End time"
					onChange={makeHandler("to")}
					value={selected.to}
				/>
			</div>
		);
	}
	return null;
}

export {
	CalendarHeader,
	MonthGrid,
	type MonthGridProps,
	PickerGrid,
	PresetList,
	renderTimeFields,
};
