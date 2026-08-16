import { describe, expect, mock, test } from "bun:test";
import {
	act,
	fireEvent,
	render,
	screen,
} from "@/shared/ui/model-picker/test/render-with-intl";
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

/** Open the menu and drill into one of its rows — the menu's root is a list of
 *  filter dimensions, so every control now lives one level down. */
async function openSection(name: RegExp) {
	fireEvent.click(screen.getByRole("button", { name: /Sort & filter/ }));
	fireEvent.click(await screen.findByRole("button", { name }));
}

async function openLanguageSection() {
	await openSection(/^Language/);
	return screen.findByRole("combobox", { name: "Language filter" });
}

async function openFlagsSection() {
	await openSection(/^Filters/);
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

		const combobox = await openLanguageSection();

		expect(combobox).not.toBeNull();
		expect(screen.queryByRole("button", { name: "English" })).toBeNull();
		expect(screen.queryByRole("button", { name: "French" })).toBeNull();
	});

	test("updates the language filter through the combobox", async () => {
		const onFiltersChange = renderMenu({
			...EMPTY_FILTER_STATE,
			languages: ["en"],
		});

		await openLanguageSection();
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

function renderMenuWithSuggested(
	filters: SttFilterState = EMPTY_FILTER_STATE,
	onFiltersChange = mock((_next: SttFilterState) => undefined),
	lockedFilterKeys: readonly ("realtimeOnly" | "suggestedOnly")[] = [],
) {
	render(
		<SttFiltersMenu
			availableLanguages={["en"]}
			filters={filters}
			lockedFilterKeys={lockedFilterKeys}
			onFiltersChange={onFiltersChange}
			onSortChange={() => undefined}
			showSuggestedFilter
			sort={null}
		/>,
	);
	return onFiltersChange;
}

describe("SttFiltersMenu suggested flag", () => {
	test("hidden while the host has no Suggested verdict wired", async () => {
		renderMenu();
		await openFlagsSection();
		expect(screen.queryByRole("checkbox", { name: /Suggested/ })).toBeNull();
	});

	test("suggestedOnly does not inflate the trigger's active count", () => {
		// Default state: suggested ON but the badge stays clean — the flag has
		// its own always-visible chip as its indicator.
		renderMenuWithSuggested();
		expect(
			screen.getByRole("button", { name: "Sort & filter" }),
		).not.toBeNull();
	});

	test("toggling the Suggested checkbox flips suggestedOnly", async () => {
		const onFiltersChange = renderMenuWithSuggested();
		await openFlagsSection();
		fireEvent.click(screen.getByRole("checkbox", { name: /Suggested/ }));
		expect(onFiltersChange).toHaveBeenCalledWith({
			...EMPTY_FILTER_STATE,
			suggestedOnly: false,
		});
	});

	test("locked flags stay pinned while suggested toggles (realtime picker)", async () => {
		const onFiltersChange = renderMenuWithSuggested(
			{ ...EMPTY_FILTER_STATE, realtimeOnly: true },
			mock((_next: SttFilterState) => undefined),
			["realtimeOnly"],
		);
		await openFlagsSection();
		fireEvent.click(screen.getByRole("checkbox", { name: /Suggested/ }));
		expect(onFiltersChange).toHaveBeenCalledWith({
			...EMPTY_FILTER_STATE,
			realtimeOnly: true,
			suggestedOnly: false,
		});
	});

	test("a locked suggestedOnly cannot be cleared from the menu", async () => {
		const onFiltersChange = renderMenuWithSuggested(
			EMPTY_FILTER_STATE,
			mock((_next: SttFilterState) => undefined),
			["suggestedOnly"],
		);
		await openFlagsSection();
		fireEvent.click(screen.getByRole("checkbox", { name: /Suggested/ }));
		expect(onFiltersChange).not.toHaveBeenCalled();
	});
});
