import { describe, expect, test } from "bun:test";
import { springs } from "./springs";

describe("springs", () => {
	test("every preset is a spring", () => {
		expect(springs.fast.type).toBe("spring");
		expect(springs.moderate.type).toBe("spring");
		expect(springs.slow.type).toBe("spring");
	});

	test("durations increase fast → moderate → slow", () => {
		expect(springs.fast.duration).toBeGreaterThan(0);
		expect(springs.moderate.duration).toBeGreaterThan(springs.fast.duration);
		expect(springs.slow.duration).toBeGreaterThan(springs.moderate.duration);
	});

	test("fast has no overshoot; moderate and slow carry a slight bounce", () => {
		expect(springs.fast.bounce).toBe(0);
		expect(springs.moderate.bounce).toBeGreaterThan(0);
		expect(springs.slow.bounce).toBeGreaterThan(0);
	});
});
