import { describe, expect, test } from "bun:test";
import { nextRecordingMode } from "./use-recording-mode-cycle";

describe("nextRecordingMode", () => {
	test("advances through the ptt → toggle → wakeword → listen chain", () => {
		expect(nextRecordingMode("ptt")).toBe("toggle");
		expect(nextRecordingMode("toggle")).toBe("wakeword");
		expect(nextRecordingMode("wakeword")).toBe("listen");
	});

	test("wraps listen back to ptt", () => {
		expect(nextRecordingMode("listen")).toBe("ptt");
	});

	test("restarts the cycle at ptt for an unknown mode", () => {
		expect(nextRecordingMode("nonsense")).toBe("ptt");
		expect(nextRecordingMode("")).toBe("ptt");
	});
});
