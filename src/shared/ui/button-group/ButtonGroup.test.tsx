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

	test("allows callers to override the wrapper role", () => {
		render(
			<ButtonGroup role="presentation">
				<button type="button">Only</button>
			</ButtonGroup>,
		);

		expect(screen.queryByRole("toolbar")).toBeNull();
		expect(screen.getByRole("button", { name: "Only" })).toBeDefined();
	});

	test("can render inset strong separators for connected controls", () => {
		render(
			<ButtonGroup connected orientation="vertical" separator="inset-strong">
				<button type="button">Top</button>
				<button type="button">Bottom</button>
			</ButtonGroup>,
		);

		const toolbar = screen.getByRole("toolbar");
		expect(toolbar.className).toContain("ring-divider-strong");
		expect(toolbar.className).toContain("[&>button+button]:before:h-px");
	});
});
