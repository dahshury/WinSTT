import type { CalendarSystem } from "./calendar-system";
import type {
	CalendarMode,
	DateRange,
	DayState,
	ViewMode,
	WeightedDateEntry,
} from "./types";

const YEAR_SPAN = 12;

export const WEEKDAY_LABELS_SUN = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;
export const WEEKDAY_LABELS_MON = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;

export const startOfDay = (d: Date): Date =>
	new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const isSameDay = (a: Date, b: Date) =>
	a.getFullYear() === b.getFullYear() &&
	a.getMonth() === b.getMonth() &&
	a.getDate() === b.getDate();

export const isDateValue = (v: unknown): v is Date => v instanceof Date;
export const isRangeValue = (v: unknown): v is DateRange =>
	v !== null && typeof v === "object" && "from" in v && "to" in v;

export function categorizeDatesPerVariant(
	weighted: WeightedDateEntry[],
	noOfVariants: number,
): Date[][] {
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
		const idx = Math.min(
			Math.floor((entry.weight - minW) / range),
			noOfVariants - 1,
		);
		buckets[idx]?.push(entry.date);
	}
	return buckets;
}

export function buildDateClassMap(
	variantClassnames: string[],
	datesPerVariant: Date[][],
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

export function buildWeightMap(
	weighted: WeightedDateEntry[] | undefined,
): Map<number, number> {
	const map = new Map<number, number>();
	if (!weighted) {
		return map;
	}
	for (const entry of weighted) {
		map.set(startOfDay(entry.date).getTime(), entry.weight);
	}
	return map;
}

export function getCalendarGrid(monthStart: Date, weekStartsOn: 0 | 1): Date[] {
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

export function setTimePartOf(date: Date, hours: number, minutes: number): Date {
	return new Date(
		date.getFullYear(),
		date.getMonth(),
		date.getDate(),
		hours,
		minutes,
	);
}

export function formatTimeInput(date: Date | null): string {
	if (!date) {
		return "";
	}
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const TIME_INPUT_PATTERN = /^(\d{1,2}):(\d{2})$/;

export function parseTimeInput(s: string): [number, number] | null {
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

function computeRangeDayState(
	date: Date,
	range: DateRange,
	hovered: Date | null,
): DayState {
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

export function computeDayState(
	date: Date,
	mode: CalendarMode,
	selected: Date | DateRange | null,
	hovered: Date | null,
): DayState {
	if (mode === "single" && isDateValue(selected)) {
		return isSameDay(selected, date) ? "selected" : null;
	}
	if (mode === "range" && isRangeValue(selected)) {
		return computeRangeDayState(date, selected, hovered);
	}
	return null;
}

export const STATE_CLASSES: Record<Exclude<DayState, null>, string> = {
	selected: "bg-teal text-white",
	"range-start": "bg-teal text-white rounded-r-none",
	"range-end": "bg-teal text-white rounded-l-none",
	"range-middle": "bg-teal/25 text-foreground rounded-none",
};

export const NAV_BUTTON_CLASS =
	"inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-transparent p-0 text-foreground-muted opacity-50 transition-opacity hover:opacity-100";

export interface HeaderSegment {
	label: string;
	onClick?: () => void;
}

export function resolveSelected(
	controlled: Date | DateRange | null | undefined,
	internal: Date | DateRange | null,
): Date | DateRange | null {
	if (controlled !== undefined) {
		return controlled;
	}
	return internal;
}

export function headerSegmentsFor(
	viewMode: ViewMode,
	system: CalendarSystem,
	anchor: Date,
	goTo: (v: ViewMode) => void,
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

export function applyRangeClick(prev: Date | DateRange | null, date: Date): DateRange {
	if (!(isRangeValue(prev) && prev.from) || prev.to) {
		return { from: date, to: null };
	}
	return normalizeRange(prev.from, date);
}
