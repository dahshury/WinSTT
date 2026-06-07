import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { ButtonGroup } from "./ButtonGroup";

describe("ButtonGroup", () => {
	test("renders a toolbar role with the given aria-label", () => {
		render(
			<ButtonGroup aria-label="Actions">
				<button type="button">A</button>
				<button type="button">B</button>
			</ButtonGroup>,
		);
		const toolbar = screen.getByRole("toolbar", { name: "Actions" });
		expect(toolbar).toBeDefined();
	});

	test("merges custom className with built-ins", () => {
		render(
			<ButtonGroup className="extra-x">
				<span>x</span>
			</ButtonGroup>,
		);
		const toolbar = screen.getByRole("toolbar");
		expect(toolbar.className).toContain("extra-x");
		expect(toolbar.className).toContain("inline-flex");
	});

	test("renders all children", () => {
		render(
			<ButtonGroup>
				<button type="button">first</button>
				<button type="button">second</button>
			</ButtonGroup>,
		);
		expect(screen.getByText("first")).toBeDefined();
		expect(screen.getByText("second")).toBeDefined();
	});
});
