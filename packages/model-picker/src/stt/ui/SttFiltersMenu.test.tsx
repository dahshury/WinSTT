import { describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { EMPTY_FILTER_STATE, type SttFilterState } from "../lib/filter-state";
import { SttFiltersMenu } from "./SttFiltersMenu";

function renderMenu(
	filters: SttFilterState = EMPTY_FILTER_STATE,
	onFiltersChange = mock((_next: SttFilterState) => undefined),
) {
	render(
		<SttFiltersMenu
			availableLanguages={["en", "fr", "de"]}
			filters={filters}
			onFiltersChange={onFiltersChange}
			onSortChange={() => undefined}
			sort={null}
		/>,
	);
	return onFiltersChange;
}

async function openFilters() {
	fireEvent.click(screen.getByRole("button", { name: /Sort & filter/ }));
	return screen.findByRole("combobox", { name: "Language filter" });
}

async function openLanguageCombobox() {
	fireEvent.click(screen.getByRole("button", { name: "Open popup" }));
	await act(async () => {
		await new Promise((resolve) => requestAnimationFrame(resolve));
	});
}

describe("SttFiltersMenu", () => {
	test("uses the shared trigger count for selected languages", () => {
		renderMenu({ ...EMPTY_FILTER_STATE, languages: ["en", "fr"] });

		expect(
			screen.getByRole("button", { name: "Sort & filter (2 active)" }),
		).not.toBeNull();
		expect(screen.getByText("2")).not.toBeNull();
	});

	test("renders language filters as one combobox instead of a language grid", async () => {
		renderMenu({ ...EMPTY_FILTER_STATE, languages: ["en"] });

		const combobox = await openFilters();

		expect(combobox).not.toBeNull();
		expect(screen.queryByRole("button", { name: "English" })).toBeNull();
		expect(screen.queryByRole("button", { name: "French" })).toBeNull();
	});

	test("updates the language filter through the combobox", async () => {
		const onFiltersChange = renderMenu({
			...EMPTY_FILTER_STATE,
			languages: ["en"],
		});

		await openFilters();
		await openLanguageCombobox();
		await act(async () => {
			fireEvent.click(screen.getByRole("checkbox", { name: "French" }));
		});

		expect(onFiltersChange).toHaveBeenCalledWith({
			...EMPTY_FILTER_STATE,
			languages: ["en", "fr"],
		});
	});
});
