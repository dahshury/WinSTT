import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { InfoTooltip } from "./InfoTooltip";

describe("InfoTooltip", () => {
	test("renders an icon button with the default aria-label", () => {
		render(<InfoTooltip content="Help" />);
		expect(screen.getByRole("button", { name: "More info" })).toBeDefined();
	});

	test("uses a custom aria-label when provided", () => {
		render(<InfoTooltip ariaLabel="Field help" content="Help" />);
		expect(screen.getByRole("button", { name: "Field help" })).toBeDefined();
	});

	test("does not render the help text in the document until tooltip activates", () => {
		render(<InfoTooltip content="Help text body" />);
		expect(document.body.textContent).not.toContain("Help text body");
	});
});
