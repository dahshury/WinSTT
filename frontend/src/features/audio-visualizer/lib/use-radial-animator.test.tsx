import { describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { useRadialAnimator } from "./use-radial-animator";

describe("useRadialAnimator", () => {
	test("'disconnected' returns an empty array", () => {
		const { result } = renderHook(() => useRadialAnimator("disconnected", 8, 50));
		expect(result.current).toEqual([]);
	});

	test("'speaking' returns all bar indices on the first frame", () => {
		const { result } = renderHook(() => useRadialAnimator("speaking", 4, 1000));
		expect(result.current).toEqual([0, 1, 2, 3]);
	});

	test("'listening' returns a non-empty group of indices on the first frame", () => {
		const { result } = renderHook(() => useRadialAnimator("listening", 6, 1000));
		expect(result.current.length).toBeGreaterThan(0);
	});

	test("'connecting' returns a pair of indices on the first frame", () => {
		const { result } = renderHook(() => useRadialAnimator("connecting", 5, 1000));
		expect(result.current).toHaveLength(2);
	});

	test("'thinking' returns the same shape as 'listening' on the first frame", () => {
		const { result: a } = renderHook(() => useRadialAnimator("thinking", 6, 1000));
		const { result: b } = renderHook(() => useRadialAnimator("listening", 6, 1000));
		expect(a.current).toEqual(b.current);
	});
});
