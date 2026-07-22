import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useSequenceAnimator } from "./use-sequence-animator";

const realSetTimeout = window.setTimeout;
const realClearTimeout = window.clearTimeout;
const realRequestAnimationFrame = window.requestAnimationFrame;

let nextTimerId = 0;
let scheduledTimers = new Map<number, () => void>();
let scheduledDelays: number[] = [];

beforeEach(() => {
	nextTimerId = 0;
	scheduledTimers = new Map();
	scheduledDelays = [];

	window.setTimeout = ((handler: TimerHandler, delay?: number) => {
		if (typeof handler !== "function") {
			throw new TypeError("The animator must schedule a function callback");
		}
		nextTimerId += 1;
		scheduledTimers.set(nextTimerId, handler as () => void);
		scheduledDelays.push(delay ?? 0);
		return nextTimerId;
	}) as typeof window.setTimeout;
	window.clearTimeout = ((timerId?: number) => {
		if (timerId !== undefined) {
			scheduledTimers.delete(timerId);
		}
	}) as typeof window.clearTimeout;
});

afterEach(() => {
	window.setTimeout = realSetTimeout;
	window.clearTimeout = realClearTimeout;
	window.requestAnimationFrame = realRequestAnimationFrame;
});

function runNextTimer(): void {
	const next = scheduledTimers.entries().next().value;
	if (!next) {
		throw new Error("Expected a scheduled transition");
	}
	const [timerId, callback] = next;
	scheduledTimers.delete(timerId);
	act(callback);
}

describe("useSequenceAnimator", () => {
	test("schedules only the next sequence transition without a frame loop", () => {
		window.requestAnimationFrame = (() => {
			throw new Error("requestAnimationFrame should not be used");
		}) as typeof window.requestAnimationFrame;

		const sequence = [[0], [1], [2]];
		const { result, unmount } = renderHook(() =>
			useSequenceAnimator(sequence, "connecting:3", 500),
		);

		expect(result.current).toEqual([0]);
		expect(scheduledTimers.size).toBe(1);
		expect(scheduledDelays[0]).toBeGreaterThan(0);
		expect(scheduledDelays[0]).toBeLessThanOrEqual(500);

		runNextTimer();

		expect(result.current).toEqual([1]);
		expect(scheduledTimers.size).toBe(1);
		expect(scheduledDelays).toHaveLength(2);

		unmount();
		expect(scheduledTimers.size).toBe(0);
	});

	test("cancels while hidden and resumes from the pending transition", () => {
		let hidden = false;
		const ownDescriptor = Object.getOwnPropertyDescriptor(document, "hidden");
		Object.defineProperty(document, "hidden", {
			configurable: true,
			get: () => hidden,
		});

		const { result, unmount } = renderHook(() =>
			useSequenceAnimator([[0], [1]], "connecting:2", 500),
		);
		try {
			expect(scheduledTimers.size).toBe(1);

			hidden = true;
			act(() => document.dispatchEvent(new Event("visibilitychange")));
			expect(scheduledTimers.size).toBe(0);
			expect(result.current).toEqual([0]);

			hidden = false;
			act(() => document.dispatchEvent(new Event("visibilitychange")));
			expect(scheduledTimers.size).toBe(1);

			runNextTimer();
			expect(result.current).toEqual([1]);
		} finally {
			unmount();
			if (ownDescriptor) {
				Object.defineProperty(document, "hidden", ownDescriptor);
			} else {
				Reflect.deleteProperty(document, "hidden");
			}
		}
	});

	test("restarts at frame zero and clears the previous deadline when inputs change", () => {
		const sequence = [[0], [1]];
		const { result, rerender, unmount } = renderHook(
			({ inputsKey }: { inputsKey: string }) =>
				useSequenceAnimator(sequence, inputsKey, 500),
			{ initialProps: { inputsKey: "connecting:2" } },
		);

		runNextTimer();
		expect(result.current).toEqual([1]);

		rerender({ inputsKey: "connecting:3" });
		expect(result.current).toEqual([0]);
		expect(scheduledTimers.size).toBe(1);

		unmount();
		expect(scheduledTimers.size).toBe(0);
	});

	test("does not schedule work for a static sequence or non-finite interval", () => {
		const staticHook = renderHook(() =>
			useSequenceAnimator([[0]], "listening:1", 500),
		);
		const nonFiniteHook = renderHook(() =>
			useSequenceAnimator([[0], [1]], "connecting:2", Number.POSITIVE_INFINITY),
		);

		expect(scheduledTimers.size).toBe(0);
		staticHook.unmount();
		nonFiniteHook.unmount();
	});
});
