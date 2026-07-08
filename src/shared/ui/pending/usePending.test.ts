import { describe, expect, mock, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { usePending } from "./usePending";

describe("usePending", () => {
	test("is inert when not pending — no attrs, no handlers", () => {
		const { result } = renderHook(() => usePending({ isPending: false }));

		expect(result.current.isPending).toBe(false);
		expect(result.current.pendingProps).toEqual({});
	});

	test("defaults to not-pending when no option is given", () => {
		const { result } = renderHook(() => usePending());

		expect(result.current.isPending).toBe(false);
		expect(result.current.pendingProps).toEqual({});
	});

	test("exposes busy/disabled ARIA + data attributes when pending", () => {
		const { result } = renderHook(() => usePending({ isPending: true }));
		const { pendingProps } = result.current;

		expect(result.current.isPending).toBe(true);
		expect(pendingProps["aria-busy"]).toBe(true);
		expect(pendingProps["aria-disabled"]).toBe(true);
		expect(pendingProps["data-pending"]).toBe("");
		expect(pendingProps["data-disabled"]).toBe("");
	});

	test("guards suppress every interaction event they cover", () => {
		const { result } = renderHook(() => usePending({ isPending: true }));
		const { pendingProps } = result.current;

		const handlers = [
			pendingProps.onClickCapture,
			pendingProps.onPointerDownCapture,
			pendingProps.onPointerUpCapture,
			pendingProps.onKeyDownCapture,
			pendingProps.onKeyUpCapture,
		];

		for (const handler of handlers) {
			expect(handler).toBeTypeOf("function");
			const preventDefault = mock();
			const stopPropagation = mock();
			// The guards only touch preventDefault/stopPropagation, so a minimal
			// stub event is enough to exercise them.
			(handler as (event: unknown) => void)({
				preventDefault,
				stopPropagation,
			});
			expect(preventDefault).toHaveBeenCalledTimes(1);
			expect(stopPropagation).toHaveBeenCalledTimes(1);
		}
	});
});
