import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import { useTtsModelPickerStore } from "./tts-model-picker-store";

const initial = useSettingsStore.getState().settings;

beforeEach(() => {
	useSettingsStore.setState({ settings: { ...initial } });
	useTtsModelPickerStore.getState().close();
	// `close()` deliberately preserves the pending turn-on intent, so tests
	// must reset it explicitly.
	useTtsModelPickerStore.setState({ pendingEnable: null });
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
		expect(s.sourceOnInstall).toBeNull();
	});

	test("openFor can remember a local-source commit", () => {
		useTtsModelPickerStore.getState().openFor(true, "local");
		const s = useTtsModelPickerStore.getState();
		expect(s.open).toBe(true);
		expect(s.sourceOnInstall).toBe("local");
	});

	test("close resets the coordination state", () => {
		useTtsModelPickerStore.getState().openFor(true, "local");
		useTtsModelPickerStore.getState().close();
		const s = useTtsModelPickerStore.getState();
		expect(s.open).toBe(false);
		expect(s.enableOnInstall).toBe(false);
		expect(s.sourceOnInstall).toBeNull();
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

	test("commitInstalled can switch back to the local source after a forced local pick", () => {
		useSettingsStore.setState({
			settings: {
				...initial,
				tts: { ...initial.tts, enabled: true, source: "cloud" },
			},
		});
		useTtsModelPickerStore.getState().openFor(true, "local");
		useTtsModelPickerStore.getState().commitInstalled("piper-en-us");
		const tts = useSettingsStore.getState().settings.tts;
		expect(tts.model).toBe("piper-en-us");
		expect(tts.enabled).toBe(true);
		expect(tts.source).toBe("local");
	});

	test("enable with an empty hotkey folds the default speak binding in", () => {
		useSettingsStore.setState({
			settings: {
				...initial,
				tts: { ...initial.tts, hotkey: "", enabled: false },
			},
		});
		useTtsModelPickerStore.getState().openFor(true);
		useTtsModelPickerStore.getState().commitInstalled("kitten-tts-nano");
		const tts = useSettingsStore.getState().settings.tts;
		expect(tts.enabled).toBe(true);
		expect(tts.hotkey).toBe(DEFAULT_SETTINGS.tts.hotkey);
	});

	test("enable preserves an existing user hotkey", () => {
		useSettingsStore.setState({
			settings: {
				...initial,
				tts: { ...initial.tts, hotkey: "LCtrl+Alt+R", enabled: false },
			},
		});
		useTtsModelPickerStore.getState().openFor(true);
		useTtsModelPickerStore.getState().commitInstalled("kokoro-82m");
		expect(useSettingsStore.getState().settings.tts.hotkey).toBe("LCtrl+Alt+R");
	});

	test("commitInstalled WITHOUT enable intent (browse) sets the model but leaves enabled off", () => {
		useSettingsStore.setState({
			settings: {
				...initial,
				tts: { ...initial.tts, enabled: false, model: "kokoro-82m" },
			},
		});
		useTtsModelPickerStore.getState().openFor(false);
		useTtsModelPickerStore.getState().commitInstalled("supertonic-3");
		const tts = useSettingsStore.getState().settings.tts;
		expect(tts.model).toBe("supertonic-3");
		expect(tts.enabled).toBe(false);
	});

	test("commitInstalled is a no-op when the picker is closed", () => {
		useTtsModelPickerStore.getState().close();
		const before = useSettingsStore.getState().settings.tts.model;
		useTtsModelPickerStore.getState().commitInstalled("ghost-model");
		expect(useSettingsStore.getState().settings.tts.model).toBe(before);
	});

	test("a download started in a turn-on session keeps its commit rights after close", () => {
		// The background-download UX: enable toggle → picker opens → download
		// starts → user closes the picker (or switches apps). When the download
		// lands, the toggle must still flip on.
		useTtsModelPickerStore.getState().openFor(true, "local");
		useTtsModelPickerStore.getState().trackEnableDownload("piper-en-us");
		useTtsModelPickerStore.getState().close();
		useTtsModelPickerStore.getState().commitInstalled("piper-en-us");
		const tts = useSettingsStore.getState().settings.tts;
		expect(tts.model).toBe("piper-en-us");
		expect(tts.enabled).toBe(true);
		expect(tts.source).toBe("local");
		expect(useTtsModelPickerStore.getState().pendingEnable).toBeNull();
	});

	test("an unrelated completion while closed does NOT commit, even with a pending intent", () => {
		useTtsModelPickerStore.getState().openFor(true);
		useTtsModelPickerStore.getState().trackEnableDownload("piper-en-us");
		useTtsModelPickerStore.getState().close();
		const before = useSettingsStore.getState().settings.tts;
		useTtsModelPickerStore.getState().commitInstalled("kokoro-82m");
		const tts = useSettingsStore.getState().settings.tts;
		expect(tts.model).toBe(before.model);
		expect(tts.enabled).toBe(before.enabled);
		// The parked download is still eligible.
		expect(useTtsModelPickerStore.getState().pendingEnable?.models).toEqual([
			"piper-en-us",
		]);
	});

	test("cancelling the last pending download clears the parked intent", () => {
		useTtsModelPickerStore.getState().openFor(true);
		useTtsModelPickerStore.getState().trackEnableDownload("piper-en-us");
		useTtsModelPickerStore.getState().close();
		useTtsModelPickerStore.getState().untrackEnableDownload("piper-en-us");
		expect(useTtsModelPickerStore.getState().pendingEnable).toBeNull();
		const before = useSettingsStore.getState().settings.tts;
		useTtsModelPickerStore.getState().commitInstalled("piper-en-us");
		expect(useSettingsStore.getState().settings.tts.enabled).toBe(
			before.enabled,
		);
	});

	test("browse-session downloads never arm the pending intent", () => {
		useTtsModelPickerStore.getState().openFor(false);
		useTtsModelPickerStore.getState().trackEnableDownload("piper-en-us");
		expect(useTtsModelPickerStore.getState().pendingEnable).toBeNull();
	});

	test("a live commit resolves any parked intent (latest interaction wins)", () => {
		useTtsModelPickerStore.getState().openFor(true);
		useTtsModelPickerStore.getState().trackEnableDownload("piper-en-us");
		useTtsModelPickerStore.getState().close();
		// User reopens and settles on a cached model instead.
		useTtsModelPickerStore.getState().openFor(true);
		useTtsModelPickerStore.getState().commitInstalled("kokoro-82m");
		expect(useTtsModelPickerStore.getState().pendingEnable).toBeNull();
	});
});
