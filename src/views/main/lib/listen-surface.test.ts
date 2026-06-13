import { describe, expect, test } from "bun:test";
import { shouldUseListenSurface } from "@/features/listen-mode";

const BASE = {
	audioLevel: 0,
	hasEphemeral: false,
	isListenMode: true,
	isSpeaking: false,
	liveText: "",
};

describe("shouldUseListenSurface", () => {
	test("stays on the normal main surface when listen mode is idle", () => {
		expect(shouldUseListenSurface(BASE)).toBe(false);
	});

	test("ignores activity when the selected recording mode is not listen", () => {
		expect(
			shouldUseListenSurface({
				...BASE,
				audioLevel: 0.5,
				isListenMode: false,
				isSpeaking: true,
				liveText: "words",
			}),
		).toBe(false);
	});

	test("uses the listen surface for audible loopback audio", () => {
		expect(shouldUseListenSurface({ ...BASE, audioLevel: 0.02 })).toBe(true);
	});

	test("uses the listen surface while visible transcript content remains", () => {
		expect(shouldUseListenSurface({ ...BASE, liveText: "words" })).toBe(true);
		expect(shouldUseListenSurface({ ...BASE, hasEphemeral: true })).toBe(true);
	});

	test("keeps finalized scrollback from forcing the listen surface while idle", () => {
		expect(shouldUseListenSurface(BASE)).toBe(false);
	});
});
