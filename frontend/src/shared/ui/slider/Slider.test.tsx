import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Slider } from "./Slider";

describe("Slider", () => {
	test("exposes role=slider with the accessible name from aria-label", () => {
		render(
			<Slider aria-label="volume" max={10} min={0} onChange={() => undefined} step={1} value={5} />
		);
		const slider = screen.getByRole("slider", { name: "volume" });
		expect(slider).toBeDefined();
	});

	test("reflects min/max/value via aria-value* attributes", () => {
		render(
			<Slider aria-label="volume" max={10} min={0} onChange={() => undefined} step={1} value={5} />
		);
		const slider = screen.getByRole("slider", { name: "volume" });
		expect(slider.getAttribute("aria-valuemin")).toBe("0");
		expect(slider.getAttribute("aria-valuemax")).toBe("10");
		expect(slider.getAttribute("aria-valuenow")).toBe("5");
	});

	test("disabled prop marks the track aria-disabled and removes it from tab order", () => {
		render(
			<Slider
				aria-label="volume"
				disabled
				max={10}
				min={0}
				onChange={() => undefined}
				step={1}
				value={5}
			/>
		);
		const slider = screen.getByRole("slider", { name: "volume" });
		expect(slider.getAttribute("aria-disabled")).toBe("true");
		expect(slider.getAttribute("tabindex")).toBe("-1");
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
			/>
		);
		expect(screen.getByText("bars")).toBeDefined();
		expect(screen.getByText("7 bars")).toBeDefined();
	});

	test("falls back to integer formatting derived from step when no formatValue is passed", () => {
		render(
			<Slider aria-label="bars" max={10} min={0} onChange={() => undefined} step={1} value={4} />
		);
		expect(screen.getByText("4")).toBeDefined();
	});
});
