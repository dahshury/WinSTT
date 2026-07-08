import { describe, expect, test } from "bun:test";
import { nextRecordingMode } from "./use-recording-mode-cycle";

describe("nextRecordingMode", () => {
	test("advances through the ptt → toggle → listen → wakeword chain", () => {
		expect(nextRecordingMode("ptt")).toBe("toggle");
		expect(nextRecordingMode("toggle")).toBe("listen");
		expect(nextRecordingMode("listen")).toBe("wakeword");
	});

	test("wraps wakeword back to ptt", () => {
		expect(nextRecordingMode("wakeword")).toBe("ptt");
	});

	test("restarts the cycle at ptt for an unknown mode", () => {
		expect(nextRecordingMode("nonsense")).toBe("ptt");
		expect(nextRecordingMode("")).toBe("ptt");
	});
});
