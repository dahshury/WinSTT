import { describe, expect, test } from "bun:test";
import {
	isPillVisible,
	isRealtimeEnabled,
	realtimeMasterTogglePatch,
	shouldSuppressPillPreviewForWordByWordPaste,
} from "./realtime-enabled";

describe("isPillVisible", () => {
	test("true when overlay on and display includes pill", () => {
		expect(
			isPillVisible({
				showRecordingOverlay: true,
				liveTranscriptionDisplay: "in-pill",
			}),
		).toBe(true);
		expect(
			isPillVisible({
				showRecordingOverlay: true,
				liveTranscriptionDisplay: "both",
			}),
		).toBe(true);
	});

	test("false when overlay off, regardless of display", () => {
		for (const display of ["none", "in-app", "in-pill", "both"] as const) {
			expect(
				isPillVisible({
					showRecordingOverlay: false,
					liveTranscriptionDisplay: display,
				}),
			).toBe(false);
		}
	});

	test("false when overlay on but display excludes pill", () => {
		expect(
			isPillVisible({
				showRecordingOverlay: true,
				liveTranscriptionDisplay: "none",
			}),
		).toBe(false);
		expect(
			isPillVisible({
				showRecordingOverlay: true,
				liveTranscriptionDisplay: "in-app",
			}),
		).toBe(false);
	});
});

describe("isRealtimeEnabled", () => {
	test("false when display is 'none' regardless of overlay", () => {
		for (const overlay of [true, false]) {
			expect(
				isRealtimeEnabled({
					showRecordingOverlay: overlay,
					liveTranscriptionDisplay: "none",
				}),
			).toBe(false);
		}
	});

	test("true when word-by-word paste is enabled, regardless of display", () => {
		for (const overlay of [true, false]) {
			expect(
				isRealtimeEnabled({
					showRecordingOverlay: overlay,
					liveTranscriptionDisplay: "none",
					wordByWordPasting: true,
				}),
			).toBe(true);
		}
	});

	test("word-by-word realtime override still wins if stale LLM dictation state is present", () => {
		expect(
			isRealtimeEnabled({
				showRecordingOverlay: false,
				liveTranscriptionDisplay: "none",
				wordByWordPasting: true,
				llmDictationEnabled: true,
			}),
		).toBe(true);
	});

	test("true when display includes 'in-app', overlay state irrelevant", () => {
		for (const overlay of [true, false]) {
			expect(
				isRealtimeEnabled({
					showRecordingOverlay: overlay,
					liveTranscriptionDisplay: "in-app",
				}),
			).toBe(true);
			expect(
				isRealtimeEnabled({
					showRecordingOverlay: overlay,
					liveTranscriptionDisplay: "both",
				}),
			).toBe(true);
		}
	});

	test("'in-pill' requires overlay to be visible", () => {
		expect(
			isRealtimeEnabled({
				showRecordingOverlay: true,
				liveTranscriptionDisplay: "in-pill",
			}),
		).toBe(true);
		expect(
			isRealtimeEnabled({
				showRecordingOverlay: false,
				liveTranscriptionDisplay: "in-pill",
			}),
		).toBe(false);
	});
});

describe("shouldSuppressPillPreviewForWordByWordPaste", () => {
	test("true when word-by-word paste reuses the main realtime model", () => {
		expect(
			shouldSuppressPillPreviewForWordByWordPaste({
				mainModelId: "native-stream",
				realtimeModelId: "native-stream",
				useMainModelForRealtime: true,
				wordByWordPasting: true,
			}),
		).toBe(true);
	});

	test("false when word-by-word paste uses a separate realtime model", () => {
		expect(
			shouldSuppressPillPreviewForWordByWordPaste({
				mainModelId: "offline-main",
				realtimeModelId: "native-stream",
				useMainModelForRealtime: false,
				wordByWordPasting: true,
			}),
		).toBe(false);
	});

	test("false when the main model is not marked as the realtime source", () => {
		expect(
			shouldSuppressPillPreviewForWordByWordPaste({
				mainModelId: "native-stream",
				realtimeModelId: "native-stream",
				useMainModelForRealtime: false,
				wordByWordPasting: true,
			}),
		).toBe(false);
	});

	test("false when word-by-word paste is off", () => {
		expect(
			shouldSuppressPillPreviewForWordByWordPaste({
				mainModelId: "native-stream",
				realtimeModelId: "native-stream",
				useMainModelForRealtime: true,
				wordByWordPasting: false,
			}),
		).toBe(false);
	});

	test("true when stale LLM dictation state is present", () => {
		expect(
			shouldSuppressPillPreviewForWordByWordPaste({
				mainModelId: "native-stream",
				realtimeModelId: "native-stream",
				useMainModelForRealtime: true,
				wordByWordPasting: true,
				llmDictationEnabled: true,
			}),
		).toBe(true);
	});
});

describe("realtimeMasterTogglePatch", () => {
	test("ON restores the default display surfaces and nothing else", () => {
		// The overlay setting must be left alone: "both" already enables the
		// in-app panel regardless of overlay state, and clobbering the user's
		// overlay choice would be a hidden cross-setting write.
		expect(realtimeMasterTogglePatch(true)).toEqual({
			liveTranscriptionDisplay: "both",
		});
	});

	test("OFF removes every realtime consumer so the derived state flips", () => {
		// Word-by-word pasting is a realtime consumer (isRealtimeEnabled
		// short-circuits true on it) — leaving it on would keep the engine
		// loaded and the switch stuck ON.
		expect(realtimeMasterTogglePatch(false)).toEqual({
			liveTranscriptionDisplay: "none",
			wordByWordPasting: false,
		});
	});

	test("round-trips through isRealtimeEnabled regardless of overlay", () => {
		for (const overlay of [true, false]) {
			expect(
				isRealtimeEnabled({
					showRecordingOverlay: overlay,
					...realtimeMasterTogglePatch(true),
				}),
			).toBe(true);
			expect(
				isRealtimeEnabled({
					showRecordingOverlay: overlay,
					...realtimeMasterTogglePatch(false),
				}),
			).toBe(false);
		}
	});
});
