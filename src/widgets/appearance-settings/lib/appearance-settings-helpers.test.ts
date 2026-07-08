import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "@/entities/setting";
import {
	effectiveLiveDisplay,
	flagsToLiveDisplay,
	liveDisplayToFlags,
	overlaySliderPatch,
} from "./appearance-settings-helpers";

function general(
	overrides: Partial<typeof DEFAULT_SETTINGS.general>,
): typeof DEFAULT_SETTINGS.general {
	return { ...DEFAULT_SETTINGS.general, ...overrides };
}

describe("overlaySliderPatch", () => {
	test("turning the overlay OFF never touches word-by-word pasting", () => {
		// Word-by-word pasting is a PASTE behavior, not a display surface — it
		// must survive the overlay being hidden (it keeps the realtime engine
		// alive on its own, see `isRealtimeEnabled`). Regression guard: the
		// overlay-off patch may only write overlay/display keys.
		for (const display of ["none", "in-app", "in-pill", "both"] as const) {
			const patch = overlaySliderPatch(
				0,
				general({
					liveTranscriptionDisplay: display,
					wordByWordPasting: true,
				}),
			);
			expect(patch).not.toContainKey("wordByWordPasting");
			expect(patch.showRecordingOverlay).toBe(false);
		}
	});

	test("overlay OFF reverts overlay-only displays to in-app", () => {
		expect(
			overlaySliderPatch(0, general({ liveTranscriptionDisplay: "in-pill" })),
		).toEqual({
			showRecordingOverlay: false,
			liveTranscriptionDisplay: "in-app",
		});
		expect(
			overlaySliderPatch(0, general({ liveTranscriptionDisplay: "both" })),
		).toEqual({
			showRecordingOverlay: false,
			liveTranscriptionDisplay: "in-app",
		});
	});

	test("overlay OFF leaves non-overlay displays untouched", () => {
		expect(
			overlaySliderPatch(0, general({ liveTranscriptionDisplay: "in-app" })),
		).toEqual({ showRecordingOverlay: false });
		expect(
			overlaySliderPatch(0, general({ liveTranscriptionDisplay: "none" })),
		).toEqual({ showRecordingOverlay: false });
	});

	test("size indices turn the overlay ON without touching other settings", () => {
		const patch = overlaySliderPatch(
			1,
			general({ wordByWordPasting: true, liveTranscriptionDisplay: "none" }),
		);
		expect(patch.showRecordingOverlay).toBe(true);
		expect(patch).not.toContainKey("wordByWordPasting");
		expect(patch).not.toContainKey("liveTranscriptionDisplay");
	});
});

describe("live display flag round-trip", () => {
	test("both checkboxes off maps to 'none'", () => {
		expect(flagsToLiveDisplay(false, false)).toBe("none");
	});

	test("flags → display → flags is lossless", () => {
		for (const inApp of [true, false]) {
			for (const inOverlay of [true, false]) {
				expect(
					liveDisplayToFlags(flagsToLiveDisplay(inApp, inOverlay)),
				).toEqual({ inApp, inOverlay });
			}
		}
	});

	test("effectiveLiveDisplay downgrades overlay-only displays when overlay hidden", () => {
		expect(effectiveLiveDisplay("in-pill", true)).toBe("in-app");
		expect(effectiveLiveDisplay("both", true)).toBe("in-app");
		expect(effectiveLiveDisplay("in-app", true)).toBe("in-app");
		expect(effectiveLiveDisplay("none", true)).toBe("none");
	});
});
