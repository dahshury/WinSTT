import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, type RenderHookResult, renderHook } from "@testing-library/react";
import { useSettingsStore } from "@/entities/setting";
import { IPC } from "@test/mocks/legacy-ipc";
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
	window.nativeBridge = originalApi;
	useSettingsStore.getState().resetSettings();
});

function fire(channel: string, ...args: unknown[]) {
	for (const cb of listeners.get(channel) ?? []) {
		cb(...args);
	}
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
