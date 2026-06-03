import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, render, screen } from "@testing-library/react";
import { ModelPicker } from "./ModelPicker";

const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

let rafCallbacks: FrameRequestCallback[] = [];

function installRafQueue() {
	rafCallbacks = [];
	globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
		rafCallbacks.push(callback);
		return rafCallbacks.length;
	}) as typeof requestAnimationFrame;
	globalThis.cancelAnimationFrame = ((handle: number) => {
		rafCallbacks[handle - 1] = () => undefined;
	}) as typeof cancelAnimationFrame;
}

function flushRafFrame() {
	const callbacks = rafCallbacks;
	rafCallbacks = [];
	for (const callback of callbacks) {
		callback(performance.now());
	}
}

function renderPicker(open: boolean, inline = false) {
	return render(
		<ModelPicker
			inline={inline}
			items={["tiny"]}
			list={<div data-testid="heavy-list">Heavy list</div>}
			open={open}
			searchPlaceholder="Search models"
			trigger={<button type="button">Open</button>}
			value="tiny"
		/>
	);
}

describe("ModelPicker popup animation", () => {
	beforeEach(() => {
		installRafQueue();
	});

	afterEach(() => {
		globalThis.requestAnimationFrame = originalRequestAnimationFrame;
		globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
	});

	test("uses the shared Transitions.dev dropdown class and top-left origin", () => {
		renderPicker(true);

		const popup = document.querySelector('[data-slot="model-picker-popup"]');

		expect(popup).not.toBeNull();
		expect(popup?.className).toContain("t-dropdown");
		expect(popup?.getAttribute("data-origin")).toBe("top-left");
	});

	test("defers heavy popup content until after the opener has painted", () => {
		const { rerender } = renderPicker(false);

		rerender(
			<ModelPicker
				items={["tiny"]}
				list={<div data-testid="heavy-list">Heavy list</div>}
				open
				searchPlaceholder="Search models"
				trigger={<button type="button">Open</button>}
				value="tiny"
			/>
		);

		expect(screen.getByPlaceholderText("Search models")).toBeDefined();
		expect(screen.queryByTestId("heavy-list")).toBeNull();

		act(() => {
			flushRafFrame();
		});

		expect(screen.queryByTestId("heavy-list")).toBeNull();

		act(() => {
			flushRafFrame();
		});

		expect(screen.getByTestId("heavy-list")).toBeDefined();
	});

	test("keeps warmed popup content mounted across close and reopen", () => {
		const { rerender } = renderPicker(true);

		act(() => {
			flushRafFrame();
			flushRafFrame();
		});

		expect(screen.getByTestId("heavy-list")).toBeDefined();

		rerender(
			<ModelPicker
				items={["tiny"]}
				list={<div data-testid="heavy-list">Heavy list</div>}
				open={false}
				searchPlaceholder="Search models"
				trigger={<button type="button">Open</button>}
				value="tiny"
			/>
		);

		expect(screen.getByTestId("heavy-list")).toBeDefined();

		rerender(
			<ModelPicker
				items={["tiny"]}
				list={<div data-testid="heavy-list">Heavy list</div>}
				open
				searchPlaceholder="Search models"
				trigger={<button type="button">Open</button>}
				value="tiny"
			/>
		);

		expect(screen.getByTestId("heavy-list")).toBeDefined();
	});

	test("renders inline content immediately for pre-warmed detached windows", () => {
		renderPicker(false, true);

		expect(screen.getByTestId("heavy-list")).toBeDefined();
	});
});
