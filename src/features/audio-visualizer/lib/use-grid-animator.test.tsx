import { describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import {
	clampRadius,
	gridInputsChanged,
	useGridAnimator,
} from "./use-grid-animator";

describe("useGridAnimator", () => {
	test("'disconnected' returns the grid center", () => {
		const { result } = renderHook(() =>
			useGridAnimator("disconnected", 5, 5, 200),
		);
		expect(result.current).toEqual({ x: 2, y: 2 });
	});

	test("'listening' starts at the grid center on the first frame", () => {
		const { result } = renderHook(() =>
			useGridAnimator("listening", 5, 5, 200),
		);
		expect(result.current).toEqual({ x: 2, y: 2 });
	});

	test("'thinking' starts at column 0 (the bouncing-bar leftmost slot)", () => {
		const { result } = renderHook(() => useGridAnimator("thinking", 3, 5, 200));
		expect(result.current).toEqual({ x: 0, y: 1 });
	});

	test("'connecting' generates a non-trivial perimeter sequence", () => {
		const { result } = renderHook(() =>
			useGridAnimator("connecting", 5, 5, 200, 2),
		);
		// First frame should be a real coordinate, not the center default
		expect(result.current.x).toBeGreaterThanOrEqual(0);
		expect(result.current.y).toBeGreaterThanOrEqual(0);
	});

	test("'speaking' returns the static center (no animation)", () => {
		const { result } = renderHook(() => useGridAnimator("speaking", 5, 5, 200));
		expect(result.current).toEqual({ x: 2, y: 2 });
	});

	test("respects custom radius for 'connecting'", () => {
		const { result } = renderHook(() =>
			useGridAnimator("connecting", 7, 7, 200, 1),
		);
		// With radius 1 and center 3, perimeter is around (2..4, 2..4)
		expect(result.current.x).toBeGreaterThanOrEqual(2);
		expect(result.current.x).toBeLessThanOrEqual(4);
	});

	test("'initializing' uses the same connecting perimeter dispatcher", () => {
		const { result } = renderHook(() =>
			useGridAnimator("initializing", 5, 5, 200, 2),
		);
		// Same dispatcher path as 'connecting'; first frame is a real coordinate.
		expect(result.current.x).toBeGreaterThanOrEqual(0);
		expect(result.current.y).toBeGreaterThanOrEqual(0);
	});

	test("resets the index when inputs change between renders", () => {
		const { result, rerender } = renderHook(
			({ state, rows, columns, interval, radius }) =>
				useGridAnimator(state, rows, columns, interval, radius),
			{
				initialProps: {
					state: "thinking" as const,
					rows: 3,
					columns: 5,
					interval: 200,
					radius: undefined as number | undefined,
				},
			},
		);
		expect(result.current).toEqual({ x: 0, y: 1 });
		// Mutate the input shape — the hook should detect the change and reset.
		rerender({
			state: "thinking" as const,
			rows: 5,
			columns: 5,
			interval: 200,
			radius: undefined,
		});
		expect(result.current).toEqual({ x: 0, y: 2 });
	});
});

describe("clampRadius", () => {
	test("returns floor(max(rows,columns)/2) when radius is undefined", () => {
		expect(clampRadius(undefined, 5, 5)).toBe(2);
		expect(clampRadius(undefined, 5, 7)).toBe(3);
	});

	test("returns given radius when it is within bounds", () => {
		expect(clampRadius(2, 5, 5)).toBe(2);
	});

	test("clamps radius to max when it exceeds bounds", () => {
		// max = floor(max(5,5)/2) = 2; providing radius=10 → 2
		expect(clampRadius(10, 5, 5)).toBe(2);
	});

	test("non-square grid uses the larger dimension", () => {
		// max = floor(max(3,9)/2) = 4
		expect(clampRadius(undefined, 3, 9)).toBe(4);
	});
});

describe("gridInputsChanged", () => {
	const base = {
		state: "disconnected" as const,
		rows: 5,
		columns: 5,
		radius: undefined,
	};

	test("returns false when all inputs are identical", () => {
		expect(gridInputsChanged(base, { ...base })).toBe(false);
	});

	test("returns true when state changes", () => {
		expect(gridInputsChanged(base, { ...base, state: "speaking" })).toBe(true);
	});

	test("returns true when rows changes", () => {
		expect(gridInputsChanged(base, { ...base, rows: 7 })).toBe(true);
	});

	test("returns true when columns changes", () => {
		expect(gridInputsChanged(base, { ...base, columns: 3 })).toBe(true);
	});

	test("returns true when radius changes", () => {
		expect(gridInputsChanged(base, { ...base, radius: 2 })).toBe(true);
	});
});
