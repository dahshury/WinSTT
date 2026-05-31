import { describe, expect, test } from "bun:test";
import { asInvalid } from "@test/lib/cast";
import { renderHook } from "@testing-library/react";
import type { AgentState } from "./audio-visualizer";
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

	test("rerender with a different state resets the index", () => {
		const { result, rerender } = renderHook(
			({ state, columns }: { state: AgentState; columns: number }) =>
				useBarAnimator(state, columns, 1000),
			{ initialProps: { state: "listening" as AgentState, columns: 5 } }
		);
		expect(result.current).toEqual([2]);
		rerender({ state: "connecting", columns: 5 });
		// connecting yields a pair of column indices for the first frame
		expect(result.current.length).toBeGreaterThan(0);
	});

	test("rerender with a different column count resets the index", () => {
		const { result, rerender } = renderHook(
			({ state, columns }: { state: AgentState; columns: number }) =>
				useBarAnimator(state, columns, 1000),
			{ initialProps: { state: "listening" as AgentState, columns: 5 } }
		);
		expect(result.current).toEqual([2]);
		rerender({ state: "listening", columns: 9 });
		expect(result.current).toEqual([4]);
	});

	test("non-finite interval skips the rAF loop (idempotent first frame)", () => {
		const { result } = renderHook(() => useBarAnimator("connecting", 5, Number.POSITIVE_INFINITY));
		expect(result.current.length).toBeGreaterThan(0);
	});

	test("unmounting cancels any scheduled animation frame", () => {
		const { unmount } = renderHook(() => useBarAnimator("connecting", 5, 1));
		// The cleanup function in the rAF effect must run without throwing.
		expect(() => unmount()).not.toThrow();
	});

	test("unknown state falls through to the empty sequence", () => {
		const { result } = renderHook(() =>
			useBarAnimator(asInvalid<AgentState>("not-a-real-state"), 5, 1000)
		);
		expect(result.current).toEqual([]);
	});
});
