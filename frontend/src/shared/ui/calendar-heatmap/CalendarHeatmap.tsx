"use client";

import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ChangeEvent, type CSSProperties, type ReactNode, useState } from "react";
import { cn } from "@/shared/lib/cn";
import { Tooltip } from "@/shared/ui/tooltip";
import { type CalendarSystem, type CalendarSystemId, getCalendarSystem } from "./calendar-system";

const YEAR_SPAN = 12;
type ViewMode = "days" | "months" | "years";

export interface WeightedDateEntry {
	date: Date;
	weight: number;
}

export interface DateRange {
	from: Date | null;
	to: Date | null;
}

export interface CalendarPreset {
	label: string;
	range: DateRange;
}

export type CalendarMode = "none" | "single" | "range";

export interface CalendarHeatmapProps {
	calendarSystem?: CalendarSystemId;
	cellSize?: string;
	className?: string;
	datesPerVariant?: Date[][];
	defaultMonth?: Date;
	disabled?: (date: Date) => boolean;
	formatTooltip?: (date: Date, weight?: number) => string;

	mode?: CalendarMode;
	nextMonthLabel?: string;
	numberOfMonths?: number;
	onSelect?: (value: Date | DateRange | null) => void;

	presets?: CalendarPreset[];
	prevMonthLabel?: string;
	renderDayBadge?: (date: Date, weight?: number) => ReactNode;
	selected?: Date | DateRange | null;
	showOutsideDays?: boolean;

	variantClassnames?: string[];
	weekStartsOn?: 0 | 1;
	weightedDates?: WeightedDateEntry[];
	withTime?: boolean;
}

const WEEKDAY_LABELS_SUN = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;
const WEEKDAY_LABELS_MON = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;

const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const isSameDay = (a: Date, b: Date) =>
	a.getFullYear() === b.getFullYear() &&
	a.getMonth() === b.getMonth() &&
	a.getDate() === b.getDate();

const isDateValue = (v: unknown): v is Date => v instanceof Date;
const isRangeValue = (v: unknown): v is DateRange =>
	v !== null && typeof v === "object" && "from" in v && "to" in v;

function categorizeDatesPerVariant(weighted: WeightedDateEntry[], noOfVariants: number): Date[][] {
	const buckets: Date[][] = Array.from({ length: noOfVariants }, () => []);
	if (weighted.length === 0 || noOfVariants === 0) {
		return buckets;
	}
	const sorted = weighted.toSorted((a, b) => a.weight - b.weight);
	const first = sorted[0];
	const last = sorted.at(-1);
	if (!(first && last)) {
		return buckets;
	}
	const minW = first.weight;
	const maxW = last.weight;
	const range = minW === maxW ? 1 : (maxW - minW) / noOfVariants;
	for (const entry of sorted) {
		const idx = Math.min(Math.floor((entry.weight - minW) / range), noOfVariants - 1);
		buckets[idx]?.push(entry.date);
	}
	return buckets;
}

function buildDateClassMap(
	variantClassnames: string[],
	datesPerVariant: Date[][]
): Map<number, string> {
	const map = new Map<number, string>();
	datesPerVariant.forEach((dates, i) => {
		const cls = variantClassnames[i];
		if (!cls) {
			return;
		}
		for (const date of dates) {
			map.set(startOfDay(date).getTime(), cls);
		}
	});
	return map;
}

function buildWeightMap(weighted: WeightedDateEntry[] | undefined): Map<number, number> {
	const map = new Map<number, number>();
	if (!weighted) {
		return map;
	}
	for (const entry of weighted) {
		map.set(startOfDay(entry.date).getTime(), entry.weight);
	}
	return map;
}

function getCalendarGrid(monthStart: Date, weekStartsOn: 0 | 1): Date[] {
	const firstDayOfWeek = monthStart.getDay();
	const offset = (firstDayOfWeek - weekStartsOn + 7) % 7;
	const gridStart = new Date(monthStart);
	gridStart.setDate(monthStart.getDate() - offset);
	return Array.from({ length: 42 }, (_, i) => {
		const d = new Date(gridStart);
		d.setDate(gridStart.getDate() + i);
		return d;
	});
}

function normalizeRange(a: Date, b: Date): DateRange {
	return a.getTime() <= b.getTime() ? { from: a, to: b } : { from: b, to: a };
}

function setTimePartOf(date: Date, hours: number, minutes: number): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours, minutes);
}

function formatTimeInput(date: Date | null): string {
	if (!date) {
		return "";
	}
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const TIME_INPUT_PATTERN = /^(\d{1,2}):(\d{2})$/;

function parseTimeInput(s: string): [number, number] | null {
	const m = TIME_INPUT_PATTERN.exec(s);
	if (!m) {
		return null;
	}
	const h = Number(m[1]);
	const mi = Number(m[2]);
	if (h < 0 || h > 23 || mi < 0 || mi > 59) {
		return null;
	}
	return [h, mi];
}

type DayState = "selected" | "range-start" | "range-end" | "range-middle" | null;

function rangeStateFor(date: Date, from: Date, end: Date): DayState {
	const lo = startOfDay(from.getTime() <= end.getTime() ? from : end).getTime();
	const hi = startOfDay(from.getTime() <= end.getTime() ? end : from).getTime();
	const t = startOfDay(date).getTime();
	if (t === lo && t === hi) {
		return "selected";
	}
	if (t === lo) {
		return "range-start";
	}
	if (t === hi) {
		return "range-end";
	}
	if (t > lo && t < hi) {
		return "range-middle";
	}
	return null;
}

function computeRangeDayState(date: Date, range: DateRange, hovered: Date | null): DayState {
	const { from, to } = range;
	if (!from) {
		return null;
	}
	const previewEnd = to ?? hovered;
	if (previewEnd) {
		return rangeStateFor(date, from, previewEnd);
	}
	return isSameDay(date, from) ? "selected" : null;
}

function computeDayState(
	date: Date,
	mode: CalendarMode,
	selected: Date | DateRange | null,
	hovered: Date | null
): DayState {
	if (mode === "single" && isDateValue(selected)) {
		return isSameDay(selected, date) ? "selected" : null;
	}
	if (mode === "range" && isRangeValue(selected)) {
		return computeRangeDayState(date, selected, hovered);
	}
	return null;
}

const STATE_CLASSES: Record<Exclude<DayState, null>, string> = {
	selected: "bg-teal text-white",
	"range-start": "bg-teal text-white rounded-r-none",
	"range-end": "bg-teal text-white rounded-l-none",
	"range-middle": "bg-teal/25 text-foreground rounded-none",
};

const NAV_BUTTON_CLASS =
	"inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-transparent p-0 text-foreground-muted opacity-50 transition-opacity hover:opacity-100";

interface MonthGridProps {
	caption?: string;
	classMap: Map<number, string>;
	formatTooltip?: (date: Date, weight?: number) => string;
	hovered: Date | null;
	isDisabled?: (date: Date) => boolean;
	mode: CalendarMode;
	monthDate: Date;
	onDayClick: (date: Date) => void;
	onDayHover: (date: Date | null) => void;
	renderDayBadge?: (date: Date, weight?: number) => ReactNode;
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
	weight?: number;
}) {
	return <span className="text-[10px] opacity-70">{render(cellDate, weight)}</span>;
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
	system,
	onDayHover,
	onDayClick,
}: {
	cellDate: Date;
	monthDate: Date;
	showOutsideDays: boolean;
	classMap: Map<number, string>;
	weightMap: Map<number, number>;
	formatTooltip?: (date: Date, weight?: number) => string;
	renderDayBadge?: (date: Date, weight?: number) => ReactNode;
	today: Date;
	mode: CalendarMode;
	dayState: DayState;
	disabled: boolean;
	system: CalendarSystem;
	onDayHover: (date: Date | null) => void;
	onDayClick: (date: Date) => void;
}) {
	const inMonth = system.isSameDisplayMonth(cellDate, monthDate);
	if (!(inMonth || showOutsideDays)) {
		return <td className="h-(--cell-size) w-(--cell-size) p-0" key={cellDate.toISOString()} />;
	}
	const key = startOfDay(cellDate).getTime();
	const variantClass = classMap.get(key);
	const isToday = isSameDay(cellDate, today);
	const weight = weightMap.get(key);
	const tooltipText = disabled ? undefined : formatTooltip?.(cellDate, weight);
	const stateClass = dayState ? STATE_CLASSES[dayState] : "";
	const useVariant = !dayState && variantClass;

	const innerClass = cn(
		"inline-flex h-(--cell-size) w-(--cell-size) flex-col items-center justify-center gap-0 rounded-md p-0 font-normal text-sm leading-none",
		useVariant ? variantClass : "",
		!(useVariant || dayState || disabled) && "hover:bg-surface-hover",
		!inMonth && "text-foreground-muted opacity-50",
		isToday && !(useVariant || dayState) && "bg-surface-elevated text-foreground",
		isToday && "ring-1 ring-border ring-inset",
		stateClass,
		disabled && "cursor-not-allowed text-foreground-muted opacity-30"
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
			<button
				className={cn(innerClass, "cursor-pointer")}
				onClick={() => onDayClick(cellDate)}
				onFocus={() => onDayHover(cellDate)}
				onMouseEnter={() => onDayHover(cellDate)}
				onMouseLeave={() => onDayHover(null)}
				type="button"
			>
				{inner}
			</button>
		);

	return (
		<td className="p-0 text-center text-sm" key={cellDate.toISOString()}>
			{tooltipText ? <Tooltip content={tooltipText}>{cellNode}</Tooltip> : cellNode}
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
	system,
	caption,
	onDayHover,
	onDayClick,
}: MonthGridProps) {
	const grid = getCalendarGrid(system.startOfDisplayMonth(monthDate), weekStartsOn);
	const weekdayLabels = weekStartsOn === 1 ? WEEKDAY_LABELS_MON : WEEKDAY_LABELS_SUN;
	return (
		<div className="flex flex-col gap-2">
			{caption ? (
				<span className="text-center font-medium text-foreground-secondary text-xs-tight">
					{caption}
				</span>
			) : null}
			<table aria-label={system.monthLabel(monthDate)} className="w-full border-collapse">
				<thead>
					<tr className="flex">
						{weekdayLabels.map((label) => (
							<th
								className="w-(--cell-size) rounded-md font-normal text-[0.8rem] text-foreground-muted"
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
						<tr className="flex w-full" key={`week-${monthDate.toISOString()}-${weekIdx}`}>
							{grid.slice(weekIdx * 7, weekIdx * 7 + 7).map((cellDate) => (
								<DayCell
									cellDate={cellDate}
									classMap={classMap}
									dayState={computeDayState(cellDate, mode, selected, hovered)}
									disabled={isDisabled?.(cellDate) ?? false}
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

interface HeaderSegment {
	label: string;
	onClick?: () => void;
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
			<button aria-label={prevLabel} className={NAV_BUTTON_CLASS} onClick={onPrev} type="button">
				<HugeiconsIcon icon={ArrowLeft01Icon} size={16} />
			</button>
			<div className="flex flex-1 items-center justify-center gap-1">
				{segments.map((seg) =>
					seg.onClick ? (
						<button
							className="rounded-md px-2 py-1 font-medium text-foreground text-sm hover:bg-surface-hover"
							key={seg.label}
							onClick={seg.onClick}
							type="button"
						>
							{seg.label}
						</button>
					) : (
						<span className="px-2 py-1 font-medium text-foreground text-sm" key={seg.label}>
							{seg.label}
						</span>
					)
				)}
			</div>
			<button aria-label={nextLabel} className={NAV_BUTTON_CLASS} onClick={onNext} type="button">
				<HugeiconsIcon icon={ArrowRight01Icon} size={16} />
			</button>
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
		<div className="grid grid-cols-3 gap-2 pt-2">
			{cells.map((cell) => {
				const isActive = activeDate ? isSameDay(cell.date, activeDate) : false;
				const isCurrent = isSameDay(cell.date, today);
				return (
					<button
						className={cn(
							"rounded-md py-2 text-foreground-secondary text-sm hover:bg-surface-hover hover:text-foreground",
							isActive && "bg-teal text-white hover:bg-teal hover:text-white",
							isCurrent && !isActive && "ring-1 ring-border ring-inset"
						)}
						key={cell.label + cell.date.toISOString()}
						onClick={() => onPick(cell.date)}
						type="button"
					>
						{cell.label}
					</button>
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
				<button
					className="rounded-md px-2 py-1.5 text-left text-foreground-secondary text-sm hover:bg-surface-hover hover:text-foreground"
					key={preset.label}
					onClick={() => onPick(preset)}
					type="button"
				>
					{preset.label}
				</button>
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
	return (
		<label className="flex flex-col gap-1 text-foreground-muted text-xs" htmlFor={id}>
			{label}
			<input
				className="rounded-md border border-border bg-surface-tertiary px-2 py-1 font-mono text-foreground text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
				disabled={!value}
				id={id}
				onChange={commitTime}
				type="time"
				value={formatTimeInput(value)}
			/>
		</label>
	);
}

function resolveSelected(
	controlled: Date | DateRange | null | undefined,
	internal: Date | DateRange | null
): Date | DateRange | null {
	if (controlled !== undefined) {
		return controlled;
	}
	return internal;
}

function headerSegmentsFor(
	viewMode: ViewMode,
	system: CalendarSystem,
	anchor: Date,
	goTo: (v: ViewMode) => void
): HeaderSegment[] {
	if (viewMode === "days") {
		return [
			{ label: system.monthOnlyLabel(anchor), onClick: () => goTo("months") },
			{ label: system.yearLabel(anchor), onClick: () => goTo("years") },
		];
	}
	if (viewMode === "months") {
		return [{ label: system.yearLabel(anchor), onClick: () => goTo("years") }];
	}
	return [{ label: system.yearRangeLabel(anchor, YEAR_SPAN) }];
}

function applyRangeClick(prev: Date | DateRange | null, date: Date): DateRange {
	if (!(isRangeValue(prev) && prev.from) || prev.to) {
		return { from: date, to: null };
	}
	return normalizeRange(prev.from, date);
}

export function CalendarHeatmap({
	className,
	numberOfMonths = 1,
	defaultMonth,
	showOutsideDays = true,
	weekStartsOn = 0,
	prevMonthLabel = "Previous month",
	nextMonthLabel = "Next month",
	cellSize,
	calendarSystem = "gregorian",
	variantClassnames,
	datesPerVariant,
	weightedDates,
	formatTooltip,
	renderDayBadge,
	disabled,
	mode = "none",
	selected,
	onSelect,
	presets,
	withTime = false,
}: CalendarHeatmapProps) {
	const system = getCalendarSystem(calendarSystem);
	const classnames = variantClassnames ?? [];
	const resolvedVariants =
		datesPerVariant ?? categorizeDatesPerVariant(weightedDates ?? [], classnames.length);
	const classMap = buildDateClassMap(classnames, resolvedVariants);
	const weightMap = buildWeightMap(weightedDates);

	const [internalSelected, setInternalSelected] = useState<Date | DateRange | null>(null);
	const currentSelected = resolveSelected(selected, internalSelected);

	const setSelected = (next: Date | DateRange | null) => {
		if (selected === undefined) {
			setInternalSelected(next);
		}
		onSelect?.(next);
	};

	const [hovered, setHovered] = useState<Date | null>(null);
	const [viewMode, setViewMode] = useState<ViewMode>("days");
	const [anchor, setAnchor] = useState<Date>(() =>
		system.startOfDisplayMonth(defaultMonth ?? new Date())
	);
	const today = startOfDay(new Date());
	const months = Array.from({ length: Math.max(1, numberOfMonths) }, (_, i) =>
		system.addMonths(anchor, i)
	);

	const handleDayClick = (date: Date) => {
		if (disabled?.(date)) {
			return;
		}
		if (mode === "single") {
			setSelected(date);
			return;
		}
		if (mode === "range") {
			setSelected(applyRangeClick(currentSelected, date));
		}
	};

	const handlePresetPick = (preset: CalendarPreset) => {
		setSelected({ from: preset.range.from, to: preset.range.to });
		if (preset.range.from) {
			setAnchor(system.startOfDisplayMonth(preset.range.from));
		}
	};

	const stepView = (dir: -1 | 1) => {
		if (viewMode === "days") {
			setAnchor((d) => system.addMonths(d, dir));
		} else if (viewMode === "months") {
			setAnchor((d) => system.addYears(d, dir));
		} else {
			setAnchor((d) => system.addYears(d, dir * YEAR_SPAN));
		}
	};

	const headerSegments = headerSegmentsFor(viewMode, system, anchor, setViewMode);

	const activePickDate = isDateValue(currentSelected) ? currentSelected : null;

	const handleTimeChange = (which: "from" | "to" | "single") => (next: Date) => {
		if (which === "single" && isDateValue(currentSelected)) {
			setSelected(next);
			return;
		}
		if (which !== "single" && isRangeValue(currentSelected)) {
			setSelected({
				from: which === "from" ? next : currentSelected.from,
				to: which === "to" ? next : currentSelected.to,
			});
		}
	};

	const containerStyle: CSSProperties = cellSize
		? ({ "--cell-size": cellSize } as CSSProperties)
		: {};
	const rootClass = cn(
		"flex flex-col gap-4 p-3 [--cell-size:2.25rem]",
		presets ? "sm:flex-row" : "sm:flex-row sm:gap-4",
		className
	);

	const daysBlock = (
		<div className="flex flex-col gap-4 sm:flex-row sm:gap-4">
			{months.map((monthDate) => (
				<MonthGrid
					caption={numberOfMonths > 1 ? system.monthLabel(monthDate) : undefined}
					classMap={classMap}
					formatTooltip={formatTooltip}
					hovered={hovered}
					isDisabled={disabled}
					key={monthDate.toISOString()}
					mode={mode}
					monthDate={monthDate}
					onDayClick={handleDayClick}
					onDayHover={setHovered}
					renderDayBadge={renderDayBadge}
					selected={currentSelected}
					showOutsideDays={showOutsideDays}
					system={system}
					today={today}
					weekStartsOn={weekStartsOn}
					weightMap={weightMap}
				/>
			))}
		</div>
	);

	let body: ReactNode = daysBlock;
	if (viewMode === "months") {
		body = (
			<PickerGrid
				activeDate={activePickDate}
				cells={system.monthsOfYear(anchor)}
				onPick={(date) => {
					setAnchor(system.startOfDisplayMonth(date));
					setViewMode("days");
				}}
				today={today}
			/>
		);
	} else if (viewMode === "years") {
		body = (
			<PickerGrid
				activeDate={activePickDate}
				cells={system.yearsAround(anchor, YEAR_SPAN)}
				onPick={(date) => {
					setAnchor(date);
					setViewMode("months");
				}}
				today={today}
			/>
		);
	}

	const timeBlock =
		viewMode === "days" && withTime
			? renderTimeFields(mode, currentSelected, handleTimeChange)
			: null;

	return (
		<div className={rootClass} style={containerStyle}>
			{presets && mode === "range" ? (
				<PresetList onPick={handlePresetPick} presets={presets} />
			) : null}
			<div className="flex min-w-(--cell-size) flex-col gap-1">
				<CalendarHeader
					nextLabel={nextMonthLabel}
					onNext={() => stepView(1)}
					onPrev={() => stepView(-1)}
					prevLabel={prevMonthLabel}
					segments={headerSegments}
				/>
				{body}
				{timeBlock}
			</div>
		</div>
	);
}

function renderTimeFields(
	mode: CalendarMode,
	selected: Date | DateRange | null,
	makeHandler: (which: "from" | "to" | "single") => (next: Date) => void
): ReactNode {
	if (mode === "single") {
		const value = isDateValue(selected) ? selected : null;
		return (
			<div className="flex justify-end gap-3 pt-1">
				<TimeField id="cal-time" label="Time" onChange={makeHandler("single")} value={value} />
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
