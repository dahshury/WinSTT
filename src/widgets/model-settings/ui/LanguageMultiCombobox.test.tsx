import { describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { LanguageMultiCombobox } from "./LanguageMultiCombobox";

const options = [
	{ id: "en", label: "English", badge: "EN" },
	{ id: "fr", label: "French", badge: "FR" },
	{ id: "de", label: "German", badge: "DE" },
];

function renderCombobox(
	value: readonly string[] = ["en"],
	onChange = mock((_value: string[]) => undefined),
) {
	render(
		<LanguageMultiCombobox
			ariaLabel="Language"
			emptyLabel="No languages found"
			onChange={onChange}
			options={options}
			placeholder="Select languages"
			removeLabel={(language) => `Remove ${language}`}
			selectedCountLabel={(count) => `${count} languages selected`}
			selectedHeading="Selected"
			value={value}
		/>,
	);
	return onChange;
}

async function openPopup() {
	fireEvent.click(screen.getByRole("button", { name: "Open popup" }));
	await act(async () => {
		await new Promise((resolve) => requestAnimationFrame(resolve));
	});
}

describe("LanguageMultiCombobox", () => {
	test("renders selected languages as checkboxes", async () => {
		renderCombobox(["en", "fr"]);

		await openPopup();

		expect(
			screen
				.getByRole("checkbox", { name: "English" })
				.getAttribute("aria-checked"),
		).toBe("true");
		expect(
			screen
				.getByRole("checkbox", { name: "French" })
				.getAttribute("aria-checked"),
		).toBe("true");
		expect(
			screen
				.getByRole("checkbox", { name: "German" })
				.getAttribute("aria-checked"),
		).toBe("false");
	});

	test("summarizes every selected language as removable chips", async () => {
		const onChange = renderCombobox(["en", "fr", "de"]);

		await openPopup();

		// The closed display collapses 3+ languages to a count, but the open
		// popup shows a chip per selected language (independent of the search
		// filter) so the user can see exactly what is selected.
		expect(screen.getByRole("button", { name: "Remove English" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Remove French" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Remove German" })).toBeTruthy();

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Remove French" }));
		});
		expect(onChange).toHaveBeenCalledWith(["en", "de"]);
	});

	test("keeps the selected summary visible while filtering the list", async () => {
		renderCombobox(["de"]);

		await openPopup();
		await act(async () => {
			fireEvent.change(screen.getByRole("combobox", { name: "Language" }), {
				target: { value: "english" },
			});
		});

		// German is filtered out of the list...
		expect(screen.queryByRole("checkbox", { name: "German" })).toBeNull();
		// ...but its chip stays in the summary so the selection is never hidden.
		expect(screen.getByRole("button", { name: "Remove German" })).toBeTruthy();
	});

	test("filters and toggles a language", async () => {
		const onChange = renderCombobox(["en"]);

		await openPopup();
		await act(async () => {
			fireEvent.change(screen.getByRole("combobox", { name: "Language" }), {
				target: { value: "fr" },
			});
		});
		await act(async () => {
			fireEvent.click(screen.getByRole("checkbox", { name: "French" }));
		});

		expect(screen.queryByRole("checkbox", { name: "English" })).toBeNull();
		expect(onChange).toHaveBeenCalledWith(["en", "fr"]);
	});
});
