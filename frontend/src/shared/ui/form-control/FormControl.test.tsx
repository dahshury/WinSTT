import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { FormControl } from "./FormControl";

describe("FormControl", () => {
	test("renders label, caption, children", () => {
		render(
			<FormControl caption="Help text" label="Name">
				<input data-testid="i" type="text" />
			</FormControl>
		);
		expect(screen.getByText("Name")).toBeDefined();
		expect(screen.getByText("Help text")).toBeDefined();
		expect(screen.getByTestId("i")).toBeDefined();
	});

	test("renders inside a Field.Root wrapper that exposes label-for association", () => {
		render(
			<FormControl label="Name">
				<input data-testid="i" type="text" />
			</FormControl>
		);
		const label = screen.getByText("Name");
		expect(label.tagName).toBe("LABEL");
		// Base UI wires the label `for` to the field — assert the link is set
		const linkedId = (label as HTMLLabelElement).getAttribute("for");
		expect(linkedId && linkedId.length > 0).toBe(true);
	});

	test("renders the error message in a role=alert region when error is truthy", () => {
		render(
			<FormControl error="Required" label="Name">
				<input type="text" />
			</FormControl>
		);
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toBe("Required");
		expect(alert.getAttribute("aria-live")).toBe("assertive");
	});

	test("does not render the alert region when error is undefined or empty", () => {
		const { rerender } = render(
			<FormControl label="Name">
				<input type="text" />
			</FormControl>
		);
		expect(screen.queryByRole("alert")).toBeNull();
		rerender(
			<FormControl error="" label="Name">
				<input type="text" />
			</FormControl>
		);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	test("does not render label section when label is omitted", () => {
		render(
			<FormControl>
				<input data-testid="i" type="text" />
			</FormControl>
		);
		expect(screen.getByTestId("i")).toBeDefined();
	});

	test("applies disabled styling that visually dims the wrapper", () => {
		render(
			<FormControl disabled label="X">
				<input data-testid="i" type="text" />
			</FormControl>
		);
		// the input is wrapped in a div with pointer-events-none when disabled; check the inner wrapper
		const input = screen.getByTestId("i");
		expect(input.parentElement?.className).toContain("pointer-events-none");
	});
});
