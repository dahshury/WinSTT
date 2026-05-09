import { describe, expect, mock, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { useRef } from "react";
import { useFitSize } from "./use-fit-size";

class MockResizeObserver {
	private readonly cb: ResizeObserverCallback;
	constructor(cb: ResizeObserverCallback) {
		this.cb = cb;
	}
	observe = mock(() => undefined);
	unobserve = mock(() => undefined);
	disconnect = mock(() => undefined);
	trigger() {
		this.cb([] as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver);
	}
}

const originalRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = MockResizeObserver;

function createSizedDiv(width: number, height: number): HTMLDivElement {
	const div = document.createElement("div");
	Object.defineProperty(div, "clientWidth", { value: width, configurable: true });
	Object.defineProperty(div, "clientHeight", { value: height, configurable: true });
	return div;
}

describe("useFitSize", () => {
	test("returns 'icon' when ref has no element", () => {
		const { result } = renderHook(() => {
			const ref = useRef<HTMLElement | null>(null);
			return useFitSize(ref);
		});
		expect(result.current).toBe("icon");
	});

	test.each([
		[20, "icon"],
		[24, "icon"],
		[55, "icon"],
		[56, "sm"],
		[111, "sm"],
		[112, "md"],
		[223, "md"],
		[224, "lg"],
		[447, "lg"],
		[448, "xl"],
		[1000, "xl"],
	] as const)("returns %s for min-dim %d → %s", (size, expected) => {
		const div = createSizedDiv(size, size);
		const { result } = renderHook(() => {
			const ref = useRef<HTMLElement | null>(div);
			return useFitSize(ref);
		});
		expect(result.current).toBe(expected);
	});

	test("uses the smaller of width/height (min)", () => {
		const div = createSizedDiv(1000, 56);
		const { result } = renderHook(() => {
			const ref = useRef<HTMLElement | null>(div);
			return useFitSize(ref);
		});
		expect(result.current).toBe("sm");
	});
});

// Cleanup at file teardown — restore original RO if any
process.on("exit", () => {
	(globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalRO;
});
