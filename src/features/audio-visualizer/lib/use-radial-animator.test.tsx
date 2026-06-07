import { describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import {
	__test_findGcdLessThan,
	__test_gcd,
	useRadialAnimator,
} from "./use-radial-animator";

describe("gcd", () => {
	test("returns the greater operand when the other is zero", () => {
		expect(__test_gcd(12, 0)).toBe(12);
	});

	test("computes the greatest common divisor via the Euclidean loop", () => {
		expect(__test_gcd(12, 8)).toBe(4);
		expect(__test_gcd(7, 13)).toBe(1);
		expect(__test_gcd(100, 35)).toBe(5);
	});
});

describe("findGcdLessThan", () => {
	test("returns max immediately when max divides columns (early-return branch)", () => {
		// gcd(12, 12) === 12 → the `if (gcd === i)` true-branch returns on i=max.
		expect(__test_findGcdLessThan(12)).toBe(12);
		// gcd(12, 4) === 4 → first iteration with explicit max also early-returns.
		expect(__test_findGcdLessThan(12, 4)).toBe(4);
	});

	test("walks the loop down to a divisor below max", () => {
		// max=5: gcd(12,5)=1≠5, gcd(12,4)=4=4 → returns 4 after one walk step.
		expect(__test_findGcdLessThan(12, 5)).toBe(4);
		// max=3: gcd(12,3)=3 → returns 3.
		expect(__test_findGcdLessThan(12, 3)).toBe(3);
	});

	test("falls back to 1 for a prime column count (no proper divisor in range)", () => {
		// 7 is prime: gcd(7,2)=1≠2, then gcd(7,1)=1=1 → returns 1 from the loop.
		expect(__test_findGcdLessThan(7, 2)).toBe(1);
	});

	test("returns 1 when the search range is empty (final fallthrough return)", () => {
		// max=0 makes the for-loop body never execute, hitting `return 1`.
		expect(__test_findGcdLessThan(12, 0)).toBe(1);
	});
});

describe("useRadialAnimator", () => {
	test("'disconnected' returns an empty array", () => {
		const { result } = renderHook(() =>
			useRadialAnimator("disconnected", 8, 50),
		);
		expect(result.current).toEqual([]);
	});

	test("'speaking' returns all bar indices on the first frame", () => {
		const { result } = renderHook(() => useRadialAnimator("speaking", 4, 1000));
		expect(result.current).toEqual([0, 1, 2, 3]);
	});

	test("'listening' returns a non-empty group of indices on the first frame", () => {
		const { result } = renderHook(() =>
			useRadialAnimator("listening", 6, 1000),
		);
		expect(result.current.length).toBeGreaterThan(0);
	});

	test("'connecting' returns a pair of indices on the first frame", () => {
		const { result } = renderHook(() =>
			useRadialAnimator("connecting", 5, 1000),
		);
		expect(result.current).toHaveLength(2);
	});

	test("'thinking' returns the same shape as 'listening' on the first frame", () => {
		const { result: a } = renderHook(() =>
			useRadialAnimator("thinking", 6, 1000),
		);
		const { result: b } = renderHook(() =>
			useRadialAnimator("listening", 6, 1000),
		);
		expect(a.current).toEqual(b.current);
	});

	test("'initializing' produces a connecting-style sequence", () => {
		const { result: init } = renderHook(() =>
			useRadialAnimator("initializing", 5, 1000),
		);
		const { result: conn } = renderHook(() =>
			useRadialAnimator("connecting", 5, 1000),
		);
		expect(init.current).toEqual(conn.current);
	});

	test("listening with >8 columns exercises the high-divisor branch", () => {
		// columns=12 hits the `columns > 8` arm and uses findGcdLessThan(12, 4)
		// which returns 4 (gcd(12,4)=4). Sanity-checks the divisor math.
		const { result } = renderHook(() =>
			useRadialAnimator("listening", 12, 1000),
		);
		expect(result.current.length).toBeGreaterThan(0);
	});

	test("listening with a prime column count exercises the gcd loop", () => {
		// columns=7 is prime so findGcdLessThan(7, 2) walks i=2 then i=1; the
		// loop always returns at i=1 since gcd(n,1)=1. Covers the loop body
		// and successful return.
		const { result } = renderHook(() =>
			useRadialAnimator("listening", 7, 1000),
		);
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
			{ initialProps },
		);
		const before = result.current;
		rerender({ state: "connecting", bars: 6 });
		expect(result.current).toHaveLength(2);
		expect(result.current).not.toEqual(before);
	});

	test("rerender with a different barCount triggers the reset branch", () => {
		const { result, rerender } = renderHook(
			({ bars }: { bars: number }) =>
				useRadialAnimator("connecting", bars, 1000),
			{ initialProps: { bars: 4 } },
		);
		rerender({ bars: 6 });
		expect(result.current).toHaveLength(2);
	});

	test("rerender with identical inputs skips the reset branch", () => {
		const { result, rerender } = renderHook(() =>
			useRadialAnimator("connecting", 5, 1000),
		);
		const before = result.current;
		rerender();
		expect(result.current).toEqual(before);
	});

	test("non-finite interval short-circuits the rAF loop", () => {
		const { result } = renderHook(() =>
			useRadialAnimator("connecting", 5, Number.POSITIVE_INFINITY),
		);
		expect(result.current).toHaveLength(2);
	});

	test("schedules a rAF tick when the sequence is non-trivial", async () => {
		// happy-dom exposes requestAnimationFrame as a setTimeout shim. With
		// interval=0 every scheduled frame bumps the index. We unmount before
		// returning so the self-rescheduling rAF loop stops cleanly and the
		// cleanup branch (cancelAnimationFrame) runs.
		const { result, unmount } = renderHook(() =>
			useRadialAnimator("connecting", 4, 0),
		);
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
		const { unmount } = renderHook(() =>
			useRadialAnimator("connecting", 4, 16),
		);
		expect(() => unmount()).not.toThrow();
	});
});
