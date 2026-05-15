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

	test("'initializing' produces a connecting-style sequence", () => {
		const { result: init } = renderHook(() => useRadialAnimator("initializing", 5, 1000));
		const { result: conn } = renderHook(() => useRadialAnimator("connecting", 5, 1000));
		expect(init.current).toEqual(conn.current);
	});

	test("listening with >8 columns exercises the high-divisor branch", () => {
		// columns=12 hits the `columns > 8` arm and uses findGcdLessThan(12, 4)
		// which returns 4 (gcd(12,4)=4). Sanity-checks the divisor math.
		const { result } = renderHook(() => useRadialAnimator("listening", 12, 1000));
		expect(result.current.length).toBeGreaterThan(0);
	});

	test("listening with a prime column count exercises the gcd loop", () => {
		// columns=7 is prime so findGcdLessThan(7, 2) walks i=2 then i=1; the
		// loop always returns at i=1 since gcd(n,1)=1. Covers the loop body
		// and successful return.
		const { result } = renderHook(() => useRadialAnimator("listening", 7, 1000));
		expect(result.current.length).toBeGreaterThan(0);
	});

	test("rerender with a different state resets the index and rebuilds the sequence", () => {
		const initialProps: { state: "listening" | "connecting"; bars: number } = {
			state: "listening",
			bars: 6,
		};
		const { result, rerender } = renderHook(
			({ state, bars }: { state: "listening" | "connecting"; bars: number }) =>
				useRadialAnimator(state, bars, 1000),
			{ initialProps }
		);
		const before = result.current;
		rerender({ state: "connecting", bars: 6 });
		expect(result.current).toHaveLength(2);
		expect(result.current).not.toEqual(before);
	});

	test("rerender with a different barCount triggers the reset branch", () => {
		const { result, rerender } = renderHook(
			({ bars }: { bars: number }) => useRadialAnimator("connecting", bars, 1000),
			{ initialProps: { bars: 4 } }
		);
		rerender({ bars: 6 });
		expect(result.current).toHaveLength(2);
	});

	test("rerender with identical inputs skips the reset branch", () => {
		const { result, rerender } = renderHook(() => useRadialAnimator("connecting", 5, 1000));
		const before = result.current;
		rerender();
		expect(result.current).toEqual(before);
	});

	test("non-finite interval short-circuits the rAF loop", () => {
		const { result } = renderHook(() =>
			useRadialAnimator("connecting", 5, Number.POSITIVE_INFINITY)
		);
		expect(result.current).toHaveLength(2);
	});

	test("schedules a rAF tick when the sequence is non-trivial", async () => {
		// happy-dom exposes requestAnimationFrame as a setTimeout shim. With
		// interval=0 every scheduled frame bumps the index. We unmount before
		// returning so the self-rescheduling rAF loop stops cleanly and the
		// cleanup branch (cancelAnimationFrame) runs.
		const { result, unmount } = renderHook(() => useRadialAnimator("connecting", 4, 0));
		expect(result.current).toHaveLength(2);
		// Yield to a macrotask so the rAF shim fires `animate` at least once
		// and exercises the `time - startTimeRef.current >= interval` branch
		// plus the setIndex updater closure.
		await new Promise((resolve) => setTimeout(resolve, 50));
		unmount();
		expect(result.current).toHaveLength(2);
	});

	test("unmount runs the effect cleanup without throwing", () => {
		// Exercises the cancelAnimationFrame path on the cleanup callback.
		const { unmount } = renderHook(() => useRadialAnimator("connecting", 4, 16));
		expect(() => unmount()).not.toThrow();
	});
});
