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
});
