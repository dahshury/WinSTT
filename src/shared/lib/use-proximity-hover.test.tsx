import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { type RefObject, useLayoutEffect, useState } from "react";
import { useProximityHover } from "./use-proximity-hover";

// happy-dom ships no ResizeObserver. The hook only needs observe/disconnect to
// exist (it never relies on the observer firing on its own — every code path
// is reachable via the returned handlers / measureItems). Install a minimal
// stub whose `observe` does nothing and capture instances so a test can fire
// the measure callback manually if needed.
interface FakeResizeObserver {
	callback: ResizeObserverCallback;
	disconnect: () => void;
	observe: (el: Element) => void;
	unobserve: () => void;
}

const originalRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
let observers: FakeResizeObserver[] = [];

function installResizeObserver() {
	observers = [];
	(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
		function MockResizeObserver(
			this: FakeResizeObserver,
			cb: ResizeObserverCallback,
		) {
			const inst: FakeResizeObserver = {
				callback: cb,
				observe: () => undefined,
				unobserve: () => undefined,
				disconnect: () => undefined,
			};
			observers.push(inst);
			Object.assign(this, inst);
		} as unknown as typeof ResizeObserver;
}

/**
 * Build a DOM element whose `getBoundingClientRect` returns the supplied box.
 * happy-dom returns all-zero rects for detached nodes, so each item/container
 * gets an explicit stub.
 */
function elWithRect(box: {
	top: number;
	left: number;
	width: number;
	height: number;
}): HTMLElement {
	const el = document.createElement("div");
	(
		el as unknown as { getBoundingClientRect: () => DOMRect }
	).getBoundingClientRect = () =>
		({
			top: box.top,
			left: box.left,
			width: box.width,
			height: box.height,
			right: box.left + box.width,
			bottom: box.top + box.height,
			x: box.left,
			y: box.top,
			toJSON: () => box,
		}) as DOMRect;
	return el;
}

/**
 * Test harness: owns a container ref so the hook has a real (stubbed) element
 * to measure against, and exposes the hook API plus the container element.
 *
 * The ref object is created once via `useState`'s lazy initializer so it
 * stays stable across re-renders; a `useLayoutEffect` syncs the latest
 * `container` argument into `ref.current` without touching the ref during
 * render (which `react-hooks-js/refs` flags).
 */
function useHarness(container: HTMLElement | null) {
	const [ref] = useState<RefObject<HTMLElement | null>>(() => ({
		current: container,
	}));
	useLayoutEffect(() => {
		ref.current = container;
	}, [container, ref]);
	return useProximityHover(ref);
}

beforeEach(() => {
	installResizeObserver();
});

afterEach(() => {
	(globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalRO;
});

describe("useProximityHover", () => {
	test("measureItems is a no-op when the container ref is null", () => {
		const { result } = renderHook(() => useHarness(null));
		act(() => {
			result.current.measureItems();
		});
		expect(result.current.itemRects).toEqual({});
		expect(result.current.activeIndex).toBeNull();
	});

	test("registerItem + measureItems compute container-relative rects", () => {
		const container = elWithRect({
			top: 100,
			left: 50,
			width: 200,
			height: 300,
		});
		const { result } = renderHook(() => useHarness(container));

		const item0 = elWithRect({ top: 110, left: 60, width: 180, height: 20 });
		const item1 = elWithRect({ top: 140, left: 60, width: 180, height: 20 });
		act(() => {
			result.current.registerItem(0, item0);
			result.current.registerItem(1, item1);
		});
		act(() => {
			result.current.measureItems();
		});

		// rect is relative to the container's top/left.
		expect(result.current.itemRects[0]).toEqual({
			top: 10,
			left: 10,
			width: 180,
			height: 20,
		});
		expect(result.current.itemRects[1]).toEqual({
			top: 40,
			left: 10,
			width: 180,
			height: 20,
		});
	});

	test("registerItem(null) unregisters the element so it is not measured", () => {
		const container = elWithRect({ top: 0, left: 0, width: 100, height: 100 });
		const { result } = renderHook(() => useHarness(container));
		const item = elWithRect({ top: 5, left: 0, width: 100, height: 10 });
		act(() => {
			result.current.registerItem(2, item);
			result.current.registerItem(2, null);
		});
		act(() => {
			result.current.measureItems();
		});
		expect(result.current.itemRects).toEqual({});
	});

	test("onMouseMove resolves the active index via findActiveIndex (hit + buffer)", () => {
		const container = elWithRect({
			top: 100,
			left: 0,
			width: 200,
			height: 300,
		});
		const { result } = renderHook(() => useHarness(container));
		const item0 = elWithRect({ top: 110, left: 0, width: 200, height: 20 });
		const item1 = elWithRect({ top: 140, left: 0, width: 200, height: 20 });
		act(() => {
			result.current.registerItem(0, item0);
			result.current.registerItem(1, item1);
			result.current.measureItems();
		});

		// item0 spans localY [10, 30) plus a 2px buffer → [8, 32).
		act(() => {
			result.current.handlers.onMouseMove({ clientY: 120 }); // localY = 20 → item 0
		});
		expect(result.current.activeIndex).toBe(0);

		// item1 spans localY [40, 60) + buffer.
		act(() => {
			result.current.handlers.onMouseMove({ clientY: 150 }); // localY = 50 → item 1
		});
		expect(result.current.activeIndex).toBe(1);

		// The 2px buffer makes the very edge of item0 a hit (localY = 9.5 ≥ 8).
		act(() => {
			result.current.handlers.onMouseMove({ clientY: 109 }); // localY = 9 → item 0 via buffer
		});
		expect(result.current.activeIndex).toBe(0);
	});

	test("onMouseMove sets activeIndex to null when the cursor is over no item", () => {
		const container = elWithRect({ top: 0, left: 0, width: 200, height: 300 });
		const { result } = renderHook(() => useHarness(container));
		const item0 = elWithRect({ top: 10, left: 0, width: 200, height: 20 });
		act(() => {
			result.current.registerItem(0, item0);
			result.current.measureItems();
		});
		act(() => {
			result.current.handlers.onMouseMove({ clientY: 500 }); // far below any item
		});
		expect(result.current.activeIndex).toBeNull();
	});

	test("onMouseMove is a no-op when the container ref is null", () => {
		const { result } = renderHook(() => useHarness(null));
		act(() => {
			result.current.handlers.onMouseMove({ clientY: 42 });
		});
		expect(result.current.activeIndex).toBeNull();
	});

	test("onMouseEnter bumps the session ref and re-measures", () => {
		const container = elWithRect({ top: 0, left: 0, width: 100, height: 100 });
		const { result } = renderHook(() => useHarness(container));
		const item = elWithRect({ top: 5, left: 0, width: 100, height: 10 });
		act(() => {
			result.current.registerItem(0, item);
		});
		const before = result.current.sessionRef.current;
		act(() => {
			result.current.handlers.onMouseEnter();
		});
		expect(result.current.sessionRef.current).toBe(before + 1);
		// onMouseEnter triggers measureItems → rect populated.
		expect(result.current.itemRects[0]).toEqual({
			top: 5,
			left: 0,
			width: 100,
			height: 10,
		});
	});

	test("onMouseLeave clears the active index", () => {
		const container = elWithRect({ top: 0, left: 0, width: 200, height: 300 });
		const { result } = renderHook(() => useHarness(container));
		const item0 = elWithRect({ top: 10, left: 0, width: 200, height: 20 });
		act(() => {
			result.current.registerItem(0, item0);
			result.current.measureItems();
		});
		// findActiveIndex reads `rectsRef`, which the hook syncs from `itemRects`
		// on render — so the move must happen after measureItems' state update
		// has committed (separate act).
		act(() => {
			result.current.handlers.onMouseMove({ clientY: 20 });
		});
		expect(result.current.activeIndex).toBe(0);
		act(() => {
			result.current.handlers.onMouseLeave();
		});
		expect(result.current.activeIndex).toBeNull();
	});

	test("setActiveIndex exposes manual control over the active index", () => {
		const container = elWithRect({ top: 0, left: 0, width: 100, height: 100 });
		const { result } = renderHook(() => useHarness(container));
		act(() => {
			result.current.setActiveIndex(3);
		});
		expect(result.current.activeIndex).toBe(3);
		act(() => {
			result.current.setActiveIndex(null);
		});
		expect(result.current.activeIndex).toBeNull();
	});

	test("the ResizeObserver effect measures via its callback and disconnects on unmount", () => {
		const container = elWithRect({ top: 50, left: 0, width: 200, height: 300 });
		const { result, unmount } = renderHook(() => useHarness(container));
		const item0 = elWithRect({ top: 60, left: 0, width: 200, height: 20 });
		act(() => {
			result.current.registerItem(0, item0);
		});
		// One observer was created for the container; fire its callback to run
		// the effect's internal `measure` closure (lines 75-82).
		expect(observers.length).toBeGreaterThanOrEqual(1);
		act(() => {
			observers[0]?.callback([], observers[0] as unknown as ResizeObserver);
		});
		expect(result.current.itemRects[0]).toEqual({
			top: 10,
			left: 0,
			width: 200,
			height: 20,
		});
		expect(() => unmount()).not.toThrow();
	});

	test("the ResizeObserver effect bails out when the container ref is null", () => {
		const { result, unmount } = renderHook(() => useHarness(null));
		expect(result.current.itemRects).toEqual({});
		expect(() => unmount()).not.toThrow();
	});
});
