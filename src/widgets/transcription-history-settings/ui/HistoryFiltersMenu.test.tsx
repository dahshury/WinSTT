import { describe, expect, mock, test } from "bun:test";
import {
	fireEvent,
	render,
	screen,
} from "@/shared/ui/model-picker/test/render-with-intl";
import type { DateRange } from "@/shared/ui/calendar-heatmap";
import {
	buildHistoryKindOptions,
	type HistoryKind,
} from "../lib/history-kinds";
import { HistoryFiltersMenu } from "./HistoryFiltersMenu";

const options = buildHistoryKindOptions({
	labels: {
		all: "All",
		history: "Transcriptions",
		transforms: "Transforms",
		tts: "Read aloud",
	},
	transcriptionCount: 3,
	transformCount: 2,
	ttsCount: 1,
});

function renderMenu({
	historyKind = "all" as HistoryKind,
	onHistoryKindChange = mock((_kind: HistoryKind) => undefined),
	onRangeChange = mock((_range: DateRange | null) => undefined),
	selectedRange = null as DateRange | null,
} = {}) {
	render(
		<HistoryFiltersMenu
			entries={[]}
			historyKind={historyKind}
			historyKindOptions={options}
			onHistoryKindChange={onHistoryKindChange}
			onRangeChange={onRangeChange}
			selectedRange={selectedRange}
		/>,
	);
	return { onHistoryKindChange, onRangeChange };
}

const open = () =>
	fireEvent.click(screen.getByRole("button", { name: "Filter history" }));

describe("HistoryFiltersMenu", () => {
	test("the trigger spells out the active range instead of a bare count", () => {
		renderMenu({
			selectedRange: {
				from: new Date(2026, 2, 3),
				to: new Date(2026, 2, 17),
			},
		});

		const trigger = screen.getByRole("button", { name: "Filter history" });
		expect(trigger.textContent).toContain("Mar 3");
		expect(trigger.textContent).toContain("Mar 17");
	});

	test("both scope dimensions are rows on one root view", () => {
		renderMenu({ historyKind: "transforms" });
		open();

		expect(
			screen.getByRole("button", { name: /^Date range/ }).textContent,
		).toContain("All time");
		expect(screen.getByRole("button", { name: /^Kind/ }).textContent).toContain(
			"Transforms",
		);
	});

	test("picking a kind reports it and shows each kind's stored count", () => {
		const { onHistoryKindChange } = renderMenu();
		open();
		fireEvent.click(screen.getByRole("button", { name: /^Kind/ }));

		const ttsRow = screen.getByRole("button", { name: /Read aloud/ });
		expect(ttsRow.textContent).toContain("1");

		fireEvent.click(ttsRow);
		expect(onHistoryKindChange).toHaveBeenCalledWith("tts");
	});

	test("clear resets both dimensions at once", () => {
		const { onHistoryKindChange, onRangeChange } = renderMenu({
			historyKind: "tts",
		});
		open();
		fireEvent.click(screen.getByRole("button", { name: "Clear" }));

		expect(onRangeChange).toHaveBeenCalledWith(null);
		expect(onHistoryKindChange).toHaveBeenCalledWith("all");
	});

	test("no clear action while nothing is scoped", () => {
		renderMenu();
		open();
		expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
	});
});
