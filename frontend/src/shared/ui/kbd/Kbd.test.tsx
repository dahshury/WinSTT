import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Kbd, KbdGroup } from "./Kbd";

describe("Kbd", () => {
	test("renders a <kbd> element with children", () => {
		render(<Kbd>Ctrl</Kbd>);
		const node = screen.getByText("Ctrl");
		expect(node.tagName).toBe("KBD");
	});

	test("merges custom className", () => {
		render(<Kbd className="extra-x">A</Kbd>);
		expect(screen.getByText("A").className).toContain("extra-x");
	});
});

describe("KbdGroup", () => {
	test("renders a span container with the children inside", () => {
		render(
			<KbdGroup>
				<Kbd>Ctrl</Kbd>
				<Kbd>+</Kbd>
				<Kbd>S</Kbd>
			</KbdGroup>
		);
		expect(screen.getByText("Ctrl")).toBeDefined();
		expect(screen.getByText("S")).toBeDefined();
	});

	test("KbdGroup forwards className", () => {
		const { container } = render(<KbdGroup className="grouped">x</KbdGroup>);
		const span = container.querySelector("span") as HTMLElement;
		expect(span.className).toContain("grouped");
	});
});
