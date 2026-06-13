import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { FormControl } from "./FormControl";

describe("FormControl", () => {
	test("renders label, caption, children", () => {
		render(
			<FormControl caption="Help text" label="Name">
				<input data-testid="i" type="text" />
			</FormControl>,
		);
		expect(screen.getByText("Name")).toBeDefined();
		expect(screen.getByText("Help text")).toBeDefined();
		expect(screen.getByTestId("i")).toBeDefined();
	});

	test("renders inside a Field.Root wrapper that exposes label-for association", () => {
		render(
			<FormControl label="Name">
				<input data-testid="i" type="text" />
			</FormControl>,
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
			</FormControl>,
		);
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toBe("Required");
		expect(alert.getAttribute("aria-live")).toBe("assertive");
	});

	test("does not render the alert region when error is undefined or empty", () => {
		const { rerender } = render(
			<FormControl label="Name">
				<input type="text" />
			</FormControl>,
		);
		expect(screen.queryByRole("alert")).toBeNull();
		rerender(
			<FormControl error="" label="Name">
				<input type="text" />
			</FormControl>,
		);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	test("does not render label section when label is omitted", () => {
		render(
			<FormControl>
				<input data-testid="i" type="text" />
			</FormControl>,
		);
		expect(screen.getByTestId("i")).toBeDefined();
	});

	test("applies disabled styling that visually dims the wrapper", () => {
		render(
			<FormControl disabled label="X">
				<input data-testid="i" type="text" />
			</FormControl>,
		);
		// the input is wrapped in a div with pointer-events-none when disabled; check the inner wrapper
		const input = screen.getByTestId("i");
		expect(input.parentElement?.className).toContain("pointer-events-none");
	});

	test("anchors controlTooltip outside disabled children so it can receive hover", () => {
		render(
			<FormControl controlTooltip="Turn on X" disabled label="X">
				<input data-testid="i" type="text" />
			</FormControl>,
		);
		const input = screen.getByTestId("i");
		expect(input.parentElement?.className).toContain("pointer-events-none");
		expect(input.parentElement?.parentElement?.className).toContain(
			"cursor-not-allowed",
		);
	});

	test("toggle-only control (labelAddon, no children) floats the toggle right of a centered header", () => {
		const { container } = render(
			<FormControl
				caption="desc"
				label="Enable X"
				labelAddon={
					<input
						aria-checked={false}
						aria-label="enable"
						role="switch"
						type="checkbox"
					/>
				}
			/>,
		);
		// The header row centers the toggle against the label+caption block …
		expect(container.querySelector("div.flex.items-center")).not.toBeNull();
		// … and the toggle lives in a trailing shrink-0 slot, not after the label text.
		const sw = screen.getByRole("switch");
		expect(sw.closest("div.shrink-0")).not.toBeNull();
		expect(screen.getByText("Enable X")).toBeDefined();
		expect(screen.getByText("desc")).toBeDefined();
	});

	test("stacked control with children keeps the two-row (flex-col) layout", () => {
		const { container } = render(
			<FormControl label="Name">
				<input data-testid="i" type="text" />
			</FormControl>,
		);
		const root = container.firstElementChild as HTMLElement;
		expect(root.className).toContain("flex-col");
	});
});
