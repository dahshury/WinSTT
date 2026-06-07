import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { AnimatedNumber, AnimatedText, IconSwap } from "./AnimatedValue";

describe("AnimatedNumber", () => {
	test("renders every character as a replayable Transitions.dev digit", () => {
		const { container } = render(<AnimatedNumber value="42%" />);
		const group = container.querySelector(".t-digit-group");
		const digits = Array.from(container.querySelectorAll(".t-digit"));

		expect(group?.className).toContain("is-animating");
		expect(group?.textContent).toBe("42%");
		expect(digits).toHaveLength(3);
		expect(digits[1]?.getAttribute("data-stagger")).toBe("1");
		expect(digits[2]?.getAttribute("data-stagger")).toBe("2");
	});
});

describe("AnimatedText", () => {
	test("uses the Transitions.dev text-swap hook for non-numeric state labels", () => {
		const { container } = render(<AnimatedText text="Downloading" />);
		const el = container.querySelector(".t-text-swap");

		expect(el?.textContent).toBe("Downloading");
	});
});

describe("IconSwap", () => {
	test("stacks both icons in one slot and switches by data-state", () => {
		const { container } = render(
			<IconSwap
				a={<span data-testid="play">play</span>}
				b={<span data-testid="pause">pause</span>}
				state="b"
			/>,
		);
		const swap = container.querySelector(".t-icon-swap");

		expect(swap?.getAttribute("data-state")).toBe("b");
		expect(container.querySelector('[data-icon="a"]')?.textContent).toBe(
			"play",
		);
		expect(container.querySelector('[data-icon="b"]')?.textContent).toBe(
			"pause",
		);
	});
});
