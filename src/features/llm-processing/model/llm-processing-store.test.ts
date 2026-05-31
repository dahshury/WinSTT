import { beforeEach, describe, expect, test } from "bun:test";
import {
	appendThinkingPatch,
	nextThinkingStart,
	thinkingPatch,
	thinkingStopPatch,
	useLlmProcessingStore,
} from "./llm-processing-store";

beforeEach(() => {
	useLlmProcessingStore.setState({
		isThinking: false,
		thinkingStartedAt: null,
		thinkingText: "",
	});
});

describe("nextThinkingStart", () => {
	test("seeds thinkingStartedAt when none is set", () => {
		const patch = nextThinkingStart(null, 1000);
		expect(patch).toEqual({ isThinking: true, thinkingStartedAt: 1000 });
	});

	test("preserves an existing start across duplicate triggers (monotonic)", () => {
		const patch = nextThinkingStart(500, 1000);
		expect(patch).toEqual({ isThinking: true, thinkingStartedAt: 500 });
	});
});

describe("thinkingStopPatch", () => {
	test("clears both flags", () => {
		expect(thinkingStopPatch()).toEqual({ isThinking: false, thinkingStartedAt: null });
	});
});

describe("thinkingPatch", () => {
	test("picks the start patch when value is true", () => {
		const patch = thinkingPatch(true, null);
		expect(patch.isThinking).toBe(true);
		expect(patch.thinkingStartedAt).toBeTypeOf("number");
	});

	test("picks the stop patch when value is false", () => {
		expect(thinkingPatch(false, 100)).toEqual({
			isThinking: false,
			thinkingStartedAt: null,
		});
	});

	test("true→true preserves the original start (monotonic)", () => {
		const patch = thinkingPatch(true, 1234);
		expect(patch.thinkingStartedAt).toBe(1234);
	});
});

describe("appendThinkingPatch", () => {
	test("returns null for an empty chunk so the store can no-op", () => {
		expect(appendThinkingPatch("hello", "")).toBeNull();
	});

	test("concatenates a chunk onto the current text", () => {
		expect(appendThinkingPatch("hello ", "world")).toEqual({ thinkingText: "hello world" });
	});
});

describe("useLlmProcessingStore", () => {
	test("setThinking(true) flips isThinking and stamps a start", () => {
		useLlmProcessingStore.getState().setThinking(true);
		const s = useLlmProcessingStore.getState();
		expect(s.isThinking).toBe(true);
		expect(s.thinkingStartedAt).not.toBeNull();
	});

	test("setThinking(false) clears both flags", () => {
		useLlmProcessingStore.setState({ isThinking: true, thinkingStartedAt: 100 });
		useLlmProcessingStore.getState().setThinking(false);
		const s = useLlmProcessingStore.getState();
		expect(s.isThinking).toBe(false);
		expect(s.thinkingStartedAt).toBeNull();
	});

	test("setThinking(true) again does NOT bump the start (monotonic)", () => {
		useLlmProcessingStore.setState({ isThinking: true, thinkingStartedAt: 100 });
		useLlmProcessingStore.getState().setThinking(true);
		expect(useLlmProcessingStore.getState().thinkingStartedAt).toBe(100);
	});

	test("appendThinking concatenates chunks", () => {
		useLlmProcessingStore.getState().appendThinking("foo");
		useLlmProcessingStore.getState().appendThinking("bar");
		expect(useLlmProcessingStore.getState().thinkingText).toBe("foobar");
	});

	test("appendThinking with empty chunk is a no-op", () => {
		useLlmProcessingStore.setState({ thinkingText: "abc" });
		useLlmProcessingStore.getState().appendThinking("");
		expect(useLlmProcessingStore.getState().thinkingText).toBe("abc");
	});

	test("clearThinking resets the accumulated text", () => {
		useLlmProcessingStore.setState({ thinkingText: "stuff" });
		useLlmProcessingStore.getState().clearThinking();
		expect(useLlmProcessingStore.getState().thinkingText).toBe("");
	});
});
