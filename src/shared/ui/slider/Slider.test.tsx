import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { Slider } from "./Slider";

describe("Slider", () => {
  test("exposes role=slider with the accessible name from aria-label", () => {
    render(
      <Slider
        aria-label="volume"
        max={10}
        min={0}
        onChange={() => undefined}
        step={1}
        value={5}
      />,
    );
    const slider = screen.getByRole("slider", { name: "volume" });
    expect(slider).toBeDefined();
  });

  test("reflects min/max/value via the Base UI range input", () => {
    render(
      <Slider
        aria-label="volume"
        max={10}
        min={0}
        onChange={() => undefined}
        step={1}
        value={5}
      />,
    );
    const slider = screen.getByRole("slider", { name: "volume" });
    expect(slider.getAttribute("min")).toBe("0");
    expect(slider.getAttribute("max")).toBe("10");
    expect(slider.getAttribute("value")).toBe("5");
    expect(slider.getAttribute("aria-valuenow")).toBe("5");
  });

  test("disabled prop disables the Base UI range input", () => {
    render(
      <Slider
        aria-label="volume"
        disabled
        max={10}
        min={0}
        onChange={() => undefined}
        step={1}
        value={5}
      />,
    );
    const slider = screen.getByRole("slider", { name: "volume" });
    expect(slider.hasAttribute("disabled")).toBe(true);
  });

  test("renders inline label and formatted value", () => {
    render(
      <Slider
        aria-label="bars"
        formatValue={(v) => `${v} bars`}
        label="bars"
        max={20}
        min={0}
        onChange={() => undefined}
        step={1}
        value={7}
      />,
    );
    expect(screen.getByText("bars")).toBeDefined();
    expect(screen.getByText("7 bars")).toBeDefined();
  });

  test("does not draw a full rectangular focus ring around the control", () => {
    render(
      <Slider
        aria-label="volume"
        max={10}
        min={0}
        onChange={() => undefined}
        step={1}
        value={5}
      />,
    );
    const control = document.querySelector('[data-slot="elastic-slider-control"]');
    expect(control?.className).not.toContain("data-[focused]:ring");
  });

  test("falls back to integer formatting derived from step when no formatValue is passed", () => {
    render(
      <Slider
        aria-label="bars"
        max={10}
        min={0}
        onChange={() => undefined}
        step={1}
        value={4}
      />,
    );
    expect(screen.getByText("4")).toBeDefined();
  });

  test("keyboard nudge from min snaps onto the min-anchored grid, not the zero grid", () => {
    // Regression: a slider with min=3 step=2 (the visualizerBarCount slider)
    // was snapping drag/keyboard output to the zero-anchored grid (4,6,…,22).
    // 22 overshoots schema bounds like max=21, the broadcast then fails Zod
    // validation in other windows, and they reset to defaults — which is what
    // the user sees as "the slider reverts to 9".
    const onChange = mock<(value: number) => void>(() => undefined);
    render(
      <Slider
        aria-label="bars"
        max={21}
        min={3}
        onChange={onChange}
        step={2}
        value={3}
      />,
    );
    const slider = screen.getByRole("slider", { name: "bars" });
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith(5);
  });

  test("clamps stale out-of-range value prop so the display never overflows max", () => {
    // Stale persisted value from before the snap-grid fix (value=22 on a
    // max=21 slider) must render as the formatted max, not the literal 22.
    render(
      <Slider
        aria-label="bars"
        max={21}
        min={3}
        onChange={() => undefined}
        step={2}
        value={22}
      />,
    );
    expect(screen.getByText("21")).toBeDefined();
    const slider = screen.getByRole("slider", { name: "bars" });
    expect(slider.getAttribute("aria-valuenow")).toBe("21");
  });

  test("keyboard End emits max value without overshooting via zero-grid rounding", () => {
    // Same regression — End on a min=3 max=21 step=2 slider must emit 21, not
    // 22 (which would be Math.round(21/2)*2 on the zero-anchored grid).
    const onChange = mock<(value: number) => void>(() => undefined);
    render(
      <Slider
        aria-label="bars"
        max={21}
        min={3}
        onChange={onChange}
        step={2}
        value={9}
      />,
    );
    const slider = screen.getByRole("slider", { name: "bars" });
    fireEvent.keyDown(slider, { key: "End" });
    expect(onChange).toHaveBeenCalledWith(21);
  });
});
