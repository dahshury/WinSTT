import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type React from "react";
import { useLongPress } from "./use-long-press";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function pointerEvent(
	props: Partial<React.PointerEvent<HTMLElement>> = {}
): React.PointerEvent<HTMLElement> {
	return {
		button: 0,
		clientX: 0,
		clientY: 0,
		pointerId: 1,
		pointerType: "touch",
		...props,
	} as React.PointerEvent<HTMLElement>;
}

afterEach(() => {
	cleanup();
});

describe("useLongPress", () => {
	test("fires for a held touch pointer", async () => {
		const onLongPress = mock(() => undefined);
		const { result } = renderHook(() => useLongPress(onLongPress, { delay: 20 }));

		act(() => {
			result.current.handlers.onPointerDown(pointerEvent());
		});
		expect(result.current.pressing).toBe(true);

		await act(async () => {
			await sleep(30);
		});

		expect(onLongPress).toHaveBeenCalledTimes(1);
		expect(result.current.pressing).toBe(false);
	});

	test("cancels when the touch moves past the scroll tolerance", async () => {
		const onLongPress = mock(() => undefined);
		const { result } = renderHook(() =>
			useLongPress(onLongPress, { delay: 20, moveTolerance: 8 })
		);

		act(() => {
			result.current.handlers.onPointerDown(pointerEvent());
			result.current.handlers.onPointerMove(pointerEvent({ clientY: 20 }));
		});

		await act(async () => {
			await sleep(30);
		});

		expect(onLongPress).not.toHaveBeenCalled();
		expect(result.current.pressing).toBe(false);
	});

	test("ignores mouse holds", async () => {
		const onLongPress = mock(() => undefined);
		const { result } = renderHook(() => useLongPress(onLongPress, { delay: 20 }));

		act(() => {
			result.current.handlers.onPointerDown(pointerEvent({ pointerType: "mouse" }));
		});

		await act(async () => {
			await sleep(30);
		});

		expect(onLongPress).not.toHaveBeenCalled();
		expect(result.current.pressing).toBe(false);
	});

	test("suppresses the native context menu after a completed hold", async () => {
		const onLongPress = mock(() => undefined);
		const { result } = renderHook(() => useLongPress(onLongPress, { delay: 20 }));
		let defaultPrevented = false;

		act(() => {
			result.current.handlers.onPointerDown(pointerEvent());
		});
		await act(async () => {
			await sleep(30);
		});
		act(() => {
			result.current.handlers.onContextMenu({
				preventDefault: () => {
					defaultPrevented = true;
				},
			} as React.MouseEvent<HTMLElement>);
		});

		expect(onLongPress).toHaveBeenCalledTimes(1);
		expect(defaultPrevented).toBe(true);
	});
});
