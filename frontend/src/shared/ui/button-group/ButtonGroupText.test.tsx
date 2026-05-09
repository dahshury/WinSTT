import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { ButtonGroupText } from "./ButtonGroupText";

describe("ButtonGroupText", () => {
	test("renders children", () => {
		render(<ButtonGroupText>Saved</ButtonGroupText>);
		expect(screen.getByText("Saved")).toBeDefined();
	});

	test("merges custom className", () => {
		render(<ButtonGroupText className="extra-x">X</ButtonGroupText>);
		expect(screen.getByText("X").className).toContain("extra-x");
	});

	test("includes the canonical layout classes", () => {
		render(<ButtonGroupText>X</ButtonGroupText>);
		const node = screen.getByText("X");
		expect(node.className).toContain("flex");
		expect(node.className).toContain("items-center");
	});
});
