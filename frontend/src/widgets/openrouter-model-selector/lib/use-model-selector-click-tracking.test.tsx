import { describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { useModelSelectorClickTracking } from "./use-model-selector-click-tracking";

describe("useModelSelectorClickTracking", () => {
	test("returns a ref that updates on document pointerdown", () => {
		const { result } = renderHook(() => useModelSelectorClickTracking());
		expect(result.current.current).toBeNull();

		const target = document.createElement("div");
		target.id = "probe";
		document.body.appendChild(target);

		const event = new PointerEvent("pointerdown", { bubbles: true });
		Object.defineProperty(event, "target", { value: target, writable: false });
		document.dispatchEvent(event);

		expect(result.current.current).toBe(target);
		document.body.removeChild(target);
	});

	test("ignores pointerdown whose target is not an HTMLElement", () => {
		const { result } = renderHook(() => useModelSelectorClickTracking());
		// Synthetic event with no real element target
		document.dispatchEvent(new PointerEvent("pointerdown"));
		expect(result.current.current).toBeNull();
	});

	test("removes the listener on unmount (subsequent events do not update the ref)", () => {
		const { result, unmount } = renderHook(() => useModelSelectorClickTracking());
		unmount();
		const target = document.createElement("div");
		document.body.appendChild(target);
		const event = new PointerEvent("pointerdown", { bubbles: true });
		Object.defineProperty(event, "target", { value: target });
		document.dispatchEvent(event);
		// ref persists post-unmount but is not updated
		expect(result.current.current).toBeNull();
		document.body.removeChild(target);
	});
});
