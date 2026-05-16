import { describe, expect, mock, test } from "bun:test";
import { render } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import {
	GeneralSettingsPanel,
	__general_settings_panel_test_helpers__ as helpers,
} from "./GeneralSettingsPanel";

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

const tStub = ((key: string, vars?: Record<string, unknown>) =>
	vars ? `${key}:${JSON.stringify(vars)}` : key) as any;

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

describe("GeneralSettingsPanel helpers — muteCaption", () => {
	test("returns disabled caption in listen mode", () => {
		expect(helpers.muteCaption(true, tStub)).toBe("muteSystemAudioCaptionDisabled");
	});

	test("returns normal caption outside listen mode", () => {
		expect(helpers.muteCaption(false, tStub)).toBe("muteSystemAudioCaption");
	});
});

describe("GeneralSettingsPanel helpers — muteLevel", () => {
	const cases: [boolean, { systemAudioReductionWhileDictating?: number } | undefined, number][] = [
		[true, { systemAudioReductionWhileDictating: 100 }, 0],
		[false, { systemAudioReductionWhileDictating: 100 }, 100],
		[false, { systemAudioReductionWhileDictating: 80 }, 80],
		[false, { systemAudioReductionWhileDictating: 0 }, 0],
		[false, undefined, 0],
	];
	test.each(cases)("listen=%s settings=%j -> %s", (listen, settings, expected) => {
		expect(helpers.muteLevel(listen, settings as never)).toBe(expected);
	});
});

describe("GeneralSettingsPanel helpers — muteEnabled", () => {
	const cases: [boolean, { systemAudioReductionWhileDictating?: number } | undefined, boolean][] = [
		[false, { systemAudioReductionWhileDictating: 100 }, true],
		[false, { systemAudioReductionWhileDictating: 20 }, true],
		[false, { systemAudioReductionWhileDictating: 0 }, false],
		[true, { systemAudioReductionWhileDictating: 100 }, false],
		[false, undefined, false],
	];
	test.each(cases)("listen=%s settings=%j -> %s", (listen, settings, expected) => {
		expect(helpers.muteEnabled(listen, settings as never)).toBe(expected);
	});
});

describe("GeneralSettingsPanel helpers — reduction slider mapping", () => {
	// Slider stops, left → right, monotonically increasing: 20, 40, 60, 80, Mute(100).
	const stops: [number, number][] = [
		[0, 20],
		[1, 40],
		[2, 60],
		[3, 80],
		[4, 100],
	];

	test.each(stops)("index %s ↔ reduction %s", (index, pct) => {
		expect(helpers.indexToReduction(index)).toBe(pct);
		expect(helpers.reductionToIndex(pct)).toBe(index);
	});

	test("reductionToIndex falls back to the top stop (Mute) for an unknown percent", () => {
		expect(helpers.reductionToIndex(37)).toBe(4);
		expect(helpers.reductionToIndex(0)).toBe(4);
	});

	test("indexToReduction falls back to the default (100) for an out-of-range index", () => {
		expect(helpers.indexToReduction(99)).toBe(100);
		expect(helpers.indexToReduction(-1)).toBe(100);
	});

	test("reductionStepLabel: 100 → Mute, else N%", () => {
		expect(helpers.reductionStepLabel(100, tStub)).toBe("systemAudioReductionMute");
		expect(helpers.reductionStepLabel(80, tStub)).toBe("80%");
		expect(helpers.reductionStepLabel(20, tStub)).toBe("20%");
	});
});

describe("GeneralSettingsPanel helpers — soundToggleChecked", () => {
	const cases: [boolean, boolean, boolean][] = [
		[true, true, false],
		[false, true, true],
		[false, false, false],
	];
	test.each(cases)("listen=%s enabled=%s -> %s", (listen, enabled, expected) => {
		expect(helpers.soundToggleChecked(listen, enabled)).toBe(expected);
	});
});

describe("GeneralSettingsPanel helpers — computeDisplayFlags", () => {
	test("everything enabled when overlay shown, not listen, realtime on", () => {
		const flags = helpers.computeDisplayFlags(false, { showRecordingOverlay: true } as any, true);
		expect(flags).toEqual({
			overlayEnabled: true,
			subDisabled: false,
			liveDisplayDisabled: false,
		});
	});

	test("listen mode disables the overlay/size picker but leaves the live-transcription picker enabled", () => {
		// liveDisplayDisabled hinges only on realtime — listen mode keeps the
		// in-app option meaningful so the picker stays interactable.
		const flags = helpers.computeDisplayFlags(true, { showRecordingOverlay: true } as any, true);
		expect(flags.overlayEnabled).toBe(false);
		expect(flags.subDisabled).toBe(true);
		expect(flags.liveDisplayDisabled).toBe(false);
	});

	test("realtime off disables the combined live-transcription picker", () => {
		const flags = helpers.computeDisplayFlags(false, { showRecordingOverlay: true } as any, false);
		expect(flags.liveDisplayDisabled).toBe(true);
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
		expect(helpers.isBarVisualizer({ visualizerType: "wave" } as any)).toBe(false);
	});
});

describe("GeneralSettingsPanel helpers — dropZoneClass", () => {
	test("includes accent classes when dragOver", () => {
		expect(helpers.dropZoneClass(true)).toContain("border-accent");
	});

	test("uses transparent border otherwise", () => {
		expect(helpers.dropZoneClass(false)).toContain("border-transparent");
	});
});

describe("GeneralSettingsPanel helpers — displaySoundPath", () => {
	test("returns the path when present", () => {
		expect(helpers.displaySoundPath("/tmp/a.mp3", tStub)).toBe("/tmp/a.mp3");
	});

	test("returns the default translation when empty", () => {
		expect(helpers.displaySoundPath("", tStub)).toBe("soundFileDefault");
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
		});
	});

	test("respects explicit values", () => {
		const flags = helpers.readStartupFlags({
			autoStart: true,
			startMinimized: true,
			minimizeToTray: false,
		} as any);
		expect(flags).toEqual({
			autoStart: true,
			startMinimized: true,
			minimizeToTray: false,
		});
	});
});
