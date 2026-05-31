import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { ThinkingIndicator } from "./ThinkingIndicator";

describe("ThinkingIndicator", () => {
	test("renders with role=status and aria-live=polite", () => {
		render(<ThinkingIndicator />);
		const node = screen.getByRole("status");
		expect(node.getAttribute("aria-live")).toBe("polite");
	});

	test("renders the first word from the default rotation", () => {
		render(<ThinkingIndicator data-testid="ti" />);
		expect(screen.getByTestId("ti").textContent).toContain("Thinking");
	});

	test("respects a custom words array", () => {
		render(<ThinkingIndicator data-testid="ti" words={["Crunching"]} />);
		expect(screen.getByTestId("ti").textContent).toContain("Crunching");
	});

	test("merges custom className", () => {
		render(<ThinkingIndicator className="extra" data-testid="ti" />);
		expect(screen.getByTestId("ti").className).toContain("extra");
	});

	test("forwards arbitrary div props", () => {
		render(<ThinkingIndicator data-testid="ti" id="my-thinker" />);
		expect(screen.getByTestId("ti").id).toBe("my-thinker");
	});
});
