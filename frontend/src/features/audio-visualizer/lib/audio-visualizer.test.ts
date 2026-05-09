import { describe, expect, test } from "bun:test";
import { isVisualizerType, VISUALIZER_TYPES, type VisualizerType } from "./audio-visualizer";

describe("VISUALIZER_TYPES", () => {
	test("contains the canonical five visualizer types", () => {
		const expected: VisualizerType[] = ["aura", "bar", "grid", "radial", "wave"];
		expect(VISUALIZER_TYPES.toSorted()).toEqual(expected.toSorted());
	});
});

describe("isVisualizerType", () => {
	test("returns true for every known type", () => {
		for (const type of VISUALIZER_TYPES) {
			expect(isVisualizerType(type)).toBe(true);
		}
	});

	test("returns false for unknown strings", () => {
		expect(isVisualizerType("spinner")).toBe(false);
		expect(isVisualizerType("")).toBe(false);
		expect(isVisualizerType("BAR")).toBe(false); // case-sensitive
	});
});
