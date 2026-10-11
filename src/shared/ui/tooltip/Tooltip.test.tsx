import { describe, expect, test } from "bun:test";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { setModelPickerWindowOpen } from "@/shared/api/model-picker-window-state";
import { Tooltip } from "./Tooltip";

describe("Tooltip", () => {
	test("dismisses an active selector tooltip while the detached picker is open", async () => {
		render(
			<Tooltip content="Model details" delay={0}>
				<button data-testid="model-trigger" type="button">
					Selected model
				</button>
			</Tooltip>,
		);
		const trigger = screen.getByTestId("model-trigger");
		fireEvent.pointerEnter(trigger);
		fireEvent.mouseEnter(trigger);
		fireEvent.focus(trigger);
		await screen.findByText("Model details");
		try {
			act(() => setModelPickerWindowOpen(true));
			await waitFor(() => {
				expect(screen.queryByText("Model details") === null).toBe(true);
			});
			fireEvent.mouseEnter(trigger);
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 60));
			});
			expect(screen.queryByText("Model details") === null).toBe(true);
		} finally {
			act(() => setModelPickerWindowOpen(false));
		}
	});

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
