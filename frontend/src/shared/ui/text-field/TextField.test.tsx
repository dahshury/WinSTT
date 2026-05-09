import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { TextField } from "./TextField";

describe("TextField", () => {
	test("renders a text input by default", () => {
		render(<TextField placeholder="enter" />);
		const input = screen.getByPlaceholderText("enter") as HTMLInputElement;
		expect(input.tagName).toBe("INPUT");
	});

	test("forwards value and onChange (controlled)", () => {
		const onChange = mock(() => undefined);
		render(<TextField onChange={onChange} placeholder="x" value="abc" />);
		const input = screen.getByPlaceholderText("x") as HTMLInputElement;
		expect(input.value).toBe("abc");
		fireEvent.change(input, { target: { value: "def" } });
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	test("applies error styling when error prop is true", () => {
		render(<TextField data-testid="t" error placeholder="x" />);
		expect(screen.getByTestId("t").className).toContain("border-error");
	});

	test("does not apply error styling when error is undefined/false", () => {
		render(<TextField data-testid="t" placeholder="x" />);
		expect(screen.getByTestId("t").className).not.toContain("border-error");
	});

	test("merges user-supplied className", () => {
		render(<TextField className="custom" data-testid="t" placeholder="x" />);
		expect(screen.getByTestId("t").className).toContain("custom");
	});

	test("disabled state prevents input", () => {
		render(<TextField data-testid="t" disabled placeholder="x" />);
		expect((screen.getByTestId("t") as HTMLInputElement).disabled).toBe(true);
	});
});
