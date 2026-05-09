import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import type { SelectOption } from "@/shared/ui/select";
import { SearchableSelect } from "./SearchableSelect";

const options: SelectOption[] = [
	{ id: "tiny", label: "Tiny" },
	{ id: "base", label: "Base" },
	{ id: "small", label: "Small" },
];

describe("SearchableSelect", () => {
	test("renders a textbox input and a trigger to open the popup", () => {
		render(<SearchableSelect onChange={() => undefined} options={options} value="tiny" />);
		expect(screen.getByRole("combobox")).toBeDefined();
		expect(screen.getByRole("button", { name: "Open popup" })).toBeDefined();
	});

	test("uses the custom placeholder when provided", () => {
		render(
			<SearchableSelect
				onChange={() => undefined}
				options={options}
				placeholder="Pick a model"
				value=""
			/>
		);
		expect(screen.getByPlaceholderText("Pick a model")).toBeDefined();
	});

	test("disables both the input and trigger when disabled is true", () => {
		render(<SearchableSelect disabled onChange={() => undefined} options={options} value="tiny" />);
		const input = screen.getByRole("combobox") as HTMLInputElement;
		const trigger = screen.getByRole("button", { name: "Open popup" }) as HTMLButtonElement;
		expect(input.disabled).toBe(true);
		expect(trigger.disabled).toBe(true);
	});
});
