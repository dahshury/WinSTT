import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import { useTtsModelPickerStore } from "./tts-model-picker-store";

const initial = useSettingsStore.getState().settings;

beforeEach(() => {
	useSettingsStore.setState({ settings: { ...initial } });
	useTtsModelPickerStore.getState().close();
});

afterEach(() => {
	useSettingsStore.setState({ settings: initial });
});

describe("useTtsModelPickerStore", () => {
	test("openFor records the enable intent and opens", () => {
		useTtsModelPickerStore.getState().openFor(true);
		const s = useTtsModelPickerStore.getState();
		expect(s.open).toBe(true);
		expect(s.enableOnInstall).toBe(true);
	});

	test("close resets the coordination state", () => {
		useTtsModelPickerStore.getState().openFor(true);
		useTtsModelPickerStore.getState().close();
		const s = useTtsModelPickerStore.getState();
		expect(s.open).toBe(false);
		expect(s.enableOnInstall).toBe(false);
	});

	test("commitInstalled with enable intent turns read-aloud on with the model", () => {
		// The whole point: the toggle opened the picker WITHOUT enabling; only a
		// landed model flips `enabled` true — never the empty/uncached state.
		useTtsModelPickerStore.getState().openFor(true);
		useTtsModelPickerStore.getState().commitInstalled("piper-en-us");
		const tts = useSettingsStore.getState().settings.tts;
		expect(tts.model).toBe("piper-en-us");
		expect(tts.enabled).toBe(true);
	});

	test("enable with an empty hotkey folds the default speak binding in", () => {
		useSettingsStore.setState({
			settings: { ...initial, tts: { ...initial.tts, hotkey: "", enabled: false } },
		});
		useTtsModelPickerStore.getState().openFor(true);
		useTtsModelPickerStore.getState().commitInstalled("kitten-tts-nano");
		const tts = useSettingsStore.getState().settings.tts;
		expect(tts.enabled).toBe(true);
		expect(tts.hotkey).toBe(DEFAULT_SETTINGS.tts.hotkey);
	});

	test("enable preserves an existing user hotkey", () => {
		useSettingsStore.setState({
			settings: { ...initial, tts: { ...initial.tts, hotkey: "LCtrl+Alt+R", enabled: false } },
		});
		useTtsModelPickerStore.getState().openFor(true);
		useTtsModelPickerStore.getState().commitInstalled("kokoro-82m");
		expect(useSettingsStore.getState().settings.tts.hotkey).toBe("LCtrl+Alt+R");
	});

	test("commitInstalled WITHOUT enable intent (browse) sets the model but leaves enabled off", () => {
		useSettingsStore.setState({
			settings: { ...initial, tts: { ...initial.tts, enabled: false, model: "kokoro-82m" } },
		});
		useTtsModelPickerStore.getState().openFor(false);
		useTtsModelPickerStore.getState().commitInstalled("supertonic-en");
		const tts = useSettingsStore.getState().settings.tts;
		expect(tts.model).toBe("supertonic-en");
		expect(tts.enabled).toBe(false);
	});

	test("commitInstalled is a no-op when the picker is closed", () => {
		useTtsModelPickerStore.getState().close();
		const before = useSettingsStore.getState().settings.tts.model;
		useTtsModelPickerStore.getState().commitInstalled("ghost-model");
		expect(useSettingsStore.getState().settings.tts.model).toBe(before);
	});
});
