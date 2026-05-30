import { describe, expect, test } from "bun:test";
import {
	gridSpeedToInterval,
	isVisualizerType,
	resolveVisualizerConfig,
	VISUALIZER_TYPES,
	type VisualizerType,
} from "./audio-visualizer";

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

describe("gridSpeedToInterval", () => {
	test("speed 6 reproduces the previous 100 ms tick", () => {
		expect(gridSpeedToInterval(6)).toBe(100);
	});

	test("higher speed → shorter interval", () => {
		expect(gridSpeedToInterval(10)).toBe(60);
	});

	test("lower speed → longer interval", () => {
		expect(gridSpeedToInterval(1)).toBe(600);
	});

	test("guards against non-positive speed (falls back to 6)", () => {
		expect(gridSpeedToInterval(0)).toBe(100);
		expect(gridSpeedToInterval(-3)).toBe(100);
	});
});

describe("resolveVisualizerConfig", () => {
	test("undefined input yields the shipped defaults", () => {
		expect(resolveVisualizerConfig(undefined)).toEqual({
			barCount: 9,
			radialDotCount: 24,
			radialRadiusPct: 57,
			gridRows: 5,
			gridColumns: 5,
			gridInterval: 100,
			waveLineWidth: 2,
			waveBlur: 0.5,
			waveColorShift: 0.05,
			auraShape: "circle",
			auraBlur: 0.2,
			auraBloom: 0,
			auraColorShift: 0.05,
		});
	});

	test("converts percent knobs to 0–1 shader units", () => {
		const cfg = resolveVisualizerConfig({
			visualizerWaveSmoothing: 100,
			visualizerWaveColorShift: 0,
			visualizerAuraBlur: 50,
			visualizerAuraBloom: 40,
			visualizerAuraColorShift: 30,
		});
		expect(cfg.waveBlur).toBe(1);
		expect(cfg.waveColorShift).toBe(0);
		expect(cfg.auraBlur).toBe(0.5);
		expect(cfg.auraBloom).toBeCloseTo(0.4, 5);
		expect(cfg.auraColorShift).toBeCloseTo(0.3, 5);
	});

	test("maps grid speed through gridSpeedToInterval and passes scalars through", () => {
		const cfg = resolveVisualizerConfig({
			visualizerGridSpeed: 10,
			visualizerRadialDotCount: 12,
			visualizerRadialRadius: 40,
			visualizerBarCount: 15,
			visualizerAuraShape: "line",
		});
		expect(cfg.gridInterval).toBe(60);
		expect(cfg.radialDotCount).toBe(12);
		expect(cfg.radialRadiusPct).toBe(40);
		expect(cfg.barCount).toBe(15);
		expect(cfg.auraShape).toBe("line");
	});
});
