import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Tooltip } from "./Tooltip";

describe("Tooltip", () => {
	test("renders the trigger element", () => {
		render(
			<Tooltip content="Help">
				<button data-testid="trigger" type="button">
					Hover me
				</button>
			</Tooltip>,
		);
		expect(screen.getByTestId("trigger")).toBeDefined();
	});

	test("does not render the popup until activated", () => {
		render(
			<Tooltip content="Hidden help">
				<button type="button">trigger</button>
			</Tooltip>,
		);
		expect(document.body.textContent).not.toContain("Hidden help");
	});

	test("supports a custom delay (wrapped in Tooltip.Provider)", () => {
		render(
			<Tooltip content="Help" delay={500}>
				<button data-testid="trigger" type="button">
					trigger
				</button>
			</Tooltip>,
		);
		// The trigger still renders inside the provider wrapper
		expect(screen.getByTestId("trigger")).toBeDefined();
	});

	test("supports side and sideOffset props", () => {
		render(
			<Tooltip content="Help" side="bottom" sideOffset={12}>
				<button data-testid="trigger" type="button">
					trigger
				</button>
			</Tooltip>,
		);
		expect(screen.getByTestId("trigger")).toBeDefined();
	});
});
