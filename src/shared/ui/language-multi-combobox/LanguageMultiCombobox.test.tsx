import { Tooltip } from "@base-ui/react/tooltip";
import { describe, expect, mock, test } from "bun:test";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { LanguageMultiCombobox } from "./LanguageMultiCombobox";

const options = [
	{ id: "en", label: "English", badge: "EN" },
	{ id: "fr", label: "French", badge: "FR" },
	{ id: "de", label: "German", badge: "DE" },
	{ id: "es", label: "Spanish", badge: "ES" },
];

function renderCombobox(
	value: readonly string[] = ["en"],
	onChange = mock((_value: string[]) => undefined),
) {
	render(
		<Tooltip.Provider closeDelay={0} delay={0}>
			<LanguageMultiCombobox
				ariaLabel="Language"
				emptyLabel="No languages found"
				onChange={onChange}
				options={options}
				placeholder="Select languages"
				removeLabel={(language) => `Remove ${language}`}
				selectedCountLabel={(count) => `${count}+`}
				selectedHeading="Selected"
				value={value}
			/>
		</Tooltip.Provider>,
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

	test("uses an overlay scroll area so the popup does not reserve native scrollbar space", async () => {
		renderCombobox(["en"]);

		await openPopup();

		const popup = document.querySelector(
			".searchable-select-popup",
		) as HTMLElement | null;
		expect(popup?.className).toContain("overflow-hidden");
		const viewport = popup?.querySelector(
			'[class*="scrollbar-width:none"]',
		) as HTMLElement | null;
		expect(viewport?.className).toContain("[scrollbar-width:none]");
		expect(viewport?.className).toContain("[&::-webkit-scrollbar]:hidden");
	});

	test("shows up to two selected languages as removable chips", async () => {
		const onChange = renderCombobox(["en", "fr"]);

		await openPopup();

		expect(screen.getByRole("button", { name: "Remove English" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Remove French" })).toBeTruthy();

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Remove French" }));
		});
		expect(onChange).toHaveBeenCalledWith(["en"]);
	});

	test("collapses three selected languages to a non-removable popup summary", async () => {
		const onChange = renderCombobox(["en", "fr", "de"]);

		await openPopup();

		expect(screen.getByText("3+")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Remove English" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Remove French" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Remove German" })).toBeNull();

		await act(async () => {
			fireEvent.click(screen.getByRole("checkbox", { name: "French" }));
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

	test("collapses four selected languages to a compact closed value", () => {
		renderCombobox(["en", "fr", "de", "es"]);

		expect(
			(screen.getByRole("combobox", { name: "Language" }) as HTMLInputElement)
				.value,
		).toBe("4+");
	});

	test("shows selected languages in a tooltip when the closed value is collapsed", async () => {
		renderCombobox(["en", "fr", "de"]);

		const combobox = screen.getByRole("combobox", { name: "Language" });
		const trigger = combobox.parentElement ?? combobox;
		fireEvent.pointerEnter(trigger);
		fireEvent.mouseEnter(trigger);

		await waitFor(() => {
			expect(document.body.textContent).toContain("English");
			expect(document.body.textContent).toContain("French");
			expect(document.body.textContent).toContain("German");
		});
	});
});
