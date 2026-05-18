import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useSettingsStore } from "@/entities/setting";
import { QualitySettingsPanel } from "./QualitySettingsPanel";

const STORAGE_KEY = "winstt-settings";

beforeEach(() => {
	window.localStorage.removeItem(STORAGE_KEY);
	useSettingsStore.getState().updateDictionary([]);
	useSettingsStore.getState().updateSnippets([]);
	useSettingsStore.getState().resetSettings();
});

afterEach(() => {
	window.localStorage.removeItem(STORAGE_KEY);
});

describe("QualitySettingsPanel", () => {
	test("renders without crashing", () => {
		const { container } = render(
			<IntlProvider>
				<QualitySettingsPanel />
			</IntlProvider>
		);
		expect(container.firstElementChild).not.toBeNull();
	});

	test("Smart Endpoint switch is hidden in PTT mode", () => {
		useSettingsStore.getState().updateGeneralSettings({ recordingMode: "ptt" });
		const { queryByRole } = render(
			<IntlProvider>
				<QualitySettingsPanel />
			</IntlProvider>
		);
		expect(queryByRole("switch", { name: /Smart Endpoint/i })).toBeNull();
	});

	test("Smart Endpoint switch is hidden in Listen mode", () => {
		useSettingsStore.getState().updateGeneralSettings({ recordingMode: "listen" });
		const { queryByRole } = render(
			<IntlProvider>
				<QualitySettingsPanel />
			</IntlProvider>
		);
		expect(queryByRole("switch", { name: /Smart Endpoint/i })).toBeNull();
	});

	test("Smart Endpoint switch is shown in Toggle mode", () => {
		useSettingsStore.getState().updateGeneralSettings({ recordingMode: "toggle" });
		const { queryByRole } = render(
			<IntlProvider>
				<QualitySettingsPanel />
			</IntlProvider>
		);
		expect(queryByRole("switch", { name: /Smart Endpoint/i })).not.toBeNull();
	});

	test("Smart Endpoint switch is shown in Wake Word mode", () => {
		useSettingsStore.getState().updateGeneralSettings({ recordingMode: "wakeword" });
		const { queryByRole } = render(
			<IntlProvider>
				<QualitySettingsPanel />
			</IntlProvider>
		);
		expect(queryByRole("switch", { name: /Smart Endpoint/i })).not.toBeNull();
	});

	test("enabling Smart Endpoint auto-disables LLM dictation", () => {
		// Set up: Toggle mode + LLM dictation already on.
		useSettingsStore.getState().updateGeneralSettings({ recordingMode: "toggle" });
		useSettingsStore.getState().updateLlmDictation({ enabled: true });
		expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(true);

		const { getByRole } = render(
			<IntlProvider>
				<QualitySettingsPanel />
			</IntlProvider>
		);
		// Click the Smart Endpoint switch to enable it.
		fireEvent.click(getByRole("switch", { name: /Smart Endpoint/i }));

		// Smart Endpoint should be on, LLM dictation should be off — mutually exclusive.
		expect(useSettingsStore.getState().settings.quality.smartEndpoint).toBe(true);
		expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(false);
	});

	test("disabling Smart Endpoint does NOT touch LLM dictation", () => {
		useSettingsStore.getState().updateGeneralSettings({ recordingMode: "toggle" });
		useSettingsStore.getState().updateQualitySettings({ smartEndpoint: true });
		// LLM dictation is OFF by default; nothing should re-enable it on disable.

		const { getByRole } = render(
			<IntlProvider>
				<QualitySettingsPanel />
			</IntlProvider>
		);
		fireEvent.click(getByRole("switch", { name: /Smart Endpoint/i }));

		expect(useSettingsStore.getState().settings.quality.smartEndpoint).toBe(false);
		expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(false);
	});

	test("enabling Smart Endpoint when LLM dictation is already off is a no-op for LLM", () => {
		useSettingsStore.getState().updateGeneralSettings({ recordingMode: "wakeword" });
		expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(false);

		const { getByRole } = render(
			<IntlProvider>
				<QualitySettingsPanel />
			</IntlProvider>
		);
		fireEvent.click(getByRole("switch", { name: /Smart Endpoint/i }));

		expect(useSettingsStore.getState().settings.quality.smartEndpoint).toBe(true);
		// Still off — we didn't accidentally toggle it.
		expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(false);
	});
});
