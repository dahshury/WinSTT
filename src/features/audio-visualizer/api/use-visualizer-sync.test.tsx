import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, type RenderHookResult, renderHook } from "@testing-library/react";
import { useSettingsStore } from "@/entities/setting";
import { IPC } from "@test/mocks/legacy-ipc";
import { useVisualizerStore } from "../model/visualizer-store";
import { useVisualizerSync } from "./use-visualizer-sync";

const originalApi = window.nativeBridge;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
const frameCallbacks = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;
// Track every mounted hook so afterEach can tear down its subscriptions and
// any event-triggered frame that has not fired yet.
let mountedHooks: RenderHookResult<unknown, unknown>[] = [];
function renderHookTracked<T>(cb: () => T): RenderHookResult<T, void> {
	const result = renderHook(cb);
	mountedHooks.push(result as RenderHookResult<unknown, unknown>);
	return result;
}

beforeEach(() => {
	listeners.clear();
	frameCallbacks.clear();
	nextFrameId = 1;
	globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
		const id = nextFrameId;
		nextFrameId += 1;
		frameCallbacks.set(id, callback);
		return id;
	};
	globalThis.cancelAnimationFrame = (id: number) => {
		frameCallbacks.delete(id);
	};
	useVisualizerStore.setState({
		isRecording: false,
		isSpeaking: false,
		audioLevel: 0,
		sentencePulse: 0,
	});
	useSettingsStore.getState().resetSettings();
	window.nativeBridge = {
		...originalApi,
		on: (channel: string, cb: (...args: unknown[]) => void) => {
			const list = listeners.get(channel) ?? [];
			list.push(cb);
			listeners.set(channel, list);
			return () => {
				listeners.set(
					channel,
					(listeners.get(channel) ?? []).filter((x) => x !== cb),
				);
			};
		},
	};
});

afterEach(() => {
	for (const h of mountedHooks) {
		h.unmount();
	}
	mountedHooks = [];
	globalThis.requestAnimationFrame = originalRequestAnimationFrame;
	globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
	window.nativeBridge = originalApi;
	useSettingsStore.getState().resetSettings();
});

function fire(channel: string, ...args: unknown[]) {
	for (const cb of listeners.get(channel) ?? []) {
		cb(...args);
	}
}

function runNextFrame(): void {
	const next = frameCallbacks.entries().next().value;
	if (!next) {
		throw new Error("Expected a scheduled animation frame");
	}
	const [id, callback] = next;
	frameCallbacks.delete(id);
	act(() => callback(performance.now()));
}

function drainFrames(limit = 100): number {
	let count = 0;
	while (frameCallbacks.size > 0) {
		if (count >= limit) {
			throw new Error(`Animation frames did not settle within ${limit} ticks`);
		}
		runNextFrame();
		count += 1;
	}
	return count;
}

describe("useVisualizerSync", () => {
	test("subscribes to all visualizer-sync channels", () => {
		renderHookTracked(() => useVisualizerSync());
		for (const ch of [
			IPC.STT_RECORDING_START,
			IPC.STT_RECORDING_STOP,
			IPC.STT_VAD_START,
			IPC.STT_VAD_STOP,
			IPC.STT_AUDIO_LEVEL,
			IPC.STT_FULL_SENTENCE,
			IPC.STT_LOOPBACK_STOPPED,
		]) {
			expect(listeners.has(ch)).toBe(true);
		}
	});

	test("recording-start sets isRecording=true", () => {
		renderHookTracked(() => useVisualizerSync());
		fire(IPC.STT_RECORDING_START);
		expect(useVisualizerStore.getState().isRecording).toBe(true);
		expect(frameCallbacks.size).toBe(0);
	});

	test("coalesces audio-level events into one frame and does not poll afterward", () => {
		renderHookTracked(() => useVisualizerSync());
		fire(IPC.STT_RECORDING_START);

		fire(IPC.STT_AUDIO_LEVEL, { level: 0.2 });
		fire(IPC.STT_AUDIO_LEVEL, { level: 0.7 });

		expect(frameCallbacks.size).toBe(1);
		expect(useVisualizerStore.getState().audioLevel).toBe(0);

		runNextFrame();

		expect(useVisualizerStore.getState().audioLevel).toBe(0.7);
		expect(frameCallbacks.size).toBe(0);
	});

	test("reacts on the first session when the retained snapshot restores recording state", () => {
		renderHookTracked(() => useVisualizerSync());

		// The first overlay WebView can mount after recording-start was already
		// emitted. Its lifecycle reconciliation restores this retained state, but
		// the hook never receives the missed recording-start edge.
		act(() => useVisualizerStore.getState().recordingStarted());
		fire(IPC.STT_AUDIO_LEVEL, { level: 0.65 });

		expect(frameCallbacks.size).toBe(1);
		runNextFrame();
		expect(useVisualizerStore.getState().audioLevel).toBe(0.65);
		expect(frameCallbacks.size).toBe(0);
	});

	test("ignores audio-level and sentence events outside an active recording", () => {
		renderHookTracked(() => useVisualizerSync());

		fire(IPC.STT_AUDIO_LEVEL, { level: 0.7 });
		fire(IPC.STT_FULL_SENTENCE, { text: "done" });

		expect(frameCallbacks.size).toBe(0);
		expect(useVisualizerStore.getState().audioLevel).toBe(0);
		expect(useVisualizerStore.getState().sentencePulse).toBe(0);
	});

	test("runs sentence pulse decay only until it reaches zero", () => {
		renderHookTracked(() => useVisualizerSync());
		fire(IPC.STT_RECORDING_START);

		fire(IPC.STT_FULL_SENTENCE, { text: "done" });
		expect(frameCallbacks.size).toBe(1);

		runNextFrame();
		expect(useVisualizerStore.getState().sentencePulse).toBe(1);
		expect(frameCallbacks.size).toBe(1);

		const decayFrames = drainFrames();
		expect(decayFrames).toBeGreaterThan(0);
		expect(useVisualizerStore.getState().sentencePulse).toBe(0);
		expect(frameCallbacks.size).toBe(0);
	});

	test("recording-stop cancels pending audio and pulse frames", () => {
		renderHookTracked(() => useVisualizerSync());
		fire(IPC.STT_RECORDING_START);
		fire(IPC.STT_AUDIO_LEVEL, { level: 0.8 });
		fire(IPC.STT_FULL_SENTENCE, { text: "done" });
		expect(frameCallbacks.size).toBe(2);

		fire(IPC.STT_RECORDING_STOP);

		expect(frameCallbacks.size).toBe(0);
		expect(useVisualizerStore.getState().audioLevel).toBe(0);
		expect(useVisualizerStore.getState().sentencePulse).toBe(0);
	});

	test("recording-stop clears isRecording and isSpeaking", () => {
		renderHookTracked(() => useVisualizerSync());
		fire(IPC.STT_RECORDING_START);
		useVisualizerStore.setState({ isSpeaking: true });
		fire(IPC.STT_RECORDING_STOP);
		expect(useVisualizerStore.getState().isRecording).toBe(false);
		expect(useVisualizerStore.getState().isSpeaking).toBe(false);
	});

	test("vad-start and vad-stop toggle isSpeaking", () => {
		renderHookTracked(() => useVisualizerSync());
		fire(IPC.STT_VAD_START);
		expect(useVisualizerStore.getState().isSpeaking).toBe(true);
		fire(IPC.STT_VAD_STOP);
		expect(useVisualizerStore.getState().isSpeaking).toBe(false);
	});

	test("recordingMode change resets stale isRecording (mode-switch bug fix)", () => {
		renderHookTracked(() => useVisualizerSync());
		fire(IPC.STT_RECORDING_START);
		expect(useVisualizerStore.getState().isRecording).toBe(true);

		// Switching mode (e.g. listen -> ptt) never emits a recording-lifecycle
		// event on its own — this is the bug: without the mode-change reset,
		// isRecording stays stuck true and the stale rAF loop keeps ticking.
		act(() => {
			useSettingsStore
				.getState()
				.updateGeneralSettings({ recordingMode: "listen" });
		});

		expect(useVisualizerStore.getState().isRecording).toBe(false);
		expect(useVisualizerStore.getState().isSpeaking).toBe(false);
		expect(useVisualizerStore.getState().audioLevel).toBe(0);
		expect(useVisualizerStore.getState().sentencePulse).toBe(0);
	});

	test("recordingMode change to the same value is a no-op (no redundant reset)", () => {
		renderHookTracked(() => useVisualizerSync());
		fire(IPC.STT_RECORDING_START);
		useVisualizerStore.setState({ audioLevel: 0.4 });

		// Re-applying the same mode (default "ptt") must not reset an
		// in-progress recording.
		act(() => {
			useSettingsStore
				.getState()
				.updateGeneralSettings({ recordingMode: "ptt" });
		});

		expect(useVisualizerStore.getState().isRecording).toBe(true);
		expect(useVisualizerStore.getState().audioLevel).toBe(0.4);
	});

	test("mounting the hook does not reset an idle store just from reading recordingMode", () => {
		useSettingsStore
			.getState()
			.updateGeneralSettings({ recordingMode: "listen" });
		renderHookTracked(() => useVisualizerSync());
		// isRecording was already false; mounting must not itself flip anything.
		expect(useVisualizerStore.getState().isRecording).toBe(false);
	});

	test("loopback-stopped event resets stale isRecording", () => {
		renderHookTracked(() => useVisualizerSync());
		fire(IPC.STT_RECORDING_START);
		expect(useVisualizerStore.getState().isRecording).toBe(true);

		fire(IPC.STT_LOOPBACK_STOPPED);

		expect(useVisualizerStore.getState().isRecording).toBe(false);
		expect(useVisualizerStore.getState().isSpeaking).toBe(false);
		expect(useVisualizerStore.getState().audioLevel).toBe(0);
		expect(useVisualizerStore.getState().sentencePulse).toBe(0);
	});

	test("unmount unsubscribes all listeners", () => {
		const { unmount } = renderHook(() => useVisualizerSync());
		unmount();
		for (const ch of [
			IPC.STT_RECORDING_START,
			IPC.STT_RECORDING_STOP,
			IPC.STT_VAD_START,
			IPC.STT_VAD_STOP,
			IPC.STT_AUDIO_LEVEL,
			IPC.STT_FULL_SENTENCE,
			IPC.STT_LOOPBACK_STOPPED,
		]) {
			expect(listeners.get(ch)?.length ?? 0).toBe(0);
		}
	});
});
