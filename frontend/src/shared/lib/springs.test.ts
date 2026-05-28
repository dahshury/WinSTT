import { describe, expect, test } from "bun:test";
import { springs } from "./springs";

describe("springs", () => {
	test("exposes the two named presets used across motion components", () => {
		expect(Object.keys(springs).sort()).toEqual(["fast", "moderate"]);
	});

	test("every preset is a spring transition with finite positive physical params", () => {
		for (const preset of Object.values(springs)) {
			expect(preset.type).toBe("spring");
			// stiffness / damping / mass must be finite positive numbers or the
			// motion solver produces NaN / non-terminating animations.
			expect(Number.isFinite(preset.stiffness)).toBe(true);
			expect(preset.stiffness).toBeGreaterThan(0);
			expect(Number.isFinite(preset.damping)).toBe(true);
			expect(preset.damping).toBeGreaterThan(0);
			expect(Number.isFinite(preset.mass)).toBe(true);
			expect(preset.mass).toBeGreaterThan(0);
		}
	});

	test("documented preset values are pinned", () => {
		expect(springs.fast).toEqual({ type: "spring", stiffness: 500, damping: 32, mass: 1 });
		expect(springs.moderate).toEqual({ type: "spring", stiffness: 300, damping: 28, mass: 1 });
	});

	test("`fast` is stiffer than `moderate` (the names must reflect the physics)", () => {
		expect(springs.fast.stiffness).toBeGreaterThan(springs.moderate.stiffness);
	});
});
