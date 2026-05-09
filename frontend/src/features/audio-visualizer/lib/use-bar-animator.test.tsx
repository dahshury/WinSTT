import { describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { useBarAnimator } from "./use-bar-animator";

describe("useBarAnimator", () => {
	test("returns an empty array for 'disconnected' state", () => {
		const { result } = renderHook(() => useBarAnimator("disconnected", 5, 50));
		expect(result.current).toEqual([]);
	});

	test("returns the center column for 'listening' state on first frame", () => {
		const { result } = renderHook(() => useBarAnimator("listening", 5, 1000));
		expect(result.current).toEqual([2]);
	});

	test("returns the center column for 'thinking' state on first frame", () => {
		const { result } = renderHook(() => useBarAnimator("thinking", 7, 1000));
		expect(result.current).toEqual([3]);
	});

	test("'speaking' returns the full column array on first frame", () => {
		const { result } = renderHook(() => useBarAnimator("speaking", 4, 1000));
		expect(result.current).toEqual([0, 1, 2, 3]);
	});

	test("'connecting' returns a non-empty pair on first frame", () => {
		const { result } = renderHook(() => useBarAnimator("connecting", 5, 1000));
		expect(result.current.length).toBeGreaterThan(0);
	});

	test("'initializing' returns the same as 'connecting' on first frame", () => {
		const { result: a } = renderHook(() => useBarAnimator("connecting", 5, 1000));
		const { result: b } = renderHook(() => useBarAnimator("initializing", 5, 1000));
		expect(a.current).toEqual(b.current);
	});
});
