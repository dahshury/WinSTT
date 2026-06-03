import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type RenderHookResult, renderHook } from "@testing-library/react";
import { IPC } from "@/shared/api/ipc-channels";
import { useVisualizerStore } from "../model/visualizer-store";
import { useVisualizerSync } from "./use-visualizer-sync";

const originalApi = window.nativeBridge;
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
// Track every mounted hook so afterEach can tear them down — without an
// explicit unmount, useVisualizerSync's rAF loop keeps running across test
// files (bun:test doesn't isolate hook state) and continually calls
// `setAudioLevel(0)`, racing with sibling tests like use-multiband-volume
// that set audioLevel non-zero and expect it to stay.
let mountedHooks: RenderHookResult<unknown, unknown>[] = [];
function renderHookTracked<T>(cb: () => T): RenderHookResult<T, void> {
	const result = renderHook(cb);
	mountedHooks.push(result as RenderHookResult<unknown, unknown>);
	return result;
}

beforeEach(() => {
	listeners.clear();
	useVisualizerStore.setState({
		isRecording: false,
		isSpeaking: false,
		audioLevel: 0,
		sentencePulse: 0,
	});
	window.nativeBridge = {
		...originalApi,
		on: (channel: string, cb: (...args: unknown[]) => void) => {
			const list = listeners.get(channel) ?? [];
			list.push(cb);
			listeners.set(channel, list);
			return () => {
				listeners.set(
					channel,
					(listeners.get(channel) ?? []).filter((x) => x !== cb)
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
	window.nativeBridge = originalApi;
});

function fire(channel: string, ...args: unknown[]) {
	for (const cb of listeners.get(channel) ?? []) {
		cb(...args);
	}
}

describe("useVisualizerSync", () => {
	test("subscribes to all six visualizer-sync channels", () => {
		renderHookTracked(() => useVisualizerSync());
		for (const ch of [
			IPC.STT_RECORDING_START,
			IPC.STT_RECORDING_STOP,
			IPC.STT_VAD_START,
			IPC.STT_VAD_STOP,
			IPC.STT_AUDIO_LEVEL,
			IPC.STT_FULL_SENTENCE,
		]) {
			expect(listeners.has(ch)).toBe(true);
		}
	});

	test("recording-start sets isRecording=true", () => {
		renderHookTracked(() => useVisualizerSync());
		fire(IPC.STT_RECORDING_START);
		expect(useVisualizerStore.getState().isRecording).toBe(true);
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
		]) {
			expect(listeners.get(ch)?.length ?? 0).toBe(0);
		}
	});
});
