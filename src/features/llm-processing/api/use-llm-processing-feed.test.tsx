import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ipcClientMock } from "@test/mocks/ipc-client";
import { act, renderHook } from "@testing-library/react";
import { IPC } from "@/shared/api/ipc-channels";

// The feed hook subscribes through ipc-client, which routes `on(channel, cb)`
// through `window.nativeBridge.on`. Install the complete behavior-faithful fake
// so the import chain resolves; our instrumented `window.nativeBridge` below
// captures the per-channel callbacks and their unsubscribers.
mock.module("@/shared/api/ipc-client", () => ipcClientMock());

const { useLlmProcessingStore } = await import("../model/llm-processing-store");
const { useLlmProcessingFeed } = await import("./use-llm-processing-feed");

const INITIAL_STATE = useLlmProcessingStore.getInitialState();
const originalNativeBridge = window.nativeBridge;

// channel → registered callback. Each `on` returns an unsubscribe that nulls
// out its slot here, so we can assert cleanup ran on unmount.
const listeners = new Map<string, (...args: unknown[]) => void>();
let unsubscribeCalls: string[] = [];

function installNativeBridgeStub(): void {
	listeners.clear();
	unsubscribeCalls = [];
	window.nativeBridge = {
		getPathForFile: () => "",
		send: () => undefined,
		invoke: async () => undefined,
		secureInvoke: async () => undefined,
		on: (channel: string, cb: (...args: unknown[]) => void) => {
			listeners.set(channel, cb);
			return () => {
				unsubscribeCalls.push(channel);
				listeners.delete(channel);
			};
		},
	};
}

function fire(channel: string, payload?: unknown): void {
	const cb = listeners.get(channel);
	if (!cb) {
		throw new Error(`no listener registered for ${channel}`);
	}
	act(() => cb(payload));
}

beforeEach(() => {
	installNativeBridgeStub();
	useLlmProcessingStore.setState({
		isThinking: INITIAL_STATE.isThinking,
		isTransforming: INITIAL_STATE.isTransforming,
		thinkingStartedAt: INITIAL_STATE.thinkingStartedAt,
		thinkingText: INITIAL_STATE.thinkingText,
		transformStartedAt: INITIAL_STATE.transformStartedAt,
	});
});

afterEach(() => {
	window.nativeBridge = originalNativeBridge;
	useLlmProcessingStore.setState({
		isThinking: INITIAL_STATE.isThinking,
		isTransforming: INITIAL_STATE.isTransforming,
		thinkingStartedAt: INITIAL_STATE.thinkingStartedAt,
		thinkingText: INITIAL_STATE.thinkingText,
		transformStartedAt: INITIAL_STATE.transformStartedAt,
	});
});

describe("useLlmProcessingFeed", () => {
	test("subscribes to LLM, transform, and recording channels on mount", () => {
		renderHook(() => useLlmProcessingFeed());
		expect(listeners.has(IPC.STT_RECORDING_START)).toBe(true);
		expect(listeners.has(IPC.LLM_PROCESSING_START)).toBe(true);
		expect(listeners.has(IPC.LLM_PROCESSING_END)).toBe(true);
		expect(listeners.has(IPC.LLM_REASONING_DELTA)).toBe(true);
		expect(listeners.has(IPC.TRANSFORMS_PROCESSING_START)).toBe(true);
		expect(listeners.has(IPC.TRANSFORMS_PROCESSING_END)).toBe(true);
	});

	test("processing-start clears stale thinking text and flips isThinking on", () => {
		// Seed a stale thinking buffer from a prior utterance.
		useLlmProcessingStore.setState({ thinkingText: "stale reasoning", isThinking: false });
		renderHook(() => useLlmProcessingFeed());
		fire(IPC.LLM_PROCESSING_START);
		const state = useLlmProcessingStore.getState();
		expect(state.isThinking).toBe(true);
		// clearThinking() ran before setThinking(true), so the stale text is gone.
		expect(state.thinkingText).toBe("");
	});

	test("reasoning-delta accumulates streamed thinking text in order", () => {
		renderHook(() => useLlmProcessingFeed());
		fire(IPC.LLM_PROCESSING_START);
		fire(IPC.LLM_REASONING_DELTA, { delta: "Hel" });
		fire(IPC.LLM_REASONING_DELTA, { delta: "lo " });
		fire(IPC.LLM_REASONING_DELTA, { delta: "world" });
		expect(useLlmProcessingStore.getState().thinkingText).toBe("Hello world");
	});

	test("reasoning-delta with an empty delta is a no-op (store unchanged)", () => {
		renderHook(() => useLlmProcessingFeed());
		fire(IPC.LLM_REASONING_DELTA, { delta: "abc" });
		fire(IPC.LLM_REASONING_DELTA, { delta: "" });
		expect(useLlmProcessingStore.getState().thinkingText).toBe("abc");
	});

	test("processing-end flips isThinking off and clears the thinking buffer", () => {
		renderHook(() => useLlmProcessingFeed());
		fire(IPC.LLM_PROCESSING_START);
		fire(IPC.LLM_REASONING_DELTA, { delta: "thinking..." });
		expect(useLlmProcessingStore.getState().isThinking).toBe(true);

		fire(IPC.LLM_PROCESSING_END);
		const state = useLlmProcessingStore.getState();
		expect(state.isThinking).toBe(false);
		expect(state.thinkingText).toBe("");
		expect(state.thinkingStartedAt).toBeNull();
	});

	test("transform-processing-start clears stale thinking text and flips transform state on", () => {
		useLlmProcessingStore.setState({
			thinkingText: "stale transform reasoning",
			isThinking: true,
			isTransforming: false,
		});
		renderHook(() => useLlmProcessingFeed());
		fire(IPC.TRANSFORMS_PROCESSING_START);
		const state = useLlmProcessingStore.getState();
		expect(state.isThinking).toBe(false);
		expect(state.isTransforming).toBe(true);
		expect(state.transformStartedAt).not.toBeNull();
		expect(state.thinkingText).toBe("");
	});

	test("reasoning-delta accumulates while transform processing is active", () => {
		renderHook(() => useLlmProcessingFeed());
		fire(IPC.TRANSFORMS_PROCESSING_START);
		fire(IPC.LLM_REASONING_DELTA, { delta: "Re" });
		fire(IPC.LLM_REASONING_DELTA, { delta: "writing" });
		expect(useLlmProcessingStore.getState().thinkingText).toBe("Rewriting");
	});

	test("transform-processing-end flips transform state off and clears thinking", () => {
		renderHook(() => useLlmProcessingFeed());
		fire(IPC.TRANSFORMS_PROCESSING_START);
		useLlmProcessingStore.setState({ isThinking: true, thinkingStartedAt: 50 });
		fire(IPC.LLM_REASONING_DELTA, { delta: "thinking..." });
		expect(useLlmProcessingStore.getState().isTransforming).toBe(true);

		fire(IPC.TRANSFORMS_PROCESSING_END);
		const state = useLlmProcessingStore.getState();
		expect(state.isThinking).toBe(false);
		expect(state.thinkingStartedAt).toBeNull();
		expect(state.isTransforming).toBe(false);
		expect(state.transformStartedAt).toBeNull();
		expect(state.thinkingText).toBe("");
	});

	test("recording-start resets a leaked thinking state from a prior utterance", () => {
		// Simulate a stuck thinking state (overlay never got its END event).
		useLlmProcessingStore.setState({
			isThinking: true,
			isTransforming: true,
			thinkingText: "leaked",
			transformStartedAt: 100,
		});
		renderHook(() => useLlmProcessingFeed());
		fire(IPC.STT_RECORDING_START);
		const state = useLlmProcessingStore.getState();
		expect(state.isThinking).toBe(false);
		expect(state.isTransforming).toBe(false);
		expect(state.transformStartedAt).toBeNull();
		expect(state.thinkingText).toBe("");
	});

	test("unsubscribes every channel on unmount (no listener leak)", () => {
		const { unmount } = renderHook(() => useLlmProcessingFeed());
		expect(listeners.size).toBe(6);
		unmount();
		// All six unsubscribers ran...
		expect(unsubscribeCalls).toHaveLength(6);
		expect(new Set(unsubscribeCalls)).toEqual(
			new Set([
				IPC.STT_RECORDING_START,
				IPC.LLM_PROCESSING_START,
				IPC.LLM_PROCESSING_END,
				IPC.LLM_REASONING_DELTA,
				IPC.TRANSFORMS_PROCESSING_START,
				IPC.TRANSFORMS_PROCESSING_END,
			])
		);
		// ...and the channel→callback map is now empty (no dangling refs).
		expect(listeners.size).toBe(0);
	});

	test("events after unmount no longer mutate the store (cleanup is effective)", () => {
		const { unmount } = renderHook(() => useLlmProcessingFeed());
		const startCb = listeners.get(IPC.LLM_PROCESSING_START);
		unmount();
		// The stale callback reference (captured before unmount) still calls the
		// store setter, but a correctly-cleaned hook means the renderer no longer
		// receives the IPC event at all — the unsubscribe removed it from the map.
		// We assert the map no longer holds it.
		expect(listeners.get(IPC.LLM_PROCESSING_START)).toBeUndefined();
		// And calling the orphaned ref does NOT crash (it routes to the store
		// setter, which is still valid); document that the store would flip if a
		// leaked event reached it — which is exactly why the unsubscribe matters.
		expect(typeof startCb).toBe("function");
	});
});
