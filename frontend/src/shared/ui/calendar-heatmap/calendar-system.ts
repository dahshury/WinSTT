/**
 * Calendar-system abstraction. Selection always stays a real Gregorian `Date`;
 * a CalendarSystem only changes how months/years/day-numbers are *labelled* and
 * how the day grid is *bucketed*. This mirrors bootstrap-hijri-datepicker, where
 * the underlying moment value is Gregorian and `options.hijri` only swaps the
 * `fill*` renderers. Hijri uses the browser's Umm al-Qura implementation
 * (`Intl` `islamic-umalqura`), the same calendar moment-hijri ships.
 */

export type CalendarSystemId = "gregorian" | "hijri";

export interface LabeledDate {
	date: Date;
	label: string;
}

export interface CalendarSystem {
	/** Navigate whole display-months. */
	addMonths: (date: Date, n: number) => Date;
	/** Navigate whole display-years. */
	addYears: (date: Date, n: number) => Date;
	/** Number rendered inside a day cell. */
	dayNumber: (date: Date) => number;
	/** Whether both dates fall in the same display-month (old/new dimming). */
	isSameDisplayMonth: (a: Date, b: Date) => boolean;
	/** Days-view header, e.g. "October 2025" / "Ramadan 1447". */
	monthLabel: (date: Date) => string;
	/** Days-view month segment only, e.g. "October" / "Ramadan". */
	monthOnlyLabel: (date: Date) => string;
	/** The 12 month cells for the display-year of `date`. */
	monthsOfYear: (date: Date) => LabeledDate[];
	/** First Gregorian day of the display-month containing `date`. */
	startOfDisplayMonth: (date: Date) => Date;
	/** Months-view header (the display year), e.g. "2025" / "1447". */
	yearLabel: (date: Date) => string;
	/** Years-view header range, e.g. "2020 – 2031". */
	yearRangeLabel: (date: Date, count: number) => string;
	/** A run of year cells centred on `date` for the years view. */
	yearsAround: (date: Date, count: number) => LabeledDate[];
}

const MS_PER_DAY = 86_400_000;

function startOfDay(d: Date): Date {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
	return startOfDay(new Date(d.getTime() + n * MS_PER_DAY));
}

// ── Gregorian ──────────────────────────────────────────────────────────────

const gregorian: CalendarSystem = {
	monthLabel: (date) => date.toLocaleString(undefined, { month: "long", year: "numeric" }),
	monthOnlyLabel: (date) => date.toLocaleString(undefined, { month: "long" }),
	yearLabel: (date) => String(date.getFullYear()),
	yearRangeLabel: (date, count) => {
		const half = Math.floor(count / 2);
		return `${date.getFullYear() - half} – ${date.getFullYear() - half + count - 1}`;
	},
	dayNumber: (date) => date.getDate(),
	isSameDisplayMonth: (a, b) =>
		a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth(),
	startOfDisplayMonth: (date) => new Date(date.getFullYear(), date.getMonth(), 1),
	addMonths: (date, n) => new Date(date.getFullYear(), date.getMonth() + n, 1),
	addYears: (date, n) => new Date(date.getFullYear() + n, date.getMonth(), 1),
	monthsOfYear: (date) =>
		Array.from({ length: 12 }, (_, m) => {
			const d = new Date(date.getFullYear(), m, 1);
			return { date: d, label: d.toLocaleString(undefined, { month: "short" }) };
		}),
	yearsAround: (date, count) => {
		const half = Math.floor(count / 2);
		const first = date.getFullYear() - half;
		return Array.from({ length: count }, (_, i) => {
			const d = new Date(first + i, date.getMonth(), 1);
			return { date: d, label: String(first + i) };
		});
	},
};

// ── Hijri (Umm al-Qura via Intl) ────────────────────────────────────────────

const HIJRI_LOCALE = "en-US-u-ca-islamic-umalqura";
const hijriNumeric = new Intl.DateTimeFormat(HIJRI_LOCALE, {
	day: "numeric",
	month: "numeric",
	year: "numeric",
});
const hijriMonthShort = new Intl.DateTimeFormat(HIJRI_LOCALE, { month: "short" });
const hijriMonthOnly = new Intl.DateTimeFormat(HIJRI_LOCALE, { month: "long" });
const hijriMonthYear = new Intl.DateTimeFormat(HIJRI_LOCALE, {
	month: "long",
	year: "numeric",
});

interface HijriParts {
	d: number;
	m: number;
	y: number;
}

function hijriPartsOf(date: Date): HijriParts {
	const parts = hijriNumeric.formatToParts(date);
	let y = 0;
	let m = 0;
	let d = 0;
	for (const p of parts) {
		if (p.type === "year") {
			y = Number.parseInt(p.value, 10);
		} else if (p.type === "month") {
			m = Number.parseInt(p.value, 10);
		} else if (p.type === "day") {
			d = Number.parseInt(p.value, 10);
		}
	}
	return { y, m, d };
}

function startOfHijriMonth(date: Date): Date {
	return addDays(startOfDay(date), -(hijriPartsOf(date).d - 1));
}

function nextHijriMonthStart(monthStart: Date): Date {
	// Hijri months are 29–30 days; +28 stays inside, then walk to next day-1.
	let g = addDays(monthStart, 28);
	while (hijriPartsOf(g).d !== 1) {
		g = addDays(g, 1);
	}
	return g;
}

function prevHijriMonthStart(monthStart: Date): Date {
	return startOfHijriMonth(addDays(monthStart, -1));
}

function addHijriMonths(date: Date, n: number): Date {
	let g = startOfHijriMonth(date);
	for (let i = 0; i < Math.abs(n); i++) {
		g = n >= 0 ? nextHijriMonthStart(g) : prevHijriMonthStart(g);
	}
	return g;
}

function startOfHijriYear(date: Date): Date {
	return addHijriMonths(date, 1 - hijriPartsOf(date).m);
}

const hijri: CalendarSystem = {
	monthLabel: (date) => hijriMonthYear.format(date),
	monthOnlyLabel: (date) => hijriMonthOnly.format(date),
	yearLabel: (date) => String(hijriPartsOf(date).y),
	yearRangeLabel: (date, count) => {
		const years = hijri.yearsAround(date, count);
		const first = years[0];
		const last = years.at(-1);
		return first && last ? `${first.label} – ${last.label}` : "";
	},
	dayNumber: (date) => hijriPartsOf(date).d,
	isSameDisplayMonth: (a, b) => {
		const pa = hijriPartsOf(a);
		const pb = hijriPartsOf(b);
		return pa.y === pb.y && pa.m === pb.m;
	},
	startOfDisplayMonth: startOfHijriMonth,
	addMonths: addHijriMonths,
	addYears: (date, n) => addHijriMonths(date, n * 12),
	monthsOfYear: (date) => {
		let cursor = startOfHijriYear(date);
		return Array.from({ length: 12 }, () => {
			const entry: LabeledDate = { date: cursor, label: hijriMonthShort.format(cursor) };
			cursor = nextHijriMonthStart(cursor);
			return entry;
		});
	},
	yearsAround: (date, count) => {
		const half = Math.floor(count / 2);
		let cursor = startOfHijriYear(addHijriMonths(date, -half * 12));
		return Array.from({ length: count }, () => {
			const entry: LabeledDate = { date: cursor, label: String(hijriPartsOf(cursor).y) };
			cursor = addHijriMonths(cursor, 12);
			return entry;
		});
	},
};

export function getCalendarSystem(id: CalendarSystemId): CalendarSystem {
	return id === "hijri" ? hijri : gregorian;
}
