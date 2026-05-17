import type { CalendarPreset } from "./CalendarHeatmap";

/**
 * Localized labels for the default preset set produced by
 * `buildDefaultCalendarPresets`. Callers resolve i18n at the call site and
 * pass the strings in directly — this keeps the `shared/ui` layer
 * independent of any i18n library.
 */
export interface DefaultCalendarPresetLabels {
	last7Days: string;
	last30Days: string;
	lastMonth: string;
	thisMonth: string;
	today: string;
	yesterday: string;
}

function startOfDay(d: Date): Date {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function endOfDay(d: Date): Date {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

function addDays(d: Date, n: number): Date {
	const next = new Date(d);
	next.setDate(next.getDate() + n);
	return next;
}

function startOfMonth(d: Date): Date {
	return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d: Date): Date {
	return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}

/**
 * Build the standard set of date-range presets (Today, Yesterday, Last 7 days,
 * Last 30 days, This month, Last month) for use with `CalendarHeatmap`'s
 * `presets` prop in `mode="range"`.
 *
 * Pass `now` for tests; defaults to `new Date()`.
 */
export function buildDefaultCalendarPresets(
	labels: DefaultCalendarPresetLabels,
	now: Date = new Date()
): CalendarPreset[] {
	const todayStart = startOfDay(now);
	const todayEnd = endOfDay(now);

	const yesterdayStart = addDays(todayStart, -1);
	const yesterdayEnd = endOfDay(yesterdayStart);

	const last7Start = addDays(todayStart, -6);
	const last30Start = addDays(todayStart, -29);

	const thisMonthStart = startOfMonth(now);
	const thisMonthEnd = endOfMonth(now);

	const lastMonthAnchor = new Date(now.getFullYear(), now.getMonth() - 1, 1);
	const lastMonthStart = startOfMonth(lastMonthAnchor);
	const lastMonthEnd = endOfMonth(lastMonthAnchor);

	return [
		{ label: labels.today, range: { from: todayStart, to: todayEnd } },
		{ label: labels.yesterday, range: { from: yesterdayStart, to: yesterdayEnd } },
		{ label: labels.last7Days, range: { from: last7Start, to: todayEnd } },
		{ label: labels.last30Days, range: { from: last30Start, to: todayEnd } },
		{ label: labels.thisMonth, range: { from: thisMonthStart, to: thisMonthEnd } },
		{ label: labels.lastMonth, range: { from: lastMonthStart, to: lastMonthEnd } },
	];
}
