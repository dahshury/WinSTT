import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
	surfaceActivePseudoBg,
	surfaceBg,
	surfaceBg90,
	surfaceCheckedBg,
	surfaceClasses,
	surfaceHighlightedBg,
	surfaceHoverBg,
	surfacePopupOpenBg,
	surfaceSelectedBg,
	surfaceShadow,
} from "./surface-classes";

const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

// Each accessor maps level N to a `<prefix>surface-N<suffix>` Tailwind class.
const ACCESSORS: ReadonlyArray<{
	name: string;
	fn: (level: number) => string;
	cls: (n: number) => string;
}> = [
	{ name: "surfaceBg", fn: surfaceBg, cls: (n) => `bg-surface-${n}` },
	{
		name: "surfaceShadow",
		fn: surfaceShadow,
		cls: (n) => `shadow-surface-${n}`,
	},
	{
		name: "surfaceHoverBg",
		fn: surfaceHoverBg,
		cls: (n) => `hover:bg-surface-${n}`,
	},
	{
		name: "surfaceHighlightedBg",
		fn: surfaceHighlightedBg,
		cls: (n) => `data-[highlighted]:bg-surface-${n}`,
	},
	{
		name: "surfaceCheckedBg",
		fn: surfaceCheckedBg,
		cls: (n) => `data-[checked]:bg-surface-${n}`,
	},
	{
		name: "surfaceSelectedBg",
		fn: surfaceSelectedBg,
		cls: (n) => `data-[selected]:bg-surface-${n}`,
	},
	{
		name: "surfacePopupOpenBg",
		fn: surfacePopupOpenBg,
		cls: (n) => `data-[popup-open]:bg-surface-${n}`,
	},
	{ name: "surfaceBg90", fn: surfaceBg90, cls: (n) => `bg-surface-${n}/90` },
	{
		name: "surfaceActivePseudoBg",
		fn: surfaceActivePseudoBg,
		cls: (n) => `active:bg-surface-${n}`,
	},
];

describe("surface accessors — exact mapping for in-range levels", () => {
	for (const { name, fn, cls } of ACCESSORS) {
		test(`${name} returns the exact class for each level 1..8`, () => {
			for (const level of LEVELS) {
				expect(fn(level)).toBe(cls(level));
			}
		});
	}
});

describe("clamp behaviour (via the public accessors)", () => {
	test("levels below 1 clamp up to 1", () => {
		expect(surfaceBg(0)).toBe("bg-surface-1");
		expect(surfaceBg(-5)).toBe("bg-surface-1");
		expect(surfaceShadow(0.4)).toBe("shadow-surface-1"); // rounds to 0 then clamps to 1
	});

	test("levels above 8 clamp down to 8", () => {
		expect(surfaceBg(9)).toBe("bg-surface-8");
		expect(surfaceBg(1000)).toBe("bg-surface-8");
		expect(surfaceHoverBg(8.6)).toBe("hover:bg-surface-8"); // rounds to 9 then clamps to 8
	});

	test("fractional levels round to the nearest integer level", () => {
		expect(surfaceBg(2.4)).toBe("bg-surface-2");
		expect(surfaceBg(2.5)).toBe("bg-surface-3"); // Math.round: .5 rounds up
		expect(surfaceBg(6.5)).toBe("bg-surface-7");
	});

	test("non-finite input (NaN/Infinity) clamps to the base surface-1", () => {
		// Regression guard for the fixed NaN bug: clamp() now short-circuits
		// non-finite levels to 1 so a bad computed prop / Number(<non-numeric>)
		// degrades to a real surface instead of leaking an unresolvable
		// `bg-undefined` Tailwind class.
		expect(surfaceBg(Number.NaN)).toBe("bg-surface-1");
		expect(surfaceShadow(Number.NaN)).toBe("shadow-surface-1");
		expect(surfaceBg(Number.POSITIVE_INFINITY)).toBe("bg-surface-1");
		expect(surfaceBg(Number.NEGATIVE_INFINITY)).toBe("bg-surface-1");
	});

	test("NaN level reaching surfaceClasses yields valid base-surface classes", () => {
		// Was "undefined undefined" (broken) before the clamp NaN guard.
		expect(surfaceClasses(Number.NaN)).toBe("bg-surface-1 shadow-surface-1");
	});
});

describe("surfaceClasses (composite bg + shadow)", () => {
	test("combines bg and shadow at the same level when shadow omitted", () => {
		expect(surfaceClasses(3)).toBe("bg-surface-3 shadow-surface-3");
	});

	test("uses a distinct shadow level when supplied", () => {
		expect(surfaceClasses(2, 5)).toBe("bg-surface-2 shadow-surface-5");
	});

	test("clamps bg and shadow independently", () => {
		expect(surfaceClasses(0, 99)).toBe("bg-surface-1 shadow-surface-8");
		expect(surfaceClasses(99, 0)).toBe("bg-surface-8 shadow-surface-1");
	});

	test("explicit shadowLevel of 0 is honored, not treated as 'missing' (would default to bgLevel)", () => {
		// 0 is falsy but the default is a parameter default, so an explicit 0 stays 0 → clamps to 1.
		expect(surfaceClasses(5, 0)).toBe("bg-surface-5 shadow-surface-1");
	});
});

describe("property: every accessor output is a valid surface class for any real level", () => {
	test("accessors always yield a `surface-<1..8>` class for finite inputs", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: -1000, max: 1000 }),
				fc.constantFrom(...ACCESSORS),
				(level, accessor) => {
					const out = accessor.fn(level);
					// The clamped level embedded in the class is always 1..8.
					return (
						/surface-[1-8](\/90)?\b/.test(out) && !out.includes("undefined")
					);
				},
			),
			{ numRuns: 400 },
		);
	});

	test("monotone clamp: a larger input never yields a lower surface level", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: -50, max: 50 }),
				fc.integer({ min: -50, max: 50 }),
				(a, b) => {
					const lo = Math.min(a, b);
					const hi = Math.max(a, b);
					const levelLo = Number(surfaceBg(lo).replace("bg-surface-", ""));
					const levelHi = Number(surfaceBg(hi).replace("bg-surface-", ""));
					return levelHi >= levelLo;
				},
			),
			{ numRuns: 400 },
		);
	});
});
