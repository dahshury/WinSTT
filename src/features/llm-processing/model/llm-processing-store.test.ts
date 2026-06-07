import { beforeEach, describe, expect, test } from "bun:test";
import {
	appendThinkingPatch,
	nextThinkingStart,
	nextTransformStart,
	thinkingPatch,
	thinkingStopPatch,
	transformPatch,
	transformStopPatch,
	useLlmProcessingStore,
} from "./llm-processing-store";

beforeEach(() => {
	useLlmProcessingStore.setState({
		isThinking: false,
		isTransforming: false,
		thinkingStartedAt: null,
		thinkingText: "",
		transformStartedAt: null,
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
		expect(thinkingStopPatch()).toEqual({
			isThinking: false,
			thinkingStartedAt: null,
		});
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

describe("nextTransformStart", () => {
	test("seeds transformStartedAt when none is set", () => {
		const patch = nextTransformStart(null, 1000);
		expect(patch).toEqual({ isTransforming: true, transformStartedAt: 1000 });
	});

	test("preserves an existing transform start across duplicate triggers", () => {
		const patch = nextTransformStart(500, 1000);
		expect(patch).toEqual({ isTransforming: true, transformStartedAt: 500 });
	});
});

describe("transformStopPatch", () => {
	test("clears transform state", () => {
		expect(transformStopPatch()).toEqual({
			isTransforming: false,
			transformStartedAt: null,
		});
	});
});

describe("transformPatch", () => {
	test("picks the start patch when value is true", () => {
		const patch = transformPatch(true, null);
		expect(patch.isTransforming).toBe(true);
		expect(patch.transformStartedAt).toBeTypeOf("number");
	});

	test("picks the stop patch when value is false", () => {
		expect(transformPatch(false, 100)).toEqual({
			isTransforming: false,
			transformStartedAt: null,
		});
	});

	test("trueâ†’true preserves the original transform start", () => {
		const patch = transformPatch(true, 1234);
		expect(patch.transformStartedAt).toBe(1234);
	});
});

describe("appendThinkingPatch", () => {
	test("returns null for an empty chunk so the store can no-op", () => {
		expect(appendThinkingPatch("hello", "")).toBeNull();
	});

	test("concatenates a chunk onto the current text", () => {
		expect(appendThinkingPatch("hello ", "world")).toEqual({
			thinkingText: "hello world",
		});
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
		useLlmProcessingStore.setState({
			isThinking: true,
			thinkingStartedAt: 100,
		});
		useLlmProcessingStore.getState().setThinking(false);
		const s = useLlmProcessingStore.getState();
		expect(s.isThinking).toBe(false);
		expect(s.thinkingStartedAt).toBeNull();
	});

	test("setThinking(true) again does NOT bump the start (monotonic)", () => {
		useLlmProcessingStore.setState({
			isThinking: true,
			thinkingStartedAt: 100,
		});
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

	test("setTransforming(true) flips isTransforming and stamps a start", () => {
		useLlmProcessingStore.getState().setTransforming(true);
		const s = useLlmProcessingStore.getState();
		expect(s.isTransforming).toBe(true);
		expect(s.transformStartedAt).not.toBeNull();
	});

	test("setTransforming(false) clears transform state", () => {
		useLlmProcessingStore.setState({
			isTransforming: true,
			transformStartedAt: 100,
		});
		useLlmProcessingStore.getState().setTransforming(false);
		const s = useLlmProcessingStore.getState();
		expect(s.isTransforming).toBe(false);
		expect(s.transformStartedAt).toBeNull();
	});

	test("setTransforming(true) again does NOT bump the start", () => {
		useLlmProcessingStore.setState({
			isTransforming: true,
			transformStartedAt: 100,
		});
		useLlmProcessingStore.getState().setTransforming(true);
		expect(useLlmProcessingStore.getState().transformStartedAt).toBe(100);
	});
});
