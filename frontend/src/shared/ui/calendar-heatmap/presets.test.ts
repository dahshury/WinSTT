import { describe, expect, test } from "bun:test";
import type { CalendarPreset } from "./CalendarHeatmap";
import { buildDefaultCalendarPresets, type DefaultCalendarPresetLabels } from "./presets";

const LABELS: DefaultCalendarPresetLabels = {
	last7Days: "L7",
	last30Days: "L30",
	lastMonth: "LM",
	lastYear: "LY",
	monthToDate: "MTD",
	thisMonth: "TM",
	today: "TODAY",
	yearToDate: "YTD",
	yesterday: "YDAY",
};

function byLabel(presets: CalendarPreset[], label: string): CalendarPreset {
	const found = presets.find((p) => p.label === label);
	if (!found) {
		throw new Error(`preset ${label} not found`);
	}
	return found;
}

// A "midday" anchor proves the helpers normalise to day/month/year boundaries
// (00:00:00.000 / 23:59:59.999) rather than carrying the input's clock time.
const ANCHOR = new Date(2026, 4, 15, 13, 37, 42, 500); // 2026-05-15 13:37:42.500

describe("buildDefaultCalendarPresets — structure", () => {
	const presets = buildDefaultCalendarPresets(LABELS, ANCHOR);

	test("produces exactly nine presets in documented order", () => {
		expect(presets.map((p) => p.label)).toEqual([
			"TODAY",
			"YDAY",
			"L7",
			"L30",
			"MTD",
			"TM",
			"LM",
			"YTD",
			"LY",
		]);
	});

	test("every preset has a non-empty label and a from/to Date range", () => {
		for (const preset of presets) {
			expect(typeof preset.label).toBe("string");
			expect(preset.label.length).toBeGreaterThan(0);
			expect(preset.range.from).toBeInstanceOf(Date);
			expect(preset.range.to).toBeInstanceOf(Date);
		}
	});

	test("every range is well-ordered (from <= to)", () => {
		for (const preset of presets) {
			const from = preset.range.from as Date;
			const to = preset.range.to as Date;
			expect(from.getTime()).toBeLessThanOrEqual(to.getTime());
		}
	});

	test("uses the provided labels verbatim (no hardcoded English)", () => {
		const custom = buildDefaultCalendarPresets(
			{ ...LABELS, today: "اليوم", yesterday: "أمس" },
			ANCHOR
		);
		expect(custom[0]?.label).toBe("اليوم");
		expect(custom[1]?.label).toBe("أمس");
	});
});

describe("buildDefaultCalendarPresets — Today / Yesterday", () => {
	const presets = buildDefaultCalendarPresets(LABELS, ANCHOR);

	test("Today spans the full anchor day, clock time stripped", () => {
		const { from, to } = byLabel(presets, "TODAY").range;
		expect(from).toEqual(new Date(2026, 4, 15, 0, 0, 0, 0));
		expect(to).toEqual(new Date(2026, 4, 15, 23, 59, 59, 999));
	});

	test("Yesterday spans the full prior day", () => {
		const { from, to } = byLabel(presets, "YDAY").range;
		expect(from).toEqual(new Date(2026, 4, 14, 0, 0, 0, 0));
		expect(to).toEqual(new Date(2026, 4, 14, 23, 59, 59, 999));
	});

	test("Yesterday crosses a month boundary correctly (1st of month → last of prev)", () => {
		const firstOfMarch = new Date(2026, 2, 1, 9, 0, 0);
		const p = buildDefaultCalendarPresets(LABELS, firstOfMarch);
		const { from, to } = byLabel(p, "YDAY").range;
		// Feb 2026 is not a leap year → 28 days.
		expect(from).toEqual(new Date(2026, 1, 28, 0, 0, 0, 0));
		expect(to).toEqual(new Date(2026, 1, 28, 23, 59, 59, 999));
	});

	test("Yesterday crosses a year boundary (Jan 1 → Dec 31 prev year)", () => {
		const newYear = new Date(2026, 0, 1, 0, 30, 0);
		const p = buildDefaultCalendarPresets(LABELS, newYear);
		const { from } = byLabel(p, "YDAY").range;
		expect(from).toEqual(new Date(2025, 11, 31, 0, 0, 0, 0));
	});
});

describe("buildDefaultCalendarPresets — rolling windows", () => {
	const presets = buildDefaultCalendarPresets(LABELS, ANCHOR);

	test("Last 7 days is an inclusive 7-day window ending today", () => {
		const { from, to } = byLabel(presets, "L7").range;
		// today (15th) minus 6 = the 9th; window is 9..15 inclusive = 7 days.
		expect(from).toEqual(new Date(2026, 4, 9, 0, 0, 0, 0));
		expect(to).toEqual(new Date(2026, 4, 15, 23, 59, 59, 999));
		expect(inclusiveDaySpan(from as Date, to as Date)).toBe(7);
	});

	test("Last 30 days is an inclusive 30-day window ending today", () => {
		const { from, to } = byLabel(presets, "L30").range;
		// 15th May minus 29 → 16th April.
		expect(from).toEqual(new Date(2026, 3, 16, 0, 0, 0, 0));
		expect(to).toEqual(new Date(2026, 4, 15, 23, 59, 59, 999));
		expect(inclusiveDaySpan(from as Date, to as Date)).toBe(30);
	});
});

describe("buildDefaultCalendarPresets — month presets", () => {
	const presets = buildDefaultCalendarPresets(LABELS, ANCHOR);

	test("Month to date runs from the 1st of the month to today (not month end)", () => {
		const { from, to } = byLabel(presets, "MTD").range;
		expect(from).toEqual(new Date(2026, 4, 1, 0, 0, 0, 0));
		expect(to).toEqual(new Date(2026, 4, 15, 23, 59, 59, 999));
	});

	test("This month spans the whole calendar month (May has 31 days)", () => {
		const { from, to } = byLabel(presets, "TM").range;
		expect(from).toEqual(new Date(2026, 4, 1, 0, 0, 0, 0));
		expect(to).toEqual(new Date(2026, 4, 31, 23, 59, 59, 999));
	});

	test("Last month spans the whole previous calendar month (April, 30 days)", () => {
		const { from, to } = byLabel(presets, "LM").range;
		expect(from).toEqual(new Date(2026, 3, 1, 0, 0, 0, 0));
		expect(to).toEqual(new Date(2026, 3, 30, 23, 59, 59, 999));
	});

	test("Last month wraps to December of the prior year when anchored in January", () => {
		const jan = new Date(2026, 0, 10, 12, 0, 0);
		const p = buildDefaultCalendarPresets(LABELS, jan);
		const { from, to } = byLabel(p, "LM").range;
		expect(from).toEqual(new Date(2025, 11, 1, 0, 0, 0, 0));
		expect(to).toEqual(new Date(2025, 11, 31, 23, 59, 59, 999));
	});

	test("This month handles February in a leap year (29 days)", () => {
		// 2028 is a leap year.
		const feb = new Date(2028, 1, 10, 8, 0, 0);
		const p = buildDefaultCalendarPresets(LABELS, feb);
		const { to } = byLabel(p, "TM").range;
		expect(to).toEqual(new Date(2028, 1, 29, 23, 59, 59, 999));
	});

	test("This month handles February in a non-leap year (28 days)", () => {
		const feb = new Date(2026, 1, 10, 8, 0, 0);
		const p = buildDefaultCalendarPresets(LABELS, feb);
		const { to } = byLabel(p, "TM").range;
		expect(to).toEqual(new Date(2026, 1, 28, 23, 59, 59, 999));
	});
});

describe("buildDefaultCalendarPresets — year presets", () => {
	const presets = buildDefaultCalendarPresets(LABELS, ANCHOR);

	test("Year to date runs from Jan 1 of the current year to today", () => {
		const { from, to } = byLabel(presets, "YTD").range;
		expect(from).toEqual(new Date(2026, 0, 1, 0, 0, 0, 0));
		expect(to).toEqual(new Date(2026, 4, 15, 23, 59, 59, 999));
	});

	test("Last year spans the whole prior calendar year (Jan 1 → Dec 31)", () => {
		const { from, to } = byLabel(presets, "LY").range;
		expect(from).toEqual(new Date(2025, 0, 1, 0, 0, 0, 0));
		expect(to).toEqual(new Date(2025, 11, 31, 23, 59, 59, 999));
	});
});

describe("buildDefaultCalendarPresets — defaults & purity", () => {
	test("defaults `now` to the current date when omitted", () => {
		const before = startOfTodayMs();
		const presets = buildDefaultCalendarPresets(LABELS);
		const after = endOfTodayMs();
		const today = byLabel(presets, "TODAY").range;
		const from = today.from as Date;
		const to = today.to as Date;
		// Today's start must be at or after the start-of-day captured before the
		// call, and today's end at or before the end-of-day captured after.
		expect(from.getTime()).toBeGreaterThanOrEqual(before);
		expect(to.getTime()).toBeLessThanOrEqual(after);
	});

	test("does not mutate the caller's `now` Date", () => {
		const now = new Date(2026, 4, 15, 13, 37, 42, 500);
		const snapshot = now.getTime();
		buildDefaultCalendarPresets(LABELS, now);
		expect(now.getTime()).toBe(snapshot);
	});

	test("does not mutate the caller's labels object", () => {
		const labels = { ...LABELS };
		const snapshot = { ...labels };
		buildDefaultCalendarPresets(labels, ANCHOR);
		expect(labels).toEqual(snapshot);
	});

	test("each invocation returns a fresh array (no shared mutable state)", () => {
		const a = buildDefaultCalendarPresets(LABELS, ANCHOR);
		const b = buildDefaultCalendarPresets(LABELS, ANCHOR);
		expect(a).not.toBe(b);
		expect(a[0]).not.toBe(b[0]);
		// But the computed values are deterministic for the same anchor.
		expect((a[0]?.range.from as Date).getTime()).toBe((b[0]?.range.from as Date).getTime());
	});
});

// Counts calendar days spanned by an inclusive [from, to] range by comparing
// each endpoint's local calendar day at UTC noon — immune to DST shifts and to
// `to` being an end-of-day (23:59:59.999) timestamp.
function inclusiveDaySpan(from: Date, to: Date): number {
	const fromDay = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
	const toDay = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
	return Math.round((toDay - fromDay) / 86_400_000) + 1;
}

function startOfTodayMs(): number {
	const d = new Date();
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function endOfTodayMs(): number {
	const d = new Date();
	return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
}
