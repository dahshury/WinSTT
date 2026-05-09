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
	test("returns ptt/toggle/listen", () => {
		const opts = helpers.buildRecordingModeOptions(tStub);
		expect(opts.map((o) => o.value)).toEqual(["ptt", "toggle", "listen"]);
	});

	test("each option has an icon", () => {
		const opts = helpers.buildRecordingModeOptions(tStub);
		for (const opt of opts) {
			expect(opt.icon).toBeDefined();
		}
	});
});

describe("GeneralSettingsPanel helpers — buildTranscriptionFormatOptions", () => {
	test("returns txt and srt formats", () => {
		const opts = helpers.buildTranscriptionFormatOptions(tStub);
		expect(opts.map((o) => o.value)).toEqual(["txt", "srt"]);
	});

	test("labels are TXT and SRT", () => {
		const opts = helpers.buildTranscriptionFormatOptions(tStub);
		expect(opts[0]?.label).toBe("TXT");
		expect(opts[1]?.label).toBe("SRT");
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

describe("GeneralSettingsPanel helpers — muteChecked", () => {
	const cases: [boolean, { muteSystemAudioWhileDictating?: boolean } | undefined, boolean][] = [
		[true, { muteSystemAudioWhileDictating: true }, false],
		[false, { muteSystemAudioWhileDictating: true }, true],
		[false, { muteSystemAudioWhileDictating: false }, false],
		[false, undefined, false],
	];
	test.each(cases)("listen=%s settings=%j -> %s", (listen, settings, expected) => {
		expect(helpers.muteChecked(listen, settings as any)).toBe(expected);
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
			pillLiveDisabled: false,
			inAppLiveDisabled: false,
		});
	});

	test("listen mode disables overlay-derived flags", () => {
		const flags = helpers.computeDisplayFlags(true, { showRecordingOverlay: true } as any, true);
		expect(flags.overlayEnabled).toBe(false);
		expect(flags.subDisabled).toBe(true);
		expect(flags.pillLiveDisabled).toBe(true);
		expect(flags.inAppLiveDisabled).toBe(false);
	});

	test("realtime off disables in-app live and pill live", () => {
		const flags = helpers.computeDisplayFlags(false, { showRecordingOverlay: true } as any, false);
		expect(flags.pillLiveDisabled).toBe(true);
		expect(flags.inAppLiveDisabled).toBe(true);
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
