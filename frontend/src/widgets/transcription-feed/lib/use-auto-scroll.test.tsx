import { describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { useAutoScroll } from "./use-auto-scroll";

describe("useAutoScroll", () => {
	test("returns a ref initialised to null", () => {
		const { result } = renderHook(() => useAutoScroll([]));
		expect(result.current.current).toBeNull();
	});

	test("scrolls to bottom whenever deps change", () => {
		const div = document.createElement("div");
		Object.defineProperty(div, "scrollHeight", { value: 1000, configurable: true });
		div.scrollTop = 0;

		const { rerender } = renderHook(
			({ deps }: { deps: number[] }) => {
				const ref = useAutoScroll<HTMLDivElement>(deps);
				// Manually attach the test element so the effect's `el.scrollTop = el.scrollHeight` runs.
				ref.current = div;
				return ref;
			},
			{ initialProps: { deps: [1] } }
		);

		rerender({ deps: [2] });
		expect(div.scrollTop).toBe(1000);
	});

	test("noop when ref is unattached", () => {
		const { rerender } = renderHook(({ deps }: { deps: number[] }) => useAutoScroll(deps), {
			initialProps: { deps: [1] },
		});
		// rerender to fire the effect again; ref.current === null path is exercised
		rerender({ deps: [2] });
		// no assertion necessary — just verifying no crash
	});
});
