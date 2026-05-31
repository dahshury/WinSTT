import { describe, expect, test } from "bun:test";
import {
	RECORDING_MODE_COLOR_HEX,
	RECORDING_MODE_COLOR_RGB,
	type RecordingMode,
} from "./recording-mode-color";

const MODES: readonly RecordingMode[] = ["ptt", "toggle", "listen", "wakeword"];

describe("RECORDING_MODE_COLOR_HEX", () => {
	test("has exactly one entry per recording mode (no extras, none missing)", () => {
		expect(Object.keys(RECORDING_MODE_COLOR_HEX).sort()).toEqual([...MODES].sort());
	});

	test("every value is a 6-digit lowercase hex color usable as a CSS color", () => {
		for (const mode of MODES) {
			expect(RECORDING_MODE_COLOR_HEX[mode]).toMatch(/^#[0-9a-f]{6}$/);
		}
	});

	test("colors are distinct so the four modes are visually distinguishable", () => {
		const values = MODES.map((m) => RECORDING_MODE_COLOR_HEX[m]);
		expect(new Set(values).size).toBe(MODES.length);
	});

	test("documented per-mode hex values are pinned (tray/visualizer/switcher must agree)", () => {
		expect(RECORDING_MODE_COLOR_HEX.ptt).toBe("#3b82f6");
		expect(RECORDING_MODE_COLOR_HEX.toggle).toBe("#facc15");
		expect(RECORDING_MODE_COLOR_HEX.listen).toBe("#22c55e");
		expect(RECORDING_MODE_COLOR_HEX.wakeword).toBe("#f97316");
	});
});

describe("RECORDING_MODE_COLOR_RGB", () => {
	test("has exactly one entry per recording mode", () => {
		expect(Object.keys(RECORDING_MODE_COLOR_RGB).sort()).toEqual([...MODES].sort());
	});

	test("each entry is a 3-tuple of integers in the valid 0..255 byte range", () => {
		for (const mode of MODES) {
			const triple = RECORDING_MODE_COLOR_RGB[mode];
			expect(triple).toHaveLength(3);
			for (const channel of triple) {
				expect(Number.isInteger(channel)).toBe(true);
				expect(channel).toBeGreaterThanOrEqual(0);
				expect(channel).toBeLessThanOrEqual(255);
			}
		}
	});

	test("RGB triples decode to the exact same color as the HEX map (single source of truth)", () => {
		for (const mode of MODES) {
			const hex = RECORDING_MODE_COLOR_HEX[mode];
			const [r, g, b] = RECORDING_MODE_COLOR_RGB[mode];
			const fromRgb = `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
			expect(fromRgb).toBe(hex);
		}
	});
});
