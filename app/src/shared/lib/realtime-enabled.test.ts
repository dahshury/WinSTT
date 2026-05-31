import { describe, expect, test } from "bun:test";
import { isPillVisible, isRealtimeEnabled } from "./realtime-enabled";

describe("isPillVisible", () => {
	test("true when overlay on and display includes pill", () => {
		expect(isPillVisible({ showRecordingOverlay: true, liveTranscriptionDisplay: "in-pill" })).toBe(
			true
		);
		expect(isPillVisible({ showRecordingOverlay: true, liveTranscriptionDisplay: "both" })).toBe(
			true
		);
	});

	test("false when overlay off, regardless of display", () => {
		for (const display of ["none", "in-app", "in-pill", "both"] as const) {
			expect(
				isPillVisible({ showRecordingOverlay: false, liveTranscriptionDisplay: display })
			).toBe(false);
		}
	});

	test("false when overlay on but display excludes pill", () => {
		expect(isPillVisible({ showRecordingOverlay: true, liveTranscriptionDisplay: "none" })).toBe(
			false
		);
		expect(isPillVisible({ showRecordingOverlay: true, liveTranscriptionDisplay: "in-app" })).toBe(
			false
		);
	});
});

describe("isRealtimeEnabled", () => {
	test("false when display is 'none' regardless of overlay", () => {
		for (const overlay of [true, false]) {
			expect(
				isRealtimeEnabled({
					showRecordingOverlay: overlay,
					liveTranscriptionDisplay: "none",
				})
			).toBe(false);
		}
	});

	test("true when display includes 'in-app', overlay state irrelevant", () => {
		for (const overlay of [true, false]) {
			expect(
				isRealtimeEnabled({
					showRecordingOverlay: overlay,
					liveTranscriptionDisplay: "in-app",
				})
			).toBe(true);
			expect(
				isRealtimeEnabled({
					showRecordingOverlay: overlay,
					liveTranscriptionDisplay: "both",
				})
			).toBe(true);
		}
	});

	test("'in-pill' requires overlay to be visible", () => {
		expect(
			isRealtimeEnabled({
				showRecordingOverlay: true,
				liveTranscriptionDisplay: "in-pill",
			})
		).toBe(true);
		expect(
			isRealtimeEnabled({
				showRecordingOverlay: false,
				liveTranscriptionDisplay: "in-pill",
			})
		).toBe(false);
	});
});
