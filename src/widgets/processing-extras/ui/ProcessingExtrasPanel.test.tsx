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
		fireEvent.pointerUp(merged);

		let quality = useSettingsStore.getState().settings.quality;
		expect(quality.formatSpokenPunctuationCommands).toBe(true);
		expect(quality.formatSpokenSymbolCommands).toBe(true);

		fireEvent.pointerUp(merged);

		quality = useSettingsStore.getState().settings.quality;
		expect(quality.formatSpokenPunctuationCommands).toBe(false);
		expect(quality.formatSpokenSymbolCommands).toBe(false);
	});
});

describe("ProcessingExtrasPanel context-awareness scope", () => {
	function setupContext(generalOverrides: Record<string, unknown> = {}) {
		useSettingsStore.setState({
			settings: {
				...DEFAULT_SETTINGS,
				general: {
					...DEFAULT_SETTINGS.general,
					contextAwareness: true,
					contextAppMode: "all-except-denied",
					contextAllowList: [],
					...generalOverrides,
				},
				// The section only renders when a context consumer is active; the
				// dictation LLM qualifies regardless of the (non-whisper) STT model.
				llm: {
					...DEFAULT_SETTINGS.llm,
					dictation: { ...DEFAULT_SETTINGS.llm.dictation, enabled: true },
				},
			},
			isLoaded: true,
		});
	}

	function clickScope(label: "Black list" | "Allow list") {
		fireEvent.click(getVisibleText(label));
	}

	function storedGeneral() {
		return useSettingsStore.getState().settings.general;
	}

	function toggleChecked(): string | null {
		return (
			document.querySelector('[role="switch"]')?.getAttribute("aria-checked") ??
			null
		);
	}

	beforeEach(() => setupContext());

	test("switching to Allow list with no apps actually disables context awareness", () => {
		renderPanel();
		expect(toggleChecked()).toBe("true");

		clickScope("Allow list");

		expect(storedGeneral().contextAppMode).toBe("selected-only");
		// The stored flag — what the backend reads — must be honestly off, not
		// just a cosmetic toggle that leaves capture running.
		expect(storedGeneral().contextAwareness).toBe(false);
		expect(toggleChecked()).toBe("false");
	});

	test("switching back to Black list re-enables context awareness", () => {
		renderPanel();
		clickScope("Allow list");
		expect(storedGeneral().contextAwareness).toBe(false);

		clickScope("Black list");
		expect(storedGeneral().contextAppMode).toBe("all-except-denied");
		expect(storedGeneral().contextAwareness).toBe(true);
		expect(toggleChecked()).toBe("true");
	});

	test("Allow list with apps already selected stays enabled", () => {
		setupContext({ contextAllowList: ["chrome.exe"] });
		renderPanel();

		clickScope("Allow list");
		expect(storedGeneral().contextAppMode).toBe("selected-only");
		expect(storedGeneral().contextAwareness).toBe(true);
		expect(toggleChecked()).toBe("true");
	});

	test("scope config stays interactive in the Allow-list dead state", () => {
		renderPanel();
		clickScope("Allow list");
		// The scope + allow-list config must not be pointer-events-disabled, or the
		// user could never add an app to switch context awareness back on.
		const wrapper = getVisibleText("Allow list").closest(
			".pointer-events-none",
		);
		expect(wrapper).toBeNull();
	});
});
