import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
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

	test("rAF loop emits non-zero bands when audio is present", async () => {
		useVisualizerStore.setState({ audioLevel: 0.6 });
		const { result, unmount } = renderHook(() => useMultibandVolume(6));
		// happy-dom shims requestAnimationFrame onto setTimeout; yield a few
		// macrotasks so the `update` loop runs the audible branch (lines 91-101)
		// and writes a fresh band array via setVolumes. The audible branch
		// self-reschedules forever, so we DON'T wrap the wait in act() (which
		// would never quiesce) — we just poll then unmount to stop the loop.
		await new Promise((r) => setTimeout(r, 60));
		expect(result.current).toHaveLength(6);
		expect(result.current.some((v) => v > 0)).toBe(true);
		unmount();
	});

	test("silence after audio reallocates a fresh zero array (non-zero prev branch)", async () => {
		// First produce a non-zero frame, then drop to silence so the
		// setVolumes updater's `prev.every(v => v === 0)` is FALSE and it must
		// return `new Array(n).fill(0)` (the reallocation branch).
		useVisualizerStore.setState({ audioLevel: 0.6 });
		const { result, unmount } = renderHook(() => useMultibandVolume(4));
		await new Promise((r) => setTimeout(r, 60));
		expect(result.current.some((v) => v > 0)).toBe(true);
		useVisualizerStore.setState({ audioLevel: 0 });
		await new Promise((r) => setTimeout(r, 60));
		expect(result.current).toEqual([0, 0, 0, 0]);
		unmount();
	});

	test("silence branch settles to zeros and parks the loop", async () => {
		// audioLevel below SILENCE_THRESHOLD: the update closure takes the quiet
		// branch, the setVolumes updater replaces the array with zeros, then on
		// the second frame `zeroSettled` short-circuits and the loop parks.
		useVisualizerStore.setState({ audioLevel: 0 });
		const { result, unmount } = renderHook(() => useMultibandVolume(5));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 60));
		});
		expect(result.current).toEqual([0, 0, 0, 0, 0]);
		unmount();
	});

	test("the setVolumes updater keeps the same array when already all-zero", async () => {
		// Drives the `prev.length === n && prev.every(v => v === 0)` true-branch
		// (the early `return prev` that avoids reallocating on repeated silence).
		useVisualizerStore.setState({ audioLevel: 0 });
		const { result, unmount } = renderHook(() => useMultibandVolume(3));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 40));
		});
		const firstZeroFrame = result.current;
		await act(async () => {
			await new Promise((r) => setTimeout(r, 40));
		});
		// Still all zeros and still length 3 across frames.
		expect(result.current).toEqual([0, 0, 0]);
		expect(firstZeroFrame).toEqual([0, 0, 0]);
		unmount();
	});

	test("store subscription restarts the parked loop when audio resumes", async () => {
		// Start silent so the loop parks (rafRef = 0). Then bump audioLevel above
		// SILENCE_THRESHOLD: the store subscription fires ensureRunning(), which
		// reschedules the rAF loop and produces non-zero bands.
		useVisualizerStore.setState({ audioLevel: 0 });
		const { result, unmount } = renderHook(() => useMultibandVolume(4));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 60));
		});
		expect(result.current).toEqual([0, 0, 0, 0]);
		useVisualizerStore.setState({ audioLevel: 0.7 });
		await new Promise((r) => setTimeout(r, 60));
		expect(result.current.some((v) => v > 0)).toBe(true);
		unmount();
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
