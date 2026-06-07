import type { ReactNode } from "react";
import type { CalendarSystemId } from "./calendar-system";

export type ViewMode = "days" | "months" | "years";

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

export type DayState =
	| "selected"
	| "range-start"
	| "range-end"
	| "range-middle"
	| null;
