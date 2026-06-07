import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render as renderUi, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import type { SelectOption } from "@/shared/ui/select";
import { SearchableSelect, type SelectOptionGroup } from "./SearchableSelect";

// SearchableSelect calls `useTranslations("common")` (for its empty-state text),
// so every render needs an IntlProvider in scope. The test double installed in
// test/preload.ts serves the English bundle synchronously.
function render(ui: ReactElement) {
	return renderUi(<IntlProvider>{ui}</IntlProvider>);
}

const options: SelectOption[] = [
	{ id: "tiny", label: "Tiny" },
	{ id: "base", label: "Base" },
	{ id: "small", label: "Small" },
];

const voiceGroups: SelectOptionGroup[] = [
	{
		value: "en-us",
		label: "English (US)",
		badge: "US",
		options: [
			{ id: "af_heart", label: "Heart", badge: "US" },
			{ id: "am_adam", label: "Adam", badge: "US" },
		],
	},
	{
		value: "en-gb",
		label: "English (UK)",
		badge: "UK",
		options: [{ id: "bf_emma", label: "Emma", badge: "UK" }],
	},
];

describe("SearchableSelect", () => {
	test("renders a textbox input and a trigger to open the popup", () => {
		render(
			<SearchableSelect
				onChange={() => undefined}
				options={options}
				value="tiny"
			/>,
		);
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
			/>,
		);
		expect(screen.getByPlaceholderText("Pick a model")).toBeDefined();
	});

	test("disables both the input and trigger when disabled is true", () => {
		render(
			<SearchableSelect
				disabled
				onChange={() => undefined}
				options={options}
				value="tiny"
			/>,
		);
		const input = screen.getByRole("combobox") as HTMLInputElement;
		const trigger = screen.getByRole("button", {
			name: "Open popup",
		}) as HTMLButtonElement;
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
			/>,
		);
		// Popup is closed (no item buttons), yet the trailing control is present.
		expect(
			screen.getByRole("button", { name: "Preview selected" }),
		).toBeDefined();
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
			/>,
		);
		// Open the popup so the rows (and their trailing buttons) mount.
		fireEvent.click(screen.getByRole("button", { name: "Open popup" }));
		const rowPreview = await screen.findByRole("button", {
			name: "Preview Base",
		});
		fireEvent.click(rowPreview);
		expect(onPreview).toHaveBeenCalledWith("base");
		// The row's preview must not select the option (StopBubble swallows it).
		expect(onChange).not.toHaveBeenCalled();
	});

	test("renders a sticky header per group with its options nested under it", () => {
		render(
			<SearchableSelect
				groups={voiceGroups}
				onChange={() => undefined}
				value="af_heart"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Open popup" }));
		// Both country headers and every voice row mount.
		expect(screen.getByText("English (US)")).toBeDefined();
		expect(screen.getByText("English (UK)")).toBeDefined();
		expect(screen.getByText("Heart")).toBeDefined();
		expect(screen.getByText("Adam")).toBeDefined();
		expect(screen.getByText("Emma")).toBeDefined();
	});

	test("selecting a grouped row commits that option's id", () => {
		const onChange = mock((_id: string) => undefined);
		render(
			<SearchableSelect
				groups={voiceGroups}
				onChange={onChange}
				value="af_heart"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Open popup" }));
		fireEvent.click(screen.getByText("Adam"));
		expect(onChange).toHaveBeenCalledWith("am_adam");
	});

	test("stamps each open row with data-menu-option=<id> (the highlight-layer contract)", () => {
		render(
			<SearchableSelect
				onChange={() => undefined}
				options={options}
				value="tiny"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Open popup" }));
		// MenuHighlightLayer finds the selected/highlighted rows via this attr —
		// if Base UI ever stops forwarding it the animated pills go dark, so pin it.
		expect(
			screen
				.getByText("Base")
				.closest("[data-menu-option]")
				?.getAttribute("data-menu-option"),
		).toBe("base");
		expect(
			screen
				.getByText("Tiny")
				.closest("[data-menu-option]")
				?.getAttribute("data-menu-option"),
		).toBe("tiny");
	});

	test("search filters within groups and drops emptied group headers", () => {
		render(
			<SearchableSelect
				groups={voiceGroups}
				onChange={() => undefined}
				value="af_heart"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Open popup" }));
		fireEvent.change(screen.getByRole("combobox"), {
			target: { value: "emma" },
		});
		expect(screen.getByText("Emma")).toBeDefined();
		// The US group has no match left, so neither its rows nor its header show.
		expect(screen.queryByText("Heart")).toBeNull();
		expect(screen.queryByText("English (US)")).toBeNull();
	});
});
