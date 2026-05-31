import { describe, expect, test } from "bun:test";
import { colorForSpeaker } from "./speaker-color";

describe("colorForSpeaker", () => {
	test("returns 'currentColor' sentinel for negative speaker ids (muted)", () => {
		// Locks the negative-id branch — the server uses -1 for "no diarization".
		expect(colorForSpeaker(-1)).toBe("currentColor");
		expect(colorForSpeaker(-5)).toBe("currentColor");
	});

	test("maps speaker 0 to the first palette entry (sky-400)", () => {
		expect(colorForSpeaker(0)).toBe("#38bdf8");
	});

	test("returns distinct colors for the first 8 speakers (full palette)", () => {
		// Locks each palette slot — a mutation that swaps two would
		// surface here as a collision or shuffled order.
		const colors = Array.from({ length: 8 }, (_, i) => colorForSpeaker(i));
		expect(colors).toEqual([
			"#38bdf8",
			"#fb923c",
			"#34d399",
			"#f472b6",
			"#facc15",
			"#a78bfa",
			"#fb7185",
			"#22d3ee",
		]);
		// No collisions among the first 8 ids.
		expect(new Set(colors).size).toBe(8);
	});

	test("wraps the palette modulo 8 for speakers beyond the palette length", () => {
		// Speaker 8 should reuse speaker 0's color, 9 reuses 1's, etc.
		expect(colorForSpeaker(8)).toBe(colorForSpeaker(0));
		expect(colorForSpeaker(9)).toBe(colorForSpeaker(1));
		expect(colorForSpeaker(16)).toBe(colorForSpeaker(0));
	});
});
