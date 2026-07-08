import { describe, expect, test } from "bun:test";
import { exitFallbackMs, springs } from "./springs";

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

	test("fast and moderate are critically damped; only slow carries bounce", () => {
		expect(springs.fast.bounce).toBe(0);
		expect(springs.moderate.bounce).toBe(0);
		expect(springs.slow.bounce).toBeGreaterThan(0);
	});

	test("exits are quicker than their entrances", () => {
		expect(springs.fast.exit.duration).toBeLessThan(springs.fast.duration);
		expect(springs.moderate.exit.duration).toBeLessThan(
			springs.moderate.duration,
		);
		expect(springs.slow.exit.duration).toBeLessThan(springs.slow.duration);
	});

	test("exitFallbackMs adds a safety buffer past the exit tween", () => {
		expect(exitFallbackMs(springs.fast)).toBe(160);
		expect(exitFallbackMs(springs.moderate)).toBe(220);
		expect(exitFallbackMs(springs.slow)).toBe(260);
	});
});
