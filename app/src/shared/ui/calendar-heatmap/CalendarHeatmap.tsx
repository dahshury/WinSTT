import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ChangeEvent, type CSSProperties, type ReactNode, useReducer } from "react";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, surfaceClasses, useSurface } from "@/shared/lib/surface";
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

/** Time-scale bucket a preset belongs to, used to lay presets out in tidy,
 * semantically-grouped clusters instead of one ragged row. */
export type CalendarPresetGroup = "day" | "month" | "year";

export interface CalendarPreset {
	group?: CalendarPresetGroup;
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
	fillWidth?: boolean;
	formatTooltip?: (date: Date, weight?: number) => string;

	mode?: CalendarMode;
	month?: Date;
	nextMonthLabel?: string;
	numberOfMonths?: number;
	onMonthChange?: (date: Date) => void;
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
		isToday && !(useVariant || dayState) && cn("text-foreground", surfaceBg(todayLevel)),
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
		<td
			className={cn("p-0 text-center text-sm", fillWidth && "w-full")}
			key={cellDate.toISOString()}
		>
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
	fillWidth,
	system,
	caption,
	onDayHover,
	onDayClick,
}: MonthGridProps) {
	const grid = getCalendarGrid(system.startOfDisplayMonth(monthDate), weekStartsOn);
	const weekdayLabels = weekStartsOn === 1 ? WEEKDAY_LABELS_MON : WEEKDAY_LABELS_SUN;
	const rowClass = fillWidth ? "grid w-full grid-cols-7" : "flex";
	const cellWidthClass = fillWidth ? "w-full" : "w-(--cell-size)";
	return (
		<div className={cn("flex flex-col gap-2", fillWidth && "min-w-0 flex-1")}>
			{caption ? (
				<span className="text-center font-medium text-foreground-secondary text-xs-tight">
					{caption}
				</span>
			) : null}
			<table aria-label={system.monthLabel(monthDate)} className="w-full border-collapse">
				<thead>
					<tr className={rowClass}>
						{weekdayLabels.map((label) => (
							<th
								className={cn(
									"rounded-md font-normal text-[0.8rem] text-foreground-muted",
									cellWidthClass
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
						<tr className={rowClass} key={`week-${monthDate.toISOString()}-${weekIdx}`}>
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
		<div className="grid w-full grid-cols-3 gap-2 pt-2">
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
	// Lift one step above the surrounding substrate so the input reads as
	// elevated against deeper containers (popups, dialogs).
	const substrate = useSurface();
	const inputLevel = Math.min(substrate + 1, 8);
	return (
		<label className="flex flex-col gap-1 text-foreground-muted text-xs" htmlFor={id}>
			{label}
			<input
				aria-label={label}
				className={cn(
					"rounded-md px-2 py-1 font-mono text-foreground text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50",
					surfaceClasses(inputLevel)
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

interface CalendarState {
	anchors: Date[];
	hovered: Date | null;
	internalSelected: Date | DateRange | null;
	// Records the externally-supplied `month` prop timestamp we've already
	// synced anchors to. Storing this in state (instead of a ref) and comparing
	// during render lets us implement the React-canonical "adjusting some state
	// when a prop changes" pattern without a useEffect or a ref-read-in-render.
	// When WE initiate a change via updateAnchor, we pre-record the new
	// timestamp so the inevitable parent re-emit of `month` doesn't clobber
	// independent navigation of the right calendar.
	syncedMonthTs: number | undefined;
	viewModes: ViewMode[];
}

type CalendarAction =
	| { type: "selected/set"; value: Date | DateRange | null }
	| { type: "hovered/set"; value: Date | null }
	| { type: "anchors/set"; value: Date[] }
	| { type: "anchors/updateOne"; index: number; value: Date }
	| { type: "viewMode/setOne"; index: number; value: ViewMode }
	| {
			type: "monthProp/sync";
			incomingTs: number | undefined;
			anchorsOverride: Date[] | null;
	  };

function calendarReducer(state: CalendarState, action: CalendarAction): CalendarState {
	switch (action.type) {
		case "selected/set":
			return { ...state, internalSelected: action.value };
		case "hovered/set":
			return state.hovered === action.value ? state : { ...state, hovered: action.value };
		case "anchors/set":
			return { ...state, anchors: action.value, syncedMonthTs: action.value[0]?.getTime() };
		case "anchors/updateOne": {
			const next = [...state.anchors];
			next[action.index] = action.value;
			const patch: Partial<CalendarState> =
				action.index === 0 ? { syncedMonthTs: action.value.getTime() } : {};
			return { ...state, anchors: next, ...patch };
		}
		case "viewMode/setOne": {
			const next = [...state.viewModes];
			next[action.index] = action.value;
			return { ...state, viewModes: next };
		}
		case "monthProp/sync":
			if (action.anchorsOverride) {
				return {
					...state,
					anchors: action.anchorsOverride,
					syncedMonthTs: action.incomingTs,
				};
			}
			return { ...state, syncedMonthTs: action.incomingTs };
		default:
			return state;
	}
}

export function CalendarHeatmap({
	className,
	numberOfMonths = 1,
	defaultMonth,
	month,
	onMonthChange,
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
	fillWidth = false,
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

	const monthCount = Math.max(1, numberOfMonths);
	const [state, dispatch] = useReducer(calendarReducer, undefined, () => {
		const base = system.startOfDisplayMonth(month ?? defaultMonth ?? new Date());
		return {
			anchors: Array.from({ length: monthCount }, (_, i) => system.addMonths(base, i)),
			hovered: null,
			internalSelected: null,
			syncedMonthTs: month ? system.startOfDisplayMonth(month).getTime() : undefined,
			viewModes: Array.from({ length: monthCount }, () => "days" as ViewMode),
		};
	});
	const { internalSelected, hovered, anchors, viewModes, syncedMonthTs } = state;

	// React-canonical "adjust state when a prop changes" pattern (see
	// https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes).
	// Compare the incoming controlled `month` timestamp against the one we've
	// already synced to; on mismatch, rebuild anchors AND record the new
	// timestamp in the same dispatch so the next render is steady-state.
	const incomingMonthTs = month ? system.startOfDisplayMonth(month).getTime() : undefined;
	if (incomingMonthTs !== syncedMonthTs) {
		const base = month ? system.startOfDisplayMonth(month) : null;
		const shouldRebuild = base !== null && anchors[0]?.getTime() !== base.getTime();
		dispatch({
			type: "monthProp/sync",
			incomingTs: incomingMonthTs,
			anchorsOverride: shouldRebuild
				? Array.from({ length: monthCount }, (_, i) => system.addMonths(base, i))
				: null,
		});
	}

	const currentSelected = resolveSelected(selected, internalSelected);

	const setSelected = (next: Date | DateRange | null) => {
		if (selected === undefined) {
			dispatch({ type: "selected/set", value: next });
		}
		onSelect?.(next);
	};

	const setHovered = (value: Date | null) => dispatch({ type: "hovered/set", value });

	const today = startOfDay(new Date());

	const updateAnchor = (i: number, next: Date) => {
		const start = system.startOfDisplayMonth(next);
		dispatch({ type: "anchors/updateOne", index: i, value: start });
		if (i === 0) {
			onMonthChange?.(start);
		}
	};

	const updateViewMode = (i: number, v: ViewMode) => {
		dispatch({ type: "viewMode/setOne", index: i, value: v });
	};

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
			const base = system.startOfDisplayMonth(preset.range.from);
			dispatch({
				type: "anchors/set",
				value: Array.from({ length: monthCount }, (_, i) => system.addMonths(base, i)),
			});
			onMonthChange?.(base);
		}
	};

	const stepView = (i: number, dir: -1 | 1) => {
		const vMode = viewModes[i] ?? "days";
		const current = anchors[i] ?? new Date();
		let next: Date;
		if (vMode === "days") {
			next = system.addMonths(current, dir);
		} else if (vMode === "months") {
			next = system.addYears(current, dir);
		} else {
			next = system.addYears(current, dir * YEAR_SPAN);
		}
		updateAnchor(i, next);
	};

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
		fillWidth && "w-full",
		className
	);

	const renderMonth = (anchorDate: Date, i: number): ReactNode => {
		const vMode = viewModes[i] ?? "days";
		const segments = headerSegmentsFor(vMode, system, anchorDate, (v) => updateViewMode(i, v));

		let monthBody: ReactNode;
		if (vMode === "days") {
			monthBody = (
				<MonthGrid
					classMap={classMap}
					fillWidth={fillWidth}
					formatTooltip={formatTooltip}
					hovered={hovered}
					isDisabled={disabled}
					mode={mode}
					monthDate={anchorDate}
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
			);
		} else if (vMode === "months") {
			monthBody = (
				<PickerGrid
					activeDate={activePickDate}
					cells={system.monthsOfYear(anchorDate)}
					onPick={(date) => {
						updateAnchor(i, date);
						updateViewMode(i, "days");
					}}
					today={today}
				/>
			);
		} else {
			monthBody = (
				<PickerGrid
					activeDate={activePickDate}
					cells={system.yearsAround(anchorDate, YEAR_SPAN)}
					onPick={(date) => {
						updateAnchor(i, date);
						updateViewMode(i, "months");
					}}
					today={today}
				/>
			);
		}

		return (
			<div
				className={cn("flex flex-col gap-1", fillWidth && "min-w-0 flex-1")}
				key={anchorDate.getTime()}
			>
				<CalendarHeader
					nextLabel={nextMonthLabel}
					onNext={() => stepView(i, 1)}
					onPrev={() => stepView(i, -1)}
					prevLabel={prevMonthLabel}
					segments={segments}
				/>
				{monthBody}
			</div>
		);
	};

	const monthsBlock = (
		<div className={cn("flex flex-row gap-4", fillWidth && "w-full")}>
			{anchors.map((anchorDate, i) => renderMonth(anchorDate, i))}
		</div>
	);

	const anyPickerOpen = viewModes.some((v) => v !== "days");
	const timeBlock =
		!anyPickerOpen && withTime ? renderTimeFields(mode, currentSelected, handleTimeChange) : null;

	return (
		<div className={rootClass} style={containerStyle}>
			{presets && mode === "range" ? (
				<PresetList onPick={handlePresetPick} presets={presets} />
			) : null}
			<div
				className={cn("flex flex-col gap-1", fillWidth ? "min-w-0 flex-1" : "min-w-(--cell-size)")}
			>
				{monthsBlock}
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
