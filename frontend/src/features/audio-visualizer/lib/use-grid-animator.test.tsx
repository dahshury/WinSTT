import { describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { useGridAnimator } from "./use-grid-animator";

describe("useGridAnimator", () => {
	test("'disconnected' returns the grid center", () => {
		const { result } = renderHook(() => useGridAnimator("disconnected", 5, 5, 200));
		expect(result.current).toEqual({ x: 2, y: 2 });
	});

	test("'listening' starts at the grid center on the first frame", () => {
		const { result } = renderHook(() => useGridAnimator("listening", 5, 5, 200));
		expect(result.current).toEqual({ x: 2, y: 2 });
	});

	test("'thinking' starts at column 0 (the bouncing-bar leftmost slot)", () => {
		const { result } = renderHook(() => useGridAnimator("thinking", 3, 5, 200));
		expect(result.current).toEqual({ x: 0, y: 1 });
	});

	test("'connecting' generates a non-trivial perimeter sequence", () => {
		const { result } = renderHook(() => useGridAnimator("connecting", 5, 5, 200, 2));
		// First frame should be a real coordinate, not the center default
		expect(result.current.x).toBeGreaterThanOrEqual(0);
		expect(result.current.y).toBeGreaterThanOrEqual(0);
	});

	test("'speaking' returns the static center (no animation)", () => {
		const { result } = renderHook(() => useGridAnimator("speaking", 5, 5, 200));
		expect(result.current).toEqual({ x: 2, y: 2 });
	});

	test("respects custom radius for 'connecting'", () => {
		const { result } = renderHook(() => useGridAnimator("connecting", 7, 7, 200, 1));
		// With radius 1 and center 3, perimeter is around (2..4, 2..4)
		expect(result.current.x).toBeGreaterThanOrEqual(2);
		expect(result.current.x).toBeLessThanOrEqual(4);
	});
});
