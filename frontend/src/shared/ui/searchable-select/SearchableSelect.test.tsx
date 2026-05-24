import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
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

	test("renders the inputTrailing node inside the trigger (visible while closed)", () => {
		render(
			<SearchableSelect
				inputTrailing={<button type="button">Preview selected</button>}
				onChange={() => undefined}
				options={options}
				value="tiny"
			/>
		);
		// Popup is closed (no item buttons), yet the trailing control is present.
		expect(screen.getByRole("button", { name: "Preview selected" })).toBeDefined();
		expect(screen.queryByRole("button", { name: "Preview Base" })).toBeNull();
	});

	test("clicking a row's trailing button previews without committing the value", async () => {
		const onChange = mock(() => undefined);
		const onPreview = mock((_id: string) => undefined);
		render(
			<SearchableSelect
				onChange={onChange}
				options={options}
				renderItemTrailing={(o) => (
					<button onClick={() => onPreview(o.id)} type="button">
						{`Preview ${o.label}`}
					</button>
				)}
				value="tiny"
			/>
		);
		// Open the popup so the rows (and their trailing buttons) mount.
		fireEvent.click(screen.getByRole("button", { name: "Open popup" }));
		const rowPreview = await screen.findByRole("button", { name: "Preview Base" });
		fireEvent.click(rowPreview);
		expect(onPreview).toHaveBeenCalledWith("base");
		// The row's preview must not select the option (StopBubble swallows it).
		expect(onChange).not.toHaveBeenCalled();
	});
});
