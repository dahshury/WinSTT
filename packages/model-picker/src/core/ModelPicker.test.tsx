import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, render, screen } from "@testing-library/react";
import { ModelPicker, scrollModelItemIntoView } from "./ModelPicker";

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
		/>,
	);
}

function domRect(top: number, height: number): DOMRect {
	return {
		bottom: top + height,
		height,
		left: 0,
		right: 100,
		toJSON: () => ({}),
		top,
		width: 100,
		x: 0,
		y: top,
	} as DOMRect;
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
			/>,
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
			/>,
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
			/>,
		);

		expect(screen.getByTestId("heavy-list")).toBeDefined();
	});

	test("keeps the popup mounted with a closing class during controlled close", () => {
		const { rerender } = renderPicker(true);

		rerender(
			<ModelPicker
				items={["tiny"]}
				list={<div data-testid="heavy-list">Heavy list</div>}
				open={false}
				searchPlaceholder="Search models"
				trigger={<button type="button">Open</button>}
				value="tiny"
			/>,
		);

		const popup = document.querySelector('[data-slot="model-picker-popup"]');

		expect(popup).not.toBeNull();
		expect(popup?.className).toContain("is-closing");
		expect(popup?.hasAttribute("data-open")).toBe(false);
		expect(popup?.hasAttribute("data-closed")).toBe(true);
	});

	test("renders inline content immediately for pre-warmed detached windows", () => {
		renderPicker(false, true);

		expect(screen.getByTestId("heavy-list")).toBeDefined();
	});

	test("scrolls the selected model to the top of the picker list", () => {
		const { container } = render(
			<div data-slot="model-picker-popup">
				<div data-slot="stt-model-list">
					<div data-model-id="tiny">Tiny</div>
					<div data-model-id="target">Target</div>
				</div>
			</div>,
		);
		const root = container.querySelector<HTMLElement>(
			'[data-slot="model-picker-popup"]',
		);
		const list = container.querySelector<HTMLElement>(
			'[data-slot="stt-model-list"]',
		);
		const target = container.querySelector<HTMLElement>(
			'[data-model-id="target"]',
		);
		if (!root || !list || !target) {
			throw new Error("test DOM did not render");
		}
		list.getBoundingClientRect = () => domRect(20, 200);
		target.getBoundingClientRect = () => domRect(170, 30);
		list.scrollTop = 5;

		expect(scrollModelItemIntoView(root, "target")).toBe(true);
		expect(list.scrollTop).toBe(155);
	});
});
