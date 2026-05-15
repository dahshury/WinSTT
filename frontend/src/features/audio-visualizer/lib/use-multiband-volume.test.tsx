import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { useVisualizerStore } from "../model/visualizer-store";
import {
	computeAmplified,
	computeBandValue,
	PEAK_DECAY,
	PEAK_FLOOR,
	SILENCE_THRESHOLD,
	useMultibandVolume,
} from "./use-multiband-volume";

beforeEach(() => {
	useVisualizerStore.setState({ audioLevel: 0 });
});

afterEach(() => {
	useVisualizerStore.setState({ audioLevel: 0 });
});

describe("useMultibandVolume", () => {
	test("returns an array of length N initialized to zeros", () => {
		const { result } = renderHook(() => useMultibandVolume(8));
		expect(result.current).toHaveLength(8);
		expect(result.current.every((v) => v === 0)).toBe(true);
	});

	test("returns an empty-band array for N=0", () => {
		const { result } = renderHook(() => useMultibandVolume(0));
		expect(result.current).toHaveLength(0);
	});

	test("each band starts at 0 (silent baseline)", () => {
		const { result } = renderHook(() => useMultibandVolume(4));
		expect(result.current).toEqual([0, 0, 0, 0]);
	});
});

describe("computeAmplified", () => {
	test("peak is at least PEAK_FLOOR", () => {
		const { peak } = computeAmplified(0.001, PEAK_FLOOR);
		expect(peak).toBeGreaterThanOrEqual(PEAK_FLOOR);
	});

	test("peak grows to match loud audio level", () => {
		const loudLevel = 0.8;
		const { peak } = computeAmplified(loudLevel, PEAK_FLOOR);
		expect(peak).toBe(loudLevel); // max(PEAK_FLOOR, 0.8, PEAK_FLOOR*0.99) = 0.8
	});

	test("peak decays slowly when audio is quiet", () => {
		const prevPeak = 0.5;
		const quietLevel = 0.001;
		const { peak } = computeAmplified(quietLevel, prevPeak);
		// peak = max(PEAK_FLOOR, 0.001, 0.5*PEAK_DECAY) = max(0.1, 0.001, 0.495) = 0.495
		expect(peak).toBeCloseTo(prevPeak * PEAK_DECAY, 5);
	});

	test("amplified is between 0 and 1", () => {
		const { amplified } = computeAmplified(0.5, 0.5);
		expect(amplified).toBeGreaterThanOrEqual(0);
		expect(amplified).toBeLessThanOrEqual(1);
	});

	test("amplified = 1 when audioLevel equals peak (full loudness)", () => {
		const level = 0.5;
		// peak = max(0.1, 0.5, 0.5*0.99) = 0.5; sqrt(min(1, 0.5/0.5)) = sqrt(1) = 1
		const { amplified } = computeAmplified(level, level);
		expect(amplified).toBe(1);
	});
});

describe("computeBandValue", () => {
	test("returns a value in [0.05, 1]", () => {
		for (let i = 0; i < 8; i++) {
			const v = computeBandValue(i, 8, 0, 0.5);
			expect(v).toBeGreaterThanOrEqual(0.05);
			expect(v).toBeLessThanOrEqual(1);
		}
	});

	test("minimum value is 0.05 (floor) even with zero amplified", () => {
		// When amplified=0, the formula is max(0.05, min(1, 0*(0.8+v1+v2+v3))) = 0.05
		const v = computeBandValue(0, 8, 0, 0);
		expect(v).toBe(0.05);
	});

	test("maximum value is 1 (ceiling) with very high amplified", () => {
		// When amplified=100, formula clamps to 1.0 for any phase combination
		const v = computeBandValue(0, 8, 0, 100);
		expect(v).toBe(1);
	});

	test("returns consistent result for the same inputs", () => {
		const v1 = computeBandValue(3, 8, 1.5, 0.7);
		const v2 = computeBandValue(3, 8, 1.5, 0.7);
		expect(v1).toBe(v2);
	});
});

describe("module constants", () => {
	test("PEAK_FLOOR is a positive number below 1", () => {
		expect(PEAK_FLOOR).toBeGreaterThan(0);
		expect(PEAK_FLOOR).toBeLessThan(1);
	});

	test("PEAK_DECAY is close to 1 (slow decay)", () => {
		expect(PEAK_DECAY).toBeGreaterThan(0.9);
		expect(PEAK_DECAY).toBeLessThan(1);
	});

	test("SILENCE_THRESHOLD is a small positive number", () => {
		expect(SILENCE_THRESHOLD).toBeGreaterThan(0);
		expect(SILENCE_THRESHOLD).toBeLessThan(0.1);
	});
});
