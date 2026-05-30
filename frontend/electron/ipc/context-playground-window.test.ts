import { describe, expect, mock, test } from "bun:test";
import { electronMock } from "../../test/mocks/electron";

mock.module("electron", () => electronMock());
// Avoid the real store's top-level migration side effects under test.
mock.module("../lib/store", () => ({ getStoreValue: () => undefined }));

const { decideTick, __context_playground_test_helpers__ } = await import(
	"./context-playground-window"
);
const { isLivePayload, pushReport, pushWaiting, __setLastWaitReason, __getLastWaitReason } =
	__context_playground_test_helpers__;

const BASE = {
	alive: true,
	armedDeep: false,
	capturing: false,
	liveEnabled: true,
	ownFocus: false,
	visible: true,
} as const;

describe("decideTick", () => {
	test("stopped when window is destroyed; hidden when minimized/parked", () => {
		expect(decideTick({ ...BASE, alive: false })).toBe("stopped");
		// Hidden keeps the loop alive (so it resumes on restore) but skips capture.
		expect(decideTick({ ...BASE, visible: false })).toBe("hidden");
	});

	test("skip-capturing while a capture is in flight", () => {
		expect(decideTick({ ...BASE, capturing: true })).toBe("skip-capturing");
	});

	test("wait-off when live is off and nothing is armed", () => {
		expect(decideTick({ ...BASE, liveEnabled: false, armedDeep: false })).toBe("wait-off");
	});

	test("armed deep overrides live-off (so a one-shot still fires)", () => {
		// live off but armed + external focus → capture-deep
		expect(decideTick({ ...BASE, liveEnabled: false, armedDeep: true })).toBe("capture-deep");
	});

	test("wait-own when one of our windows holds focus (never read our own UI)", () => {
		expect(decideTick({ ...BASE, ownFocus: true })).toBe("wait-own");
		// armed but own-focus still waits — the deep arm is preserved for the
		// next external tick.
		expect(decideTick({ ...BASE, ownFocus: true, armedDeep: true })).toBe("wait-own");
	});

	test("capture-live on an external field with live on", () => {
		expect(decideTick(BASE)).toBe("capture-live");
	});

	test("capture-deep on an external field when armed", () => {
		expect(decideTick({ ...BASE, armedDeep: true })).toBe("capture-deep");
	});
});

describe("isLivePayload", () => {
	test("accepts a boolean enabled flag", () => {
		expect(isLivePayload({ enabled: true })).toBe(true);
		expect(isLivePayload({ enabled: false })).toBe(true);
	});

	test("rejects malformed payloads", () => {
		expect(isLivePayload(null)).toBe(false);
		expect(isLivePayload({})).toBe(false);
		expect(isLivePayload({ enabled: "yes" })).toBe(false);
		expect(isLivePayload("enabled")).toBe(false);
	});
});

describe("waiting heartbeat dedup", () => {
	test("repeated same reason updates state once; a report resets it", () => {
		__setLastWaitReason(null);
		pushWaiting("live-off");
		expect(__getLastWaitReason()).toBe("live-off");
		pushWaiting("live-off");
		expect(__getLastWaitReason()).toBe("live-off");
		pushWaiting("own-window-focused");
		expect(__getLastWaitReason()).toBe("own-window-focused");
		// A real report clears the wait state so the next wait re-pushes.
		pushReport({
			at: 1,
			kind: "report",
			report: {
				asrPromptTail: "",
				asrPromptTailRaw: "",
				capturedAt: 1,
				contentless: false,
				contextAwarenessEnabled: false,
				deep: false,
				denied: false,
				deniedReason: null,
				durationMs: 0,
				filteredSnapshot: { windowTitle: "", elementName: "", focusedText: "" },
				hasCaret: false,
				isIde: false,
				isTerminal: false,
				metrics: {
					axHtmlCap: 150_000,
					axHtmlChars: 0,
					denyListSize: 0,
					focusedTextChars: 0,
					promptFragmentChars: 0,
					textAfterChars: 0,
					textBeforeChars: 0,
				},
				ocrUsed: false,
				promptFragment: "",
				rawSnapshot: { windowTitle: "", elementName: "", focusedText: "" },
			},
		});
		expect(__getLastWaitReason()).toBeNull();
	});
});
