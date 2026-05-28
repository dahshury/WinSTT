import { describe, expect, test } from "bun:test";
import { fontWeights } from "./font-weight";

describe("fontWeights", () => {
	test("exposes the three named weights used across the renderer", () => {
		expect(Object.keys(fontWeights).sort()).toEqual(["medium", "normal", "semibold"]);
	});

	test("each value is a CSS font-variation-settings string targeting the `wght` axis", () => {
		for (const value of Object.values(fontWeights)) {
			// Shape: `"wght" <number>` — what font-variation-settings expects.
			expect(value).toMatch(/^"wght" \d+$/);
		}
	});

	test("named weights map to their canonical numeric axis values (ascending)", () => {
		expect(fontWeights.normal).toBe('"wght" 400');
		expect(fontWeights.medium).toBe('"wght" 500');
		expect(fontWeights.semibold).toBe('"wght" 600');
	});

	test("the numeric axis values are strictly increasing normal < medium < semibold", () => {
		const weightOf = (v: string): number => Number(v.replace(/^"wght" /, ""));
		expect(weightOf(fontWeights.normal)).toBeLessThan(weightOf(fontWeights.medium));
		expect(weightOf(fontWeights.medium)).toBeLessThan(weightOf(fontWeights.semibold));
	});
});
