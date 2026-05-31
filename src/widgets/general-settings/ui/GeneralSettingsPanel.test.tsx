import { afterEach, describe, expect, mock, test } from "bun:test";
import { render } from "@testing-library/react";
import type { useTranslations } from "use-intl";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useSettingsStore } from "@/entities/setting";
import {
	DEFAULT_WAKE_WORD,
	flagsToLiveDisplay,
	__general_settings_panel_test_helpers__ as helpers,
} from "../lib/general-settings-panel-test-helpers";
import { GeneralSettingsPanel } from "./GeneralSettingsPanel";

// `computeDisplayFlags`, `isBarVisualizer`, and `readStartupFlags` all accept
// the same `GeneralSettings | undefined` shape. Derive the real type from one
// of their signatures so partial fixtures use a proper boundary cast.
type GeneralSettings = NonNullable<Parameters<typeof helpers.computeDisplayFlags>[1]>;
type TranslateFn = ReturnType<typeof useTranslations>;

// Contained boundary casts. The runtime values are returned unchanged — only
// the static type is asserted so partial fixtures / stub callables satisfy the
// real signatures the helpers expect.
const asSettings = (s: Partial<GeneralSettings>) => s as unknown as GeneralSettings;
const asTranslate = (fn: (key: string, vars?: Record<string, unknown>) => string) =>
	fn as unknown as TranslateFn;

describe("GeneralSettingsPanel", () => {
	test("renders without crashing", () => {
		const { container } = render(
			<IntlProvider>
				<GeneralSettingsPanel />
			</IntlProvider>
		);
		expect(container.firstElementChild).not.toBeNull();
	});
});

describe("GeneralSettingsPanel — per-shape visualizer controls render", () => {
	const initial = useSettingsStore.getState().settings;
	afterEach(() => {
		useSettingsStore.setState({ settings: initial });
	});

	// Each visualizer type swaps in a different customization control group
	// (VisualizerShapeControls → VizSliderControl / VisualizerAuraShapeControl).
	// Mounting the panel per type exercises every group + the percent formatter.
	test.each([
		"bar",
		"grid",
		"radial",
		"wave",
		"aura",
	] as const)("mounts the %s customization controls", (visualizerType) => {
		useSettingsStore.setState({
			settings: { ...initial, general: { ...initial.general, visualizerType } },
		});
		const { container, unmount } = render(
			<IntlProvider>
				<GeneralSettingsPanel />
			</IntlProvider>
		);
		expect(container.firstElementChild).not.toBeNull();
		unmount();
	});
});

const tStub = asTranslate((key: string, vars?: Record<string, unknown>) =>
	vars ? `${key}:${JSON.stringify(vars)}` : key
);

describe("GeneralSettingsPanel helpers — buildVisualizerTypeOptions", () => {
	test("returns 5 entries with stable ids", () => {
		const opts = helpers.buildVisualizerTypeOptions(tStub);
		expect(opts).toHaveLength(5);
		expect(opts.map((o) => o.id)).toEqual(["bar", "grid", "radial", "wave", "aura"]);
	});

	test("each option has a label and an icon", () => {
		const opts = helpers.buildVisualizerTypeOptions(tStub);
		for (const opt of opts) {
			expect(typeof opt.label).toBe("string");
			expect(opt.icon).toBeDefined();
		}
	});
});

describe("GeneralSettingsPanel helpers — buildRecordingModeOptions", () => {
	test("returns ptt/toggle/listen/wakeword", () => {
		const opts = helpers.buildRecordingModeOptions(tStub);
		expect(opts.map((o) => o.value)).toEqual(["ptt", "toggle", "listen", "wakeword"]);
	});

	test("each option has an icon", () => {
		const opts = helpers.buildRecordingModeOptions(tStub);
		for (const opt of opts) {
			expect(opt.icon).toBeDefined();
		}
	});
});

describe("GeneralSettingsPanel helpers — pickLocale", () => {
	test("calls setter for valid locale", () => {
		const setLocale = mock(() => undefined);
		helpers.pickLocale("en", setLocale);
		expect(setLocale).toHaveBeenCalledWith("en");
	});

	test("ignores invalid locale", () => {
		const setLocale = mock(() => undefined);
		helpers.pickLocale("xx", setLocale);
		expect(setLocale).not.toHaveBeenCalled();
	});
});

describe("GeneralSettingsPanel helpers — muteLevel", () => {
	const cases: [{ systemAudioReductionWhileDictating?: number } | undefined, number][] = [
		[{ systemAudioReductionWhileDictating: 100 }, 100],
		[{ systemAudioReductionWhileDictating: 80 }, 80],
		[{ systemAudioReductionWhileDictating: 0 }, 0],
		[undefined, 0],
	];
	test.each(cases)("settings=%j -> %s", (settings, expected) => {
		expect(helpers.muteLevel(settings as never)).toBe(expected);
	});
});

describe("GeneralSettingsPanel helpers — muteEnabled", () => {
	const cases: [{ systemAudioReductionWhileDictating?: number } | undefined, boolean][] = [
		[{ systemAudioReductionWhileDictating: 100 }, true],
		[{ systemAudioReductionWhileDictating: 20 }, true],
		[{ systemAudioReductionWhileDictating: 0 }, false],
		[undefined, false],
	];
	test.each(cases)("settings=%j -> %s", (settings, expected) => {
		expect(helpers.muteEnabled(settings as never)).toBe(expected);
	});
});

describe("GeneralSettingsPanel helpers — reduction slider mapping", () => {
	// Slider stops, left → right, monotonically increasing: Off(0), 20, 40, 60, 80, Mute(100).
	const stops: [number, number][] = [
		[0, 0],
		[1, 20],
		[2, 40],
		[3, 60],
		[4, 80],
		[5, 100],
	];

	test.each(stops)("index %s ↔ reduction %s", (index, pct) => {
		expect(helpers.indexToReduction(index)).toBe(pct);
		expect(helpers.reductionToIndex(pct)).toBe(index);
	});

	test("reductionToIndex falls back to the Off stop for an unknown percent", () => {
		expect(helpers.reductionToIndex(37)).toBe(0);
	});

	test("indexToReduction falls back to 0 (Off) for an out-of-range index", () => {
		expect(helpers.indexToReduction(99)).toBe(0);
		expect(helpers.indexToReduction(-1)).toBe(0);
	});

	test("reductionStepLabel: 0 → Off, 100 → Mute, else N%", () => {
		expect(helpers.reductionStepLabel(0, tStub)).toBe("systemAudioReductionOff");
		expect(helpers.reductionStepLabel(100, tStub)).toBe("systemAudioReductionMute");
		expect(helpers.reductionStepLabel(80, tStub)).toBe("80%");
		expect(helpers.reductionStepLabel(20, tStub)).toBe("20%");
	});
});

describe("GeneralSettingsPanel helpers — computeDisplayFlags", () => {
	test("overlay enabled when shown and not listen mode", () => {
		const flags = helpers.computeDisplayFlags(false, asSettings({ showRecordingOverlay: true }));
		expect(flags).toEqual({
			overlayEnabled: true,
			subDisabled: false,
		});
	});

	test("listen mode disables the overlay/size picker", () => {
		// The combined live-transcription picker is always visible — it IS the
		// realtime on/off switch now (see realtime-enabled.ts) — so this only
		// gates the overlay-dependent visualizer controls.
		const flags = helpers.computeDisplayFlags(true, asSettings({ showRecordingOverlay: true }));
		expect(flags.overlayEnabled).toBe(false);
		expect(flags.subDisabled).toBe(true);
	});

	test("overlay hidden disables overlay-dependent sub-controls", () => {
		const flags = helpers.computeDisplayFlags(false, asSettings({ showRecordingOverlay: false }));
		expect(flags.overlayEnabled).toBe(false);
		expect(flags.subDisabled).toBe(true);
	});
});

describe("GeneralSettingsPanel helpers — live display ↔ recording overlay", () => {
	test("liveOverlayDisabled reflects showRecordingOverlay (default true)", () => {
		expect(helpers.liveOverlayDisabled(undefined)).toBe(false);
		expect(helpers.liveOverlayDisabled({ showRecordingOverlay: true } as never)).toBe(false);
		expect(helpers.liveOverlayDisabled({ showRecordingOverlay: false } as never)).toBe(true);
	});

	test("needsOverlay is true only for in-pill and both", () => {
		expect(helpers.needsOverlay("in-pill")).toBe(true);
		expect(helpers.needsOverlay("both")).toBe(true);
		expect(helpers.needsOverlay("in-app")).toBe(false);
		expect(helpers.needsOverlay("none")).toBe(false);
	});

	test("effectiveLiveDisplay collapses overlay-dependent choices to in-app when overlay off", () => {
		expect(helpers.effectiveLiveDisplay("both", true)).toBe("in-app");
		expect(helpers.effectiveLiveDisplay("in-pill", true)).toBe("in-app");
		expect(helpers.effectiveLiveDisplay("none", true)).toBe("none");
		expect(helpers.effectiveLiveDisplay("in-app", true)).toBe("in-app");
		// Overlay enabled → value is left untouched.
		expect(helpers.effectiveLiveDisplay("both", false)).toBe("both");
		expect(helpers.effectiveLiveDisplay("in-pill", false)).toBe("in-pill");
	});

	test("overlayTogglePatch: enabling just turns the overlay on", () => {
		expect(helpers.overlayTogglePatch(true, { liveTranscriptionDisplay: "both" } as never)).toEqual(
			{ showRecordingOverlay: true }
		);
	});

	test("overlayTogglePatch: disabling reverts an overlay-dependent live choice to in-app", () => {
		expect(
			helpers.overlayTogglePatch(false, { liveTranscriptionDisplay: "both" } as never)
		).toEqual({ showRecordingOverlay: false, liveTranscriptionDisplay: "in-app" });
		expect(
			helpers.overlayTogglePatch(false, { liveTranscriptionDisplay: "in-pill" } as never)
		).toEqual({ showRecordingOverlay: false, liveTranscriptionDisplay: "in-app" });
	});

	test("overlayTogglePatch: disabling leaves in-app/none untouched", () => {
		expect(
			helpers.overlayTogglePatch(false, { liveTranscriptionDisplay: "in-app" } as never)
		).toEqual({ showRecordingOverlay: false });
		expect(
			helpers.overlayTogglePatch(false, { liveTranscriptionDisplay: "none" } as never)
		).toEqual({ showRecordingOverlay: false });
	});

	test("overlayTogglePatch: missing setting defaults to 'both' → reverts on disable", () => {
		expect(helpers.overlayTogglePatch(false, undefined)).toEqual({
			showRecordingOverlay: false,
			liveTranscriptionDisplay: "in-app",
		});
	});

	test("buildLiveTranscriptionDisplayOptions disables in-pill/both only when overlay is off", () => {
		const tStubFn = ((k: string) => k) as never;
		const enabled = helpers.buildLiveTranscriptionDisplayOptions(tStubFn, false);
		expect(enabled.every((o) => !o.disabled)).toBe(true);

		const disabled = helpers.buildLiveTranscriptionDisplayOptions(tStubFn, true);
		const byValue = Object.fromEntries(disabled.map((o) => [o.value, o.disabled ?? false]));
		expect(byValue["in-pill"]).toBe(true);
		expect(byValue.both).toBe(true);
		expect(byValue["in-app"]).toBe(false);
		expect(byValue.none).toBe(false);
	});

	test("isLiveTranscriptionDisplayValue narrows the four valid values", () => {
		for (const v of ["none", "in-app", "in-pill", "both"]) {
			expect(helpers.isLiveTranscriptionDisplayValue(v)).toBe(true);
		}
		expect(helpers.isLiveTranscriptionDisplayValue("nope")).toBe(false);
	});
});

describe("GeneralSettingsPanel helpers — checkedOrFalseIfDisabled", () => {
	const cases: [boolean, boolean, boolean][] = [
		[true, true, false],
		[true, false, false],
		[false, true, true],
		[false, false, false],
	];
	test.each(cases)("disabled=%s value=%s -> %s", (disabled, value, expected) => {
		expect(helpers.checkedOrFalseIfDisabled(disabled, value)).toBe(expected);
	});
});

describe("GeneralSettingsPanel helpers — pickVisualizerType", () => {
	test("calls update for valid visualizer type", () => {
		const update = mock(() => undefined);
		helpers.pickVisualizerType("bar", update);
		expect(update).toHaveBeenCalledWith({ visualizerType: "bar" });
	});

	test("ignores invalid visualizer type", () => {
		const update = mock(() => undefined);
		helpers.pickVisualizerType("not-a-type", update);
		expect(update).not.toHaveBeenCalled();
	});
});

describe("GeneralSettingsPanel helpers — isBarVisualizer", () => {
	test("true when general missing (defaults to bar)", () => {
		expect(helpers.isBarVisualizer(undefined)).toBe(true);
	});

	test("false for non-bar types", () => {
		expect(helpers.isBarVisualizer(asSettings({ visualizerType: "wave" }))).toBe(false);
	});
});

describe("GeneralSettingsPanel helpers — getVisualizerType", () => {
	test("defaults to bar when general is missing", () => {
		expect(helpers.getVisualizerType(undefined)).toBe("bar");
	});

	test("returns the configured visualizer type", () => {
		expect(helpers.getVisualizerType(asSettings({ visualizerType: "aura" }))).toBe("aura");
		expect(helpers.getVisualizerType(asSettings({ visualizerType: "radial" }))).toBe("radial");
	});
});

describe("GeneralSettingsPanel helpers — buildAuraShapeSwitcherOptions", () => {
	test("returns circle and line options with labels", () => {
		const opts = helpers.buildAuraShapeSwitcherOptions(tStub);
		expect(opts.map((o) => o.value)).toEqual(["circle", "line"]);
		for (const opt of opts) {
			expect(typeof opt.label).toBe("string");
		}
	});
});

describe("GeneralSettingsPanel helpers — pickAuraShape", () => {
	test("calls update for valid shapes", () => {
		const update = mock(() => undefined);
		helpers.pickAuraShape("circle", update);
		expect(update).toHaveBeenCalledWith({ visualizerAuraShape: "circle" });
		helpers.pickAuraShape("line", update);
		expect(update).toHaveBeenCalledWith({ visualizerAuraShape: "line" });
	});

	test("ignores anything off the enum", () => {
		const update = mock(() => undefined);
		helpers.pickAuraShape("triangle", update);
		expect(update).not.toHaveBeenCalled();
	});
});

describe("GeneralSettingsPanel helpers — readBoolFlag", () => {
	const cases: [boolean | undefined, boolean, boolean][] = [
		[true, false, true],
		[false, true, false],
		[undefined, true, true],
		[undefined, false, false],
	];
	test.each(cases)("readBoolFlag(%s, %s) -> %s", (value, fallback, expected) => {
		expect(helpers.readBoolFlag(value, fallback)).toBe(expected);
	});
});

describe("GeneralSettingsPanel helpers — readStartupFlags", () => {
	test("uses defaults when general is undefined", () => {
		expect(helpers.readStartupFlags(undefined)).toEqual({
			autoStart: false,
			startMinimized: false,
			minimizeToTray: true,
			sendCrashReports: true,
		});
	});

	test("respects explicit values", () => {
		const flags = helpers.readStartupFlags(
			asSettings({
				autoStart: true,
				startMinimized: true,
				minimizeToTray: false,
				sendCrashReports: false,
			})
		);
		expect(flags).toEqual({
			autoStart: true,
			startMinimized: true,
			minimizeToTray: false,
			sendCrashReports: false,
		});
	});
});

describe("GeneralSettingsPanel helpers — flagsToLiveDisplay (covers internal flagsKey)", () => {
	// Drives the 2-bit FLAGS_TO_LIVE_DISPLAY table indirectly so that every
	// flagsKey branch ("00" | "01" | "10" | "11") is hit at least once.
	const cases: [boolean, boolean, "none" | "in-pill" | "in-app" | "both"][] = [
		[false, false, "none"],
		[false, true, "in-pill"],
		[true, false, "in-app"],
		[true, true, "both"],
	];
	test.each(cases)("inApp=%s inOverlay=%s -> %s", (inApp, inOverlay, expected) => {
		expect(flagsToLiveDisplay(inApp, inOverlay)).toBe(expected);
	});
});

describe("GeneralSettingsPanel helpers — reconcileWakeWord", () => {
	test("keeps a known wake word as-is", () => {
		expect(helpers.reconcileWakeWord("jarvis")).toBe("jarvis");
	});

	test("falls back to DEFAULT_WAKE_WORD for undefined", () => {
		expect(helpers.reconcileWakeWord(undefined)).toBe(DEFAULT_WAKE_WORD);
	});

	test("falls back to DEFAULT_WAKE_WORD for an unknown word", () => {
		expect(helpers.reconcileWakeWord("definitely-not-a-wake-word")).toBe(DEFAULT_WAKE_WORD);
	});
});

describe("GeneralSettingsPanel helpers — recordingModePatch (covers internal wakeWordPatch)", () => {
	test("non-wake modes return just the recordingMode patch", () => {
		expect(helpers.recordingModePatch("ptt", "jarvis")).toEqual({ recordingMode: "ptt" });
		expect(helpers.recordingModePatch("toggle", undefined)).toEqual({
			recordingMode: "toggle",
		});
		expect(helpers.recordingModePatch("listen", "anything")).toEqual({
			recordingMode: "listen",
		});
	});

	test("wakeword mode with known current word reuses it (no wakeWord patch)", () => {
		expect(helpers.recordingModePatch("wakeword", "jarvis")).toEqual({
			recordingMode: "wakeword",
		});
	});

	test("wakeword mode with undefined current word reconciles to DEFAULT", () => {
		expect(helpers.recordingModePatch("wakeword", undefined)).toEqual({
			recordingMode: "wakeword",
			wakeWord: DEFAULT_WAKE_WORD,
		});
	});

	test("wakeword mode with unknown current word reconciles to DEFAULT", () => {
		expect(helpers.recordingModePatch("wakeword", "made-up-word")).toEqual({
			recordingMode: "wakeword",
			wakeWord: DEFAULT_WAKE_WORD,
		});
	});
});
