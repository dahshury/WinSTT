import { describe, expect, test } from "bun:test";
import { Z_INDEX } from "./z-index";

describe("Z_INDEX scale", () => {
	test("has all five named layers", () => {
		expect(Z_INDEX).toHaveProperty("SIDEBAR_INDICATOR");
		expect(Z_INDEX).toHaveProperty("MODAL");
		expect(Z_INDEX).toHaveProperty("POPOVER");
		expect(Z_INDEX).toHaveProperty("CONFIRM_DIALOG");
		expect(Z_INDEX).toHaveProperty("NOISE_OVERLAY");
	});

	test("layers are ordered lowest to highest as documented", () => {
		expect(Z_INDEX.SIDEBAR_INDICATOR).toBeLessThan(Z_INDEX.MODAL);
		expect(Z_INDEX.MODAL).toBeLessThan(Z_INDEX.POPOVER);
		expect(Z_INDEX.POPOVER).toBeLessThan(Z_INDEX.CONFIRM_DIALOG);
		expect(Z_INDEX.CONFIRM_DIALOG).toBeLessThan(Z_INDEX.NOISE_OVERLAY);
	});

	test("all values are positive integers", () => {
		for (const value of Object.values(Z_INDEX)) {
			expect(Number.isInteger(value)).toBe(true);
			expect(value).toBeGreaterThan(0);
		}
	});
});
