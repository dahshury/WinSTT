import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DemoPreview } from "./DemoPreview";

describe("DemoPreview", () => {
	test("keeps the trigger mounted after a failed preview load", async () => {
		render(
			<TooltipPrimitive.Provider closeDelay={0} delay={0}>
				<DemoPreview demo="ptt">
					<button data-switcher-index="2" data-testid="trigger" type="button">
						Push to Talk
					</button>
				</DemoPreview>
			</TooltipPrimitive.Provider>,
		);

		const triggerBefore = screen.getByTestId("trigger");

		fireEvent.pointerEnter(triggerBefore);
		fireEvent.mouseEnter(triggerBefore);
		fireEvent.focus(triggerBefore);

		const video = await screen.findByLabelText("ptt demo");
		fireEvent.error(video);

		await waitFor(() => {
			expect(screen.queryByLabelText("ptt demo")).toBeNull();
		});
		expect(screen.getByTestId("trigger")).toBe(triggerBefore);
		expect(
			screen.getByTestId("trigger").getAttribute("data-switcher-index"),
		).toBe("2");
	});

	test("keeps the popup transparent until the first frame decodes", async () => {
		render(
			<TooltipPrimitive.Provider closeDelay={0} delay={0}>
				<DemoPreview demo="ptt">
					<button data-testid="trigger" type="button">
						Push to Talk
					</button>
				</DemoPreview>
			</TooltipPrimitive.Provider>,
		);

		const trigger = screen.getByTestId("trigger");
		fireEvent.pointerEnter(trigger);
		fireEvent.mouseEnter(trigger);
		fireEvent.focus(trigger);

		const video = await screen.findByLabelText("ptt demo");
		const popup = video.parentElement;
		// Before any frame loads the popup must not paint its dark surface — no
		// black flash while the clip is still being fetched from the CDN.
		expect(popup?.className).toContain("opacity-0");
		expect(popup?.className).not.toContain("bg-surface-2");

		fireEvent.loadedData(video);

		await waitFor(() => {
			expect(video.parentElement?.className).toContain("opacity-100");
		});
		expect(video.parentElement?.className).toContain("bg-surface-2");
	});
});
