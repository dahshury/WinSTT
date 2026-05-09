import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Slider } from "./Slider";

describe("Slider", () => {
	test("renders a hidden range input plus a group named by aria-label", () => {
		render(
			<Slider aria-label="volume" max={10} min={0} onChange={() => undefined} step={1} value={5} />
		);
		const group = screen.getByRole("group", { name: "volume" });
		expect(group).toBeDefined();
		const input = screen.getByRole("slider") as HTMLInputElement;
		expect(input.type).toBe("range");
	});

	test("reflects min/max/value on the underlying range input", () => {
		render(
			<Slider aria-label="volume" max={10} min={0} onChange={() => undefined} step={1} value={5} />
		);
		const input = screen.getByRole("slider") as HTMLInputElement;
		expect(input.min).toBe("0");
		expect(input.max).toBe("10");
		expect(input.value).toBe("5");
	});

	test("disabled prop disables the underlying range input", () => {
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
		const input = screen.getByRole("slider") as HTMLInputElement;
		expect(input.disabled).toBe(true);
	});
});
