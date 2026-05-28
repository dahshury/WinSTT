import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { type CalendarSystemId, getCalendarSystem } from "./calendar-system";

const gregorian = getCalendarSystem("gregorian");
const hijri = getCalendarSystem("hijri");

const MS_PER_DAY = 86_400_000;

// Valid (non-NaN) dates only — the calendar UI never feeds an invalid Date, and
// round-trip invariants are undefined for NaN (NaN !== NaN). `noInvalidDate`
// keeps fast-check from generating `new Date(NaN)`.
function validDate(min: Date, max: Date): fc.Arbitrary<Date> {
	return fc.date({ min, max, noInvalidDate: true });
}

// Independent oracle for Hijri parts (mirrors the source's Intl extraction but
// re-implemented here so the assertions are a real second opinion, not a copy of
// the production cache). Keyed off the same Umm al-Qura calendar Bun ships, so
// expectations track whatever ICU tables this runtime has.
const hijriFmt = new Intl.DateTimeFormat("en-US-u-ca-islamic-umalqura", {
	day: "numeric",
	month: "numeric",
	year: "numeric",
});
function hijriParts(date: Date): { y: number; m: number; d: number } {
	let y = 0;
	let m = 0;
	let d = 0;
	for (const p of hijriFmt.formatToParts(date)) {
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

describe("getCalendarSystem", () => {
	test("returns the hijri system for 'hijri'", () => {
		// Probe a behaviour unique to Hijri: monthLabel renders an Umm al-Qura month.
		const label = getCalendarSystem("hijri").monthLabel(new Date(2025, 5, 15));
		expect(label).not.toMatch(/January|February|March|April|May|June|July/);
		// 2025-06-15 is in Dhuʻl-Hijjah 1446 AH.
		expect(label).toContain("1446");
	});

	test("returns the gregorian system for 'gregorian'", () => {
		expect(getCalendarSystem("gregorian").yearLabel(new Date(2025, 0, 1))).toBe("2025");
	});

	test("returns gregorian for any non-'hijri' id (default branch)", () => {
		// The implementation is `id === "hijri" ? hijri : gregorian`, so any other
		// value must fall through to gregorian.
		const unknown = "anything-else" as unknown as CalendarSystemId;
		expect(getCalendarSystem(unknown)).toBe(getCalendarSystem("gregorian"));
	});

	test("the two systems are distinct objects", () => {
		expect(getCalendarSystem("hijri")).not.toBe(getCalendarSystem("gregorian"));
	});
});

describe("gregorian", () => {
	describe("dayNumber", () => {
		test("returns the calendar day of month", () => {
			expect(gregorian.dayNumber(new Date(2025, 0, 1))).toBe(1);
			expect(gregorian.dayNumber(new Date(2025, 0, 31))).toBe(31);
			expect(gregorian.dayNumber(new Date(2024, 1, 29))).toBe(29); // leap day
		});

		test("always in 1..31 (property)", () => {
			fc.assert(
				fc.property(validDate(new Date(1970, 0, 1), new Date(2100, 0, 1)), (d) => {
					const n = gregorian.dayNumber(d);
					return n >= 1 && n <= 31;
				}),
				{ numRuns: 300 }
			);
		});
	});

	describe("yearLabel / monthLabel / monthOnlyLabel", () => {
		test("yearLabel is the 4-digit Gregorian year", () => {
			expect(gregorian.yearLabel(new Date(2025, 5, 15))).toBe("2025");
			expect(gregorian.yearLabel(new Date(1999, 11, 31))).toBe("1999");
		});

		test("monthLabel contains month name and year", () => {
			const label = gregorian.monthLabel(new Date(2025, 9, 1)); // October
			expect(label).toContain("October");
			expect(label).toContain("2025");
		});

		test("monthOnlyLabel is the month name without the year", () => {
			const label = gregorian.monthOnlyLabel(new Date(2025, 9, 1));
			expect(label).toContain("October");
			expect(label).not.toContain("2025");
		});
	});

	describe("isSameDisplayMonth", () => {
		test("true for two dates in the same month/year", () => {
			expect(gregorian.isSameDisplayMonth(new Date(2025, 5, 1), new Date(2025, 5, 30))).toBe(true);
		});

		test("false across a month boundary (same year)", () => {
			expect(gregorian.isSameDisplayMonth(new Date(2025, 5, 30), new Date(2025, 6, 1))).toBe(false);
		});

		test("false for same month index but different year", () => {
			expect(gregorian.isSameDisplayMonth(new Date(2024, 5, 15), new Date(2025, 5, 15))).toBe(
				false
			);
		});
	});

	describe("startOfDisplayMonth", () => {
		test("snaps to the first of the month at local midnight", () => {
			const s = gregorian.startOfDisplayMonth(new Date(2025, 5, 17, 13, 45, 30));
			expect(s.getFullYear()).toBe(2025);
			expect(s.getMonth()).toBe(5);
			expect(s.getDate()).toBe(1);
			expect(s.getHours()).toBe(0);
			expect(s.getMinutes()).toBe(0);
		});
	});

	describe("addMonths", () => {
		test("adds whole months and lands on day 1", () => {
			const r = gregorian.addMonths(new Date(2025, 5, 17), 1);
			expect(r.getFullYear()).toBe(2025);
			expect(r.getMonth()).toBe(6);
			expect(r.getDate()).toBe(1);
		});

		test("rolls over the year boundary forward", () => {
			const r = gregorian.addMonths(new Date(2025, 11, 10), 1); // Dec -> Jan next year
			expect(r.getFullYear()).toBe(2026);
			expect(r.getMonth()).toBe(0);
		});

		test("rolls over the year boundary backward", () => {
			const r = gregorian.addMonths(new Date(2025, 0, 10), -1); // Jan -> Dec prev year
			expect(r.getFullYear()).toBe(2024);
			expect(r.getMonth()).toBe(11);
		});

		test("addMonths(d, 0) is the start of the display month", () => {
			const r = gregorian.addMonths(new Date(2025, 5, 17), 0);
			expect(r.getTime()).toBe(new Date(2025, 5, 1).getTime());
		});

		test("round-trip: addMonths(d, n) then addMonths(., -n) returns the same display month", () => {
			fc.assert(
				fc.property(
					validDate(new Date(2000, 0, 1), new Date(2100, 0, 1)),
					fc.integer({ min: -36, max: 36 }),
					(d, n) => {
						const fwd = gregorian.addMonths(d, n);
						const back = gregorian.addMonths(fwd, -n);
						const start = gregorian.startOfDisplayMonth(d);
						return back.getTime() === start.getTime();
					}
				),
				{ numRuns: 300 }
			);
		});
	});

	describe("addYears", () => {
		test("adds whole years preserving the month, landing on day 1", () => {
			const r = gregorian.addYears(new Date(2025, 5, 17), 3);
			expect(r.getFullYear()).toBe(2028);
			expect(r.getMonth()).toBe(5);
			expect(r.getDate()).toBe(1);
		});

		test("subtracts years", () => {
			const r = gregorian.addYears(new Date(2025, 5, 17), -5);
			expect(r.getFullYear()).toBe(2020);
			expect(r.getMonth()).toBe(5);
		});

		test("round-trip: addYears(d, n) then addYears(., -n) is the same display month", () => {
			fc.assert(
				fc.property(
					validDate(new Date(1950, 0, 1), new Date(2100, 0, 1)),
					fc.integer({ min: -50, max: 50 }),
					(d, n) => {
						const back = gregorian.addYears(gregorian.addYears(d, n), -n);
						return back.getTime() === gregorian.startOfDisplayMonth(d).getTime();
					}
				),
				{ numRuns: 200 }
			);
		});
	});

	describe("monthsOfYear", () => {
		test("returns exactly 12 entries with ascending distinct months Jan..Dec", () => {
			const months = gregorian.monthsOfYear(new Date(2025, 5, 17));
			expect(months).toHaveLength(12);
			for (let i = 0; i < 12; i++) {
				expect(months[i]?.date.getFullYear()).toBe(2025);
				expect(months[i]?.date.getMonth()).toBe(i);
				expect(months[i]?.date.getDate()).toBe(1);
				expect(typeof months[i]?.label).toBe("string");
				expect(months[i]?.label.length).toBeGreaterThan(0);
			}
		});

		test("labels are distinct (12 different short month names)", () => {
			const labels = gregorian.monthsOfYear(new Date(2025, 0, 1)).map((e) => e.label);
			expect(new Set(labels).size).toBe(12);
		});
	});

	describe("yearsAround", () => {
		test("returns `count` entries centred on the date's year", () => {
			const cells = gregorian.yearsAround(new Date(2025, 5, 17), 12);
			expect(cells).toHaveLength(12);
			// half = floor(12/2) = 6, so first = 2025 - 6 = 2019.
			expect(cells[0]?.label).toBe("2019");
			expect(cells.at(-1)?.label).toBe("2030");
			// Labels must be strictly ascending consecutive years.
			for (let i = 0; i < cells.length; i++) {
				expect(cells[i]?.label).toBe(String(2019 + i));
				expect(cells[i]?.date.getFullYear()).toBe(2019 + i);
				expect(cells[i]?.date.getMonth()).toBe(5); // month preserved
				expect(cells[i]?.date.getDate()).toBe(1);
			}
		});

		test("odd count centres exactly (half rounds down)", () => {
			const cells = gregorian.yearsAround(new Date(2025, 0, 1), 5);
			// half = 2 -> first = 2023, last = 2027, centre index 2 = 2025.
			expect(cells.map((c) => c.label)).toEqual(["2023", "2024", "2025", "2026", "2027"]);
		});
	});

	describe("yearRangeLabel", () => {
		test("computes the inclusive range for an even count", () => {
			// half = floor(12/2) = 6; first = 2025 - 6 = 2019; last = 2019 + 12 - 1 = 2030.
			expect(gregorian.yearRangeLabel(new Date(2025, 0, 1), 12)).toBe("2019 – 2030");
		});

		test("computes the range for an odd count (centre = year)", () => {
			// half = 2; first = 2023; last = 2023 + 5 - 1 = 2027.
			expect(gregorian.yearRangeLabel(new Date(2025, 0, 1), 5)).toBe("2023 – 2027");
		});

		test("the range endpoints match yearsAround's first/last labels", () => {
			fc.assert(
				fc.property(
					fc.integer({ min: 2000, max: 2100 }),
					fc.integer({ min: 1, max: 30 }),
					(year, count) => {
						const date = new Date(year, 0, 1);
						const cells = gregorian.yearsAround(date, count);
						const range = gregorian.yearRangeLabel(date, count);
						const expected = `${cells[0]?.label} – ${cells.at(-1)?.label}`;
						return range === expected;
					}
				),
				{ numRuns: 200 }
			);
		});
	});
});

describe("hijri", () => {
	// A fixed reference date well inside an Umm al-Qura month.
	const ref = new Date(2025, 5, 15); // 1446-12-19 AH on this runtime

	describe("dayNumber", () => {
		test("matches the independent Umm al-Qura oracle", () => {
			expect(hijri.dayNumber(ref)).toBe(hijriParts(ref).d);
		});

		test("is always within 1..30 across a full sweep of dates (property)", () => {
			fc.assert(
				fc.property(validDate(new Date(1980, 0, 1), new Date(2090, 0, 1)), (d) => {
					const n = hijri.dayNumber(d);
					return n >= 1 && n <= 30;
				}),
				{ numRuns: 400 }
			);
		});
	});

	describe("labels", () => {
		test("monthLabel includes the Hijri year and is not a Gregorian month", () => {
			const label = hijri.monthLabel(ref);
			expect(label).toContain(String(hijriParts(ref).y));
			expect(label).not.toContain("June");
		});

		test("monthOnlyLabel omits the year", () => {
			const label = hijri.monthOnlyLabel(ref);
			expect(label).not.toContain(String(hijriParts(ref).y));
			expect(label.length).toBeGreaterThan(0);
		});

		test("yearLabel is the numeric Hijri year", () => {
			expect(hijri.yearLabel(ref)).toBe(String(hijriParts(ref).y));
		});
	});

	describe("isSameDisplayMonth", () => {
		test("true for two dates inside the same Hijri month", () => {
			const startOfMonth = hijri.startOfDisplayMonth(ref);
			// one day later is still the same Hijri month (months are >= 29 days)
			const nextDay = new Date(startOfMonth.getTime() + MS_PER_DAY);
			expect(hijri.isSameDisplayMonth(startOfMonth, nextDay)).toBe(true);
		});

		test("false across the Hijri month boundary", () => {
			const startOfMonth = hijri.startOfDisplayMonth(ref);
			const prevDay = new Date(startOfMonth.getTime() - MS_PER_DAY);
			// The day before a month-start belongs to the previous Hijri month.
			expect(hijri.isSameDisplayMonth(startOfMonth, prevDay)).toBe(false);
			// And the oracle agrees they differ in (y, m).
			const a = hijriParts(startOfMonth);
			const b = hijriParts(prevDay);
			expect(a.y === b.y && a.m === b.m).toBe(false);
		});

		test("false when only the year differs (same Hijri month index, +1 year)", () => {
			const nextYear = hijri.addYears(ref, 1);
			const refMonthStart = hijri.startOfDisplayMonth(ref);
			expect(hijri.isSameDisplayMonth(refMonthStart, nextYear)).toBe(false);
		});
	});

	describe("startOfDisplayMonth", () => {
		test("lands on Hijri day 1 of ref's month, at local midnight", () => {
			const s = hijri.startOfDisplayMonth(ref);
			expect(hijriParts(s).d).toBe(1);
			expect(hijriParts(s).m).toBe(hijriParts(ref).m);
			expect(hijriParts(s).y).toBe(hijriParts(ref).y);
			expect(s.getHours()).toBe(0);
			expect(s.getMinutes()).toBe(0);
			expect(s.getSeconds()).toBe(0);
		});

		test("idempotent: start of a month-start is itself", () => {
			const s = hijri.startOfDisplayMonth(ref);
			expect(hijri.startOfDisplayMonth(s).getTime()).toBe(s.getTime());
		});

		test("always yields Hijri day 1 (property)", () => {
			fc.assert(
				fc.property(
					validDate(new Date(1990, 0, 1), new Date(2080, 0, 1)),
					(d) => hijriParts(hijri.startOfDisplayMonth(d)).d === 1
				),
				{ numRuns: 300 }
			);
		});
	});

	describe("addMonths", () => {
		test("addMonths(d, 0) == startOfDisplayMonth(d)", () => {
			expect(hijri.addMonths(ref, 0).getTime()).toBe(hijri.startOfDisplayMonth(ref).getTime());
		});

		test("addMonths(d, 1) advances exactly one Hijri month and lands on day 1", () => {
			const start = hijri.startOfDisplayMonth(ref);
			const next = hijri.addMonths(ref, 1);
			expect(hijriParts(next).d).toBe(1);
			// Month index advances by 1 (mod 12 across the year boundary).
			const sp = hijriParts(start);
			const np = hijriParts(next);
			const expectedMonth = sp.m === 12 ? 1 : sp.m + 1;
			const expectedYear = sp.m === 12 ? sp.y + 1 : sp.y;
			expect(np.m).toBe(expectedMonth);
			expect(np.y).toBe(expectedYear);
		});

		test("addMonths(d, -1) goes back exactly one Hijri month", () => {
			const start = hijri.startOfDisplayMonth(ref);
			const prev = hijri.addMonths(ref, -1);
			expect(hijriParts(prev).d).toBe(1);
			const sp = hijriParts(start);
			const pp = hijriParts(prev);
			const expectedMonth = sp.m === 1 ? 12 : sp.m - 1;
			const expectedYear = sp.m === 1 ? sp.y - 1 : sp.y;
			expect(pp.m).toBe(expectedMonth);
			expect(pp.y).toBe(expectedYear);
		});

		test("addMonths(d, 1) then addMonths(., -1) returns the SAME display month", () => {
			const back = hijri.addMonths(hijri.addMonths(ref, 1), -1);
			expect(back.getTime()).toBe(hijri.startOfDisplayMonth(ref).getTime());
		});

		test("round-trip addMonths(d,n) then -n returns the same display month (property)", () => {
			fc.assert(
				fc.property(
					validDate(new Date(2000, 0, 1), new Date(2060, 0, 1)),
					fc.integer({ min: -24, max: 24 }),
					(d, n) => {
						const fwd = hijri.addMonths(d, n);
						const back = hijri.addMonths(fwd, -n);
						return back.getTime() === hijri.startOfDisplayMonth(d).getTime();
					}
				),
				{ numRuns: 150 }
			);
		});

		test("walking N months forward equals N single steps (associativity of the walker)", () => {
			let stepwise = hijri.startOfDisplayMonth(ref);
			for (let i = 0; i < 14; i++) {
				stepwise = hijri.addMonths(stepwise, 1);
			}
			const direct = hijri.addMonths(ref, 14);
			expect(direct.getTime()).toBe(stepwise.getTime());
		});

		test("each consecutive month-start is 29 or 30 Gregorian days apart", () => {
			let cur = hijri.startOfDisplayMonth(ref);
			for (let i = 0; i < 24; i++) {
				const next = hijri.addMonths(cur, 1);
				const days = Math.round((next.getTime() - cur.getTime()) / MS_PER_DAY);
				expect(days === 29 || days === 30).toBe(true);
				cur = next;
			}
		});
	});

	describe("addYears", () => {
		test("addYears(d, 1) advances the Hijri year by exactly one, same month index", () => {
			const start = hijri.startOfDisplayMonth(ref);
			const nextYear = hijri.addYears(ref, 1);
			const sp = hijriParts(start);
			const np = hijriParts(nextYear);
			expect(np.y).toBe(sp.y + 1);
			expect(np.m).toBe(sp.m);
			expect(np.d).toBe(1);
		});

		test("addYears is addMonths(., n*12)", () => {
			expect(hijri.addYears(ref, 2).getTime()).toBe(hijri.addMonths(ref, 24).getTime());
			expect(hijri.addYears(ref, -3).getTime()).toBe(hijri.addMonths(ref, -36).getTime());
		});
	});

	describe("monthsOfYear", () => {
		test("returns 12 entries, all Hijri day 1, months 1..12 ascending, all same Hijri year", () => {
			const months = hijri.monthsOfYear(ref);
			expect(months).toHaveLength(12);
			const firstYear = hijriParts(months[0]?.date as Date).y;
			for (let i = 0; i < 12; i++) {
				const p = hijriParts(months[i]?.date as Date);
				expect(p.d).toBe(1); // every cell is the start of its month
				expect(p.m).toBe(i + 1); // ascending 1..12
				expect(p.y).toBe(firstYear); // all in the same Hijri year
				expect(months[i]?.label.length).toBeGreaterThan(0);
			}
		});

		test("first cell is Muharram (month 1) regardless of where in the year ref lands", () => {
			// ref is in month 12; monthsOfYear should still start at month 1.
			const months = hijri.monthsOfYear(ref);
			expect(hijriParts(months[0]?.date as Date).m).toBe(1);
		});

		test("the 12 month-start dates are strictly increasing in time", () => {
			const months = hijri.monthsOfYear(ref);
			for (let i = 1; i < months.length; i++) {
				expect((months[i]?.date as Date).getTime()).toBeGreaterThan(
					(months[i - 1]?.date as Date).getTime()
				);
			}
		});

		test("starts at month 1 for several different anchor dates (property)", () => {
			fc.assert(
				fc.property(validDate(new Date(2000, 0, 1), new Date(2060, 0, 1)), (d) => {
					const months = hijri.monthsOfYear(d);
					return months.length === 12 && hijriParts(months[0]?.date as Date).m === 1;
				}),
				{ numRuns: 120 }
			);
		});
	});

	describe("yearLabel / yearRangeLabel", () => {
		test("yearRangeLabel centres on the Hijri year (even count)", () => {
			const anchorYear = hijriParts(ref).y;
			// half = floor(12/2) = 6 -> first = anchorYear - 6, last = first + 11.
			const first = anchorYear - 6;
			expect(hijri.yearRangeLabel(ref, 12)).toBe(`${first} – ${first + 11}`);
		});

		test("yearRangeLabel for odd count", () => {
			const anchorYear = hijriParts(ref).y;
			const first = anchorYear - 2; // half = 2
			expect(hijri.yearRangeLabel(ref, 5)).toBe(`${first} – ${first + 4}`);
		});
	});

	describe("yearsAround", () => {
		test("returns `count` labels of consecutive Hijri years centred on ref", () => {
			const anchorYear = hijriParts(ref).y;
			const cells = hijri.yearsAround(ref, 12);
			expect(cells).toHaveLength(12);
			// half = 6 -> labels run anchorYear-6 .. anchorYear+5.
			for (let i = 0; i < 12; i++) {
				expect(cells[i]?.label).toBe(String(anchorYear - 6 + i));
			}
		});

		test("the centre cell (yearOffset 0) carries the mid-year anchor in the anchor's Hijri year", () => {
			const anchorYear = hijriParts(ref).y;
			const cells = hijri.yearsAround(ref, 11); // half = 5, centre index = 5
			const centre = cells[5];
			expect(centre?.label).toBe(String(anchorYear));
			// The Gregorian anchor date must resolve to the SAME Hijri year as its label.
			expect(hijriParts(centre?.date as Date).y).toBe(anchorYear);
		});

		test("every cell's Gregorian anchor falls inside the Hijri year of its label (drift guard)", () => {
			// This is the core promise of yearsAround: the cheap ~354-day shift must
			// keep each anchor inside the target Hijri year over the typical span.
			const cells = hijri.yearsAround(ref, 13); // ±6 years
			for (const cell of cells) {
				const labelYear = Number.parseInt(cell.label, 10);
				expect(hijriParts(cell.date).y).toBe(labelYear);
			}
		});

		test("labels are strictly ascending consecutive Hijri years", () => {
			const cells = hijri.yearsAround(ref, 9);
			for (let i = 1; i < cells.length; i++) {
				expect(Number.parseInt(cells[i]?.label ?? "0", 10)).toBe(
					Number.parseInt(cells[i - 1]?.label ?? "0", 10) + 1
				);
			}
		});

		test("yearsAround anchors stay inside their label-year across many ref dates (property)", () => {
			fc.assert(
				fc.property(validDate(new Date(2005, 0, 1), new Date(2055, 0, 1)), (d) => {
					const cells = hijri.yearsAround(d, 13);
					return cells.every((c) => hijriParts(c.date).y === Number.parseInt(c.label, 10));
				}),
				{ numRuns: 120 }
			);
		});
	});

	describe("parts cache", () => {
		test("repeated queries on the same epoch-day return a consistent day number", () => {
			// Exercises the memoization path (second call hits the cache).
			const sameDayLater = new Date(ref.getTime() + 1000 * 60 * 5); // +5 min, same epoch-day
			expect(hijri.dayNumber(sameDayLater)).toBe(hijri.dayNumber(ref));
		});

		test("the cache survives a large sweep without corrupting results past the FIFO limit", () => {
			// Touch well over HIJRI_PARTS_CACHE_LIMIT (4096) distinct epoch-days so the
			// eviction branch runs, then re-verify an early date is still correct.
			const base = new Date(2000, 0, 1);
			const expected = hijriParts(base).d;
			for (let i = 0; i < 4200; i++) {
				hijri.dayNumber(new Date(base.getTime() + i * MS_PER_DAY));
			}
			// base was evicted; recomputed value must still match the oracle.
			expect(hijri.dayNumber(base)).toBe(expected);
		});
	});
});

describe("cross-system contract parity", () => {
	test("both systems return 12 months and `count` year cells for the same inputs", () => {
		for (const sys of [gregorian, hijri]) {
			expect(sys.monthsOfYear(new Date(2025, 5, 15))).toHaveLength(12);
			expect(sys.yearsAround(new Date(2025, 5, 15), 8)).toHaveLength(8);
		}
	});

	test("startOfDisplayMonth returns a date whose own start-of-month is itself (idempotent)", () => {
		for (const sys of [gregorian, hijri]) {
			const s = sys.startOfDisplayMonth(new Date(2025, 5, 15, 9, 30));
			expect(sys.startOfDisplayMonth(s).getTime()).toBe(s.getTime());
		}
	});
});
