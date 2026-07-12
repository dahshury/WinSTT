import { describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { NumberStepper } from "./NumberStepper";

function nextFrame(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("NumberStepper", () => {
	test("renders an input with the current value", () => {
		render(<NumberStepper onChange={() => undefined} value={5} />);
		const input = screen.getByRole("textbox") as HTMLInputElement;
		expect(input.value).toBe("5");
	});

	test("renders an increment and a decrement button", () => {
		render(<NumberStepper onChange={() => undefined} value={5} />);
		// Two unnamed buttons: increment + decrement
		const buttons = screen.getAllByRole("button");
		expect(buttons.length).toBeGreaterThanOrEqual(2);
	});

	test("clicking the increment button increases the value via onChange", () => {
		const onChange = mock(() => undefined);
		render(<NumberStepper onChange={onChange} step={2} value={3} />);
		const buttons = screen.getAllByRole("button");
		// Order in DOM: decrement, increment
		const incrementBtn = buttons.at(-1);
		fireEvent.pointerDown(incrementBtn!);
		fireEvent.pointerUp(incrementBtn!);
		fireEvent.click(incrementBtn!);
		expect(onChange).toHaveBeenCalled();
	});

	test("forwarded disabled flag disables both buttons", () => {
		render(<NumberStepper disabled onChange={() => undefined} value={5} />);
		for (const btn of screen.getAllByRole("button")) {
			expect((btn as HTMLButtonElement).disabled).toBe(true);
		}
	});

	test("renders without throwing when min and max bounds are provided", () => {
		render(
			<NumberStepper max={10} min={0} onChange={() => undefined} value={5} />,
		);
		const input = screen.getByRole("textbox") as HTMLInputElement;
		expect(input.value).toBe("5");
		// base-ui NumberField does not always wire min/max as aria-valuemin/max
		// onto the textual input — exercise the prop path without asserting
		// implementation-specific aria attributes.
	});

	test("keeps clamp announcements opt-in", () => {
		// No aria-live status region unless announceClamp is enabled, so existing
		// consumers gain no extra DOM.
		const { container } = render(
			<NumberStepper max={10} min={0} onChange={() => undefined} value={5} />,
		);
		expect(container.querySelector('[role="status"]')).toBeNull();
	});

	test("announces reaching the max bound when announceClamp is on", () => {
		const onChange = mock(() => undefined);
		render(
			<NumberStepper
				announceClamp
				max={5}
				maxClampLabel="At maximum"
				min={0}
				onChange={onChange}
				step={2}
				value={4}
			/>,
		);
		const status = document.querySelector('[role="status"]');
		expect(status).not.toBeNull();
		// Stepping up by 2 from 4 overshoots max=5; base-ui clamps the change to
		// 5 and the boundary announcement is surfaced.
		const incrementBtn = screen.getAllByRole("button").at(-1);
		fireEvent.pointerDown(incrementBtn!);
		fireEvent.pointerUp(incrementBtn!);
		fireEvent.click(incrementBtn!);
		expect(onChange).toHaveBeenCalledWith(5);
		expect(document.querySelector('[role="status"]')?.textContent).toBe(
			"At maximum",
		);
	});

	test("keeps value scrubbing opt-in", () => {
		const { container, rerender } = render(
			<NumberStepper onChange={() => undefined} value={5} />,
		);

		expect(container.querySelector(".number-stepper-scrub-area")).toBeNull();

		rerender(<NumberStepper scrubbable onChange={() => undefined} value={5} />);

		const input = screen.getByRole("textbox");
		expect(input.className).toContain("cursor-ew-resize");
		expect(input.closest(".number-stepper-scrub-area")).not.toBeNull();
	});

	test("scrubs the value from touch pointer movement", async () => {
		const onChange = mock(() => undefined);
		render(<NumberStepper scrubbable onChange={onChange} value={5} />);

		const scrubArea = document.querySelector(".number-stepper-scrub-area");
		expect(scrubArea).not.toBeNull();

		fireEvent.pointerDown(scrubArea!, {
			button: 0,
			clientX: 10,
			clientY: 4,
			pointerId: 1,
			pointerType: "touch",
		});
		await act(nextFrame);
		fireEvent.pointerMove(window, {
			clientX: 18,
			clientY: 4,
			movementX: 8,
			movementY: 0,
			pointerId: 1,
			pointerType: "touch",
		});
		fireEvent.pointerUp(window, {
			button: 0,
			clientX: 18,
			clientY: 4,
			pointerId: 1,
			pointerType: "touch",
		});

		expect(onChange).toHaveBeenCalled();
	});
});
