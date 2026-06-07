import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { IconButton } from "./IconButton";

describe("IconButton", () => {
	test("renders with the supplied aria-label", () => {
		render(
			<IconButton
				aria-label="Close"
				icon={<svg aria-hidden="true" data-testid="icon" />}
			/>,
		);
		expect(screen.getByRole("button", { name: "Close" })).toBeDefined();
		expect(screen.getByTestId("icon")).toBeDefined();
	});

	test("invokes onClick when clicked", () => {
		const onClick = mock(() => undefined);
		render(<IconButton aria-label="Close" icon={<span />} onClick={onClick} />);
		fireEvent.click(screen.getByRole("button"));
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	test("does not invoke onClick when disabled", () => {
		const onClick = mock(() => undefined);
		render(
			<IconButton
				aria-label="Close"
				disabled
				icon={<span />}
				onClick={onClick}
			/>,
		);
		fireEvent.click(screen.getByRole("button"));
		expect(onClick).not.toHaveBeenCalled();
	});

	test("merges custom className", () => {
		render(<IconButton aria-label="X" className="extra" icon={<span />} />);
		expect(screen.getByRole("button").className).toContain("extra");
	});
});
