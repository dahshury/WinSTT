import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { hexToRgb } from "./hex-to-rgb";

const hexByte = () => fc.integer({ min: 0, max: 255 }).map((n) => n.toString(16).padStart(2, "0"));

const hexColor = () =>
	fc.tuple(hexByte(), hexByte(), hexByte()).map(([r, g, b]) => `#${r}${g}${b}`);

describe("hexToRgb (property-based)", () => {
	test("all components are in [0, 1] for any valid hex input", () => {
		fc.assert(
			fc.property(hexColor(), (hex) => {
				const [r, g, b] = hexToRgb(hex);
				return r >= 0 && r <= 1 && g >= 0 && g <= 1 && b >= 0 && b <= 1;
			}),
			{ numRuns: 300 }
		);
	});

	test("all components in [0, 1] for ANY string input (valid or malformed → fallback)", () => {
		fc.assert(
			fc.property(fc.string(), (s) => {
				const [r, g, b] = hexToRgb(s);
				return r >= 0 && r <= 1 && g >= 0 && g <= 1 && b >= 0 && b <= 1;
			}),
			{ numRuns: 300 }
		);
	});

	test("case-insensitive: lowercase and uppercase hex parse identically", () => {
		fc.assert(
			fc.property(hexColor(), (hex) => {
				const lower = hex.toLowerCase();
				const upper = hex.toUpperCase();
				const a = hexToRgb(lower);
				const b = hexToRgb(upper);
				return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
			}),
			{ numRuns: 300 }
		);
	});

	test("white #ffffff (any case) is always [1, 1, 1]", () => {
		fc.assert(
			fc.property(fc.constantFrom("#ffffff", "#FFFFFF", "#FfFfFf", "#fFfFfF"), (hex) => {
				const [r, g, b] = hexToRgb(hex);
				return r === 1 && g === 1 && b === 1;
			}),
			{ numRuns: 200 }
		);
	});

	test("black #000000 is always [0, 0, 0]", () => {
		const [r, g, b] = hexToRgb("#000000");
		expect(r).toBe(0);
		expect(g).toBe(0);
		expect(b).toBe(0);
	});

	test("deterministic: same input → same output across calls", () => {
		fc.assert(
			fc.property(fc.string(), (s) => {
				const a = hexToRgb(s);
				const b = hexToRgb(s);
				return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
			}),
			{ numRuns: 200 }
		);
	});
});
