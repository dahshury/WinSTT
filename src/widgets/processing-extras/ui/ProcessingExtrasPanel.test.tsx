import { beforeEach, describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import { ProcessingExtrasPanel } from "./ProcessingExtrasPanel";

function renderPanel() {
	return render(
		<IntlProvider>
			<ProcessingExtrasPanel />
		</IntlProvider>,
	);
}

function getVisibleText(text: string): HTMLElement {
	const element = screen
		.getAllByText(text)
		.find((node) => node.getAttribute("aria-hidden") !== "true");
	if (!element) {
		throw new Error(`Could not find visible text: ${text}`);
	}
	return element;
}

describe("ProcessingExtrasPanel formatting rules", () => {
	beforeEach(() => {
		useSettingsStore.setState({ settings: DEFAULT_SETTINGS, isLoaded: true });
	});

	test("shows one merged control for spoken punctuation and code commands", () => {
		renderPanel();

		expect(
			getVisibleText("Spoken punctuation and code commands"),
		).toBeDefined();
		expect(screen.queryAllByText("Spoken punctuation commands").length).toBe(0);
		expect(screen.queryAllByText("Technical symbol commands").length).toBe(0);
	});

	test("merged command control updates punctuation and code command settings together", () => {
		renderPanel();

		const merged = getVisibleText("Spoken punctuation and code commands");
		fireEvent.click(merged);

		let quality = useSettingsStore.getState().settings.quality;
		expect(quality.formatSpokenPunctuationCommands).toBe(true);
		expect(quality.formatSpokenSymbolCommands).toBe(true);

		fireEvent.click(merged);

		quality = useSettingsStore.getState().settings.quality;
		expect(quality.formatSpokenPunctuationCommands).toBe(false);
		expect(quality.formatSpokenSymbolCommands).toBe(false);
	});
});
