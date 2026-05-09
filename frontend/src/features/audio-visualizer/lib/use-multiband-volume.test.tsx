import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { useVisualizerStore } from "../model/visualizer-store";
import { useMultibandVolume } from "./use-multiband-volume";

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
