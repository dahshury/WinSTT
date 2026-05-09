import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useSettingsStore } from "./settings-store";

const STORAGE_KEY = "winstt-settings";

beforeEach(() => {
	window.localStorage.removeItem(STORAGE_KEY);
	// Reset the store to its initial defaults via resetSettings (with empty dict/snippets)
	useSettingsStore.getState().updateDictionary([]);
	useSettingsStore.getState().updateSnippets([]);
	useSettingsStore.getState().resetSettings();
});

afterEach(() => {
	window.localStorage.removeItem(STORAGE_KEY);
});

describe("useSettingsStore mutators", () => {
	test("updateModelSettings merges patch into existing model branch", () => {
		useSettingsStore.getState().updateModelSettings({ language: "fr" });
		expect(useSettingsStore.getState().settings.model.language).toBe("fr");
		expect(useSettingsStore.getState().settings.model.model).toBe("large-v2"); // default preserved
	});

	test("updateQualitySettings merges patch", () => {
		useSettingsStore.getState().updateQualitySettings({ smartEndpoint: true });
		expect(useSettingsStore.getState().settings.quality.smartEndpoint).toBe(true);
	});

	test("updateAudioSettings merges patch", () => {
		useSettingsStore.getState().updateAudioSettings({ sampleRate: 44_100 });
		expect(useSettingsStore.getState().settings.audio.sampleRate).toBe(44_100);
	});

	test("updateGeneralSettings merges patch", () => {
		useSettingsStore.getState().updateGeneralSettings({ recordingMode: "toggle" });
		expect(useSettingsStore.getState().settings.general.recordingMode).toBe("toggle");
	});

	test("updateHotkeySettings merges patch", () => {
		useSettingsStore.getState().updateHotkeySettings({ pushToTalkKey: "Ctrl+S" });
		expect(useSettingsStore.getState().settings.hotkey.pushToTalkKey).toBe("Ctrl+S");
	});

	test("updateLlmSettings merges patch", () => {
		useSettingsStore.getState().updateLlmSettings({ enabled: true, preset: "formal" });
		expect(useSettingsStore.getState().settings.llm.enabled).toBe(true);
		expect(useSettingsStore.getState().settings.llm.preset).toBe("formal");
	});

	test("updateDictionary replaces the dictionary list wholesale", () => {
		const dict = [{ id: "1", find: "ur", replace: "your", caseSensitive: false, wholeWord: true }];
		useSettingsStore.getState().updateDictionary(dict);
		expect(useSettingsStore.getState().settings.dictionary).toEqual(dict);
	});

	test("updateSnippets replaces the snippets list wholesale", () => {
		const snippets = [{ id: "1", trigger: "/sig", expansion: "kind regards" }];
		useSettingsStore.getState().updateSnippets(snippets);
		expect(useSettingsStore.getState().settings.snippets).toEqual(snippets);
	});

	test("setSettings replaces the whole settings object and marks loaded", () => {
		const before = useSettingsStore.getState().settings;
		useSettingsStore.getState().setSettings({
			...before,
			general: { ...before.general, recordingMode: "listen" },
		});
		expect(useSettingsStore.getState().settings.general.recordingMode).toBe("listen");
		expect(useSettingsStore.getState().isLoaded).toBe(true);
	});

	test("setLoaded toggles the isLoaded flag without touching settings", () => {
		const snapshot = useSettingsStore.getState().settings;
		useSettingsStore.getState().setLoaded(false);
		expect(useSettingsStore.getState().isLoaded).toBe(false);
		expect(useSettingsStore.getState().settings).toBe(snapshot);
	});

	test("resetSettings restores defaults but PRESERVES dictionary and snippets", () => {
		useSettingsStore.getState().updateGeneralSettings({ recordingMode: "toggle" });
		useSettingsStore
			.getState()
			.updateDictionary([
				{ id: "1", find: "ur", replace: "your", caseSensitive: false, wholeWord: true },
			]);

		useSettingsStore.getState().resetSettings();
		const settings = useSettingsStore.getState().settings;
		expect(settings.general.recordingMode).toBe("ptt"); // back to default
		expect(settings.dictionary).toHaveLength(1); // preserved
	});
});
