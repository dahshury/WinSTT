import { describe, expect, mock, test } from "bun:test";
import {
	fireEvent,
	render,
	screen,
} from "@/shared/ui/model-picker/test/render-with-intl";
import {
	EMPTY_TTS_FILTER_STATE,
	type TtsFilterState,
} from "../lib/filter-state";
import { TtsFiltersMenu } from "./TtsFiltersMenu";

function renderMenu(
	filters: TtsFilterState = EMPTY_TTS_FILTER_STATE,
	onFiltersChange = mock((_next: TtsFilterState) => undefined),
	showSuggestedFilter = false,
) {
	render(
		<TtsFiltersMenu
			availableLanguages={["en", "fr"]}
			availableQuantizations={["fp16", "int8"]}
			filters={filters}
			onFiltersChange={onFiltersChange}
			onSortChange={() => undefined}
			showSuggestedFilter={showSuggestedFilter}
			sort={null}
		/>,
	);
	return onFiltersChange;
}

/** The menu's root is a list of filter dimensions; every control lives one
 *  level down, reached by clicking its row. */
function openSection(name: RegExp) {
	fireEvent.click(screen.getByRole("button", { name: "Sort & filter" }));
	fireEvent.click(screen.getByRole("button", { name }));
}

function backToRoot() {
	fireEvent.click(screen.getByRole("button", { name: /^Back to/ }));
}

describe("TtsFiltersMenu", () => {
	test("offers all applicable TTS filters", () => {
		renderMenu();
		openSection(/^Filters/);

		for (const label of [
			"Available on this system",
			"Downloaded",
			"Multilingual",
			"Voice cloning",
			"Voice design",
		]) {
			expect(screen.getByRole("checkbox", { name: label })).not.toBeNull();
		}

		backToRoot();
		fireEvent.click(screen.getByRole("button", { name: /^Language/ }));
		expect(
			screen.getByRole("combobox", { name: "Filter by language" }),
		).not.toBeNull();

		backToRoot();
		fireEvent.click(screen.getByRole("button", { name: /^Precision/ }));
		expect(
			screen.getByRole("combobox", { name: "Filter by quantization" }),
		).not.toBeNull();
	});

	test("every dimension is listed on the root view", () => {
		renderMenu();
		fireEvent.click(screen.getByRole("button", { name: "Sort & filter" }));

		for (const row of [/^Sort by/, /^Filters/, /^Language/, /^Precision/]) {
			expect(screen.getByRole("button", { name: row })).not.toBeNull();
		}
	});

	test("toggles a capability filter", () => {
		const onFiltersChange = renderMenu();
		openSection(/^Filters/);
		fireEvent.click(screen.getByRole("checkbox", { name: "Voice cloning" }));

		expect(onFiltersChange).toHaveBeenCalledWith({
			...EMPTY_TTS_FILTER_STATE,
			cloningOnly: true,
		});
	});
});

describe("TtsFiltersMenu suggested flag", () => {
	test("hidden while the host has no Suggested verdict wired", () => {
		renderMenu();
		openSection(/^Filters/);
		expect(screen.queryByRole("checkbox", { name: "Suggested" })).toBeNull();
	});

	test("toggling the Suggested checkbox flips suggestedOnly", () => {
		const onFiltersChange = renderMenu(
			EMPTY_TTS_FILTER_STATE,
			mock((_next: TtsFilterState) => undefined),
			true,
		);
		openSection(/^Filters/);
		fireEvent.click(screen.getByRole("checkbox", { name: "Suggested" }));
		expect(onFiltersChange).toHaveBeenCalledWith({
			...EMPTY_TTS_FILTER_STATE,
			suggestedOnly: false,
		});
	});

	test("default-ON suggested does not inflate the trigger's active count", () => {
		renderMenu(
			EMPTY_TTS_FILTER_STATE,
			mock((_next: TtsFilterState) => undefined),
			true,
		);
		// The trigger badge only appears with a non-zero count; the default
		// state (suggested ON, everything else off) must stay clean.
		const trigger = screen.getByRole("button", { name: "Sort & filter" });
		expect(trigger.textContent).not.toContain("1");
	});
});
