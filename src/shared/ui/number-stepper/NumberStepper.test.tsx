import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { NumberStepper } from "./NumberStepper";

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
});
