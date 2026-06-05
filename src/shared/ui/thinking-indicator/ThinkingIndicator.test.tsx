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

	test("renders a single status word node so rotations update text in place", () => {
		const { container } = render(
			<ThinkingIndicator data-testid="ti" words={["Crunching", "Thinking"]} />,
		);
		const activeWords = Array.from(
			container.querySelectorAll(".shimmer-text"),
		).filter((node) => !node.className.includes("invisible"));
		expect(activeWords).toHaveLength(1);
	});

	test("keeps the same output element when switching from transcribing to thinking", () => {
		const { getByTestId, rerender } = render(
			<ThinkingIndicator
				data-testid="ti"
				reserveDefaultWords
				words={["Transcribing"]}
			/>,
		);
		const node = getByTestId("ti");
		expect(node.getAttribute("data-thinking-word")).toBe("Transcribing");

		rerender(<ThinkingIndicator data-testid="ti" reserveDefaultWords />);

		expect(getByTestId("ti")).toBe(node);
		expect(node.getAttribute("data-thinking-word")).toBe("Thinking");
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
