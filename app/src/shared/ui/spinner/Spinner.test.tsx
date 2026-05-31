import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Spinner } from "./Spinner";

describe("Spinner", () => {
	test("renders with role=status and aria-busy=true", () => {
		render(<Spinner />);
		const node = screen.getByRole("status");
		expect(node.getAttribute("aria-busy")).toBe("true");
		expect(node.getAttribute("aria-live")).toBe("polite");
	});

	test("merges custom className", () => {
		render(<Spinner className="extra" data-testid="s" />);
		expect(screen.getByTestId("s").className).toContain("extra");
	});

	test("forwards arbitrary span props", () => {
		render(<Spinner data-testid="s" id="my-spinner" />);
		expect(screen.getByTestId("s").id).toBe("my-spinner");
	});
});
