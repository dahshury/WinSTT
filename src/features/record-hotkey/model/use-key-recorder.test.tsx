import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { IPC } from "@/shared/api/ipc-channels";
import { useKeyRecorder } from "./use-key-recorder";

const originalApi = window.nativeBridge;
const sentChannels: string[] = [];
const invokes: string[] = [];
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

function makeApi() {
	listeners.clear();
	sentChannels.length = 0;
	invokes.length = 0;
	return {
		...originalApi,
		invoke: async (channel: string) => {
			invokes.push(channel);
			return false;
		},
		send: (channel: string) => {
			sentChannels.push(channel);
		},
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
}

beforeEach(() => {
	window.nativeBridge = makeApi();
});

afterEach(() => {
	window.nativeBridge = originalApi;
});

function fire(channel: string, ...args: unknown[]) {
	for (const cb of listeners.get(channel) ?? []) {
		cb(...args);
	}
}

describe("useKeyRecorder", () => {
	test("initial state: not recording, no key, no liveKeys", () => {
		const { result } = renderHook(() => useKeyRecorder());
		expect(result.current.recording).toBe(false);
		expect(result.current.key).toBeNull();
		expect(result.current.liveKeys).toEqual([]);
	});

	test("subscribes to recording-update and recording-done channels on mount", () => {
		renderHook(() => useKeyRecorder());
		expect(listeners.has(IPC.HOTKEY_RECORDING_UPDATE)).toBe(true);
		expect(listeners.has(IPC.HOTKEY_RECORDING_DONE)).toBe(true);
	});

	test("startRecording sets recording=true and invokes hotkeyStartRecording", async () => {
		const { result } = renderHook(() => useKeyRecorder());
		act(() => result.current.startRecording());
		await waitFor(() => {
			expect(result.current.recording).toBe(true);
		});
		expect(invokes).toContain(IPC.HOTKEY_START_RECORDING);
	});

	test("stopRecording sets recording=false and sends stop-recording", async () => {
		const { result } = renderHook(() => useKeyRecorder());
		act(() => result.current.startRecording());
		act(() => result.current.stopRecording());
		await waitFor(() => {
			expect(result.current.recording).toBe(false);
		});
		expect(sentChannels).toContain(IPC.HOTKEY_STOP_RECORDING);
	});

	test("liveKeys updates as recording-update events fire", async () => {
		const { result } = renderHook(() => useKeyRecorder());
		act(() => result.current.startRecording());
		act(() => fire(IPC.HOTKEY_RECORDING_UPDATE, { keys: ["LCtrl", "A"] }));
		await waitFor(() => {
			expect(result.current.liveKeys).toEqual(["LCtrl", "A"]);
		});
	});

	test("recording-done event sets the final key, clears liveKeys, and stops recording", async () => {
		const { result } = renderHook(() => useKeyRecorder());
		act(() => result.current.startRecording());
		act(() => fire(IPC.HOTKEY_RECORDING_DONE, { combo: "LCtrl+A" }));
		await waitFor(() => {
			expect(result.current.key).toBe("LCtrl+A");
		});
		expect(result.current.recording).toBe(false);
		expect(result.current.liveKeys).toEqual([]);
	});

	test("recording-done event with null combo does not set a key", async () => {
		const { result } = renderHook(() => useKeyRecorder());
		act(() => result.current.startRecording());
		act(() => fire(IPC.HOTKEY_RECORDING_DONE, { combo: null }));
		await waitFor(() => {
			expect(result.current.recording).toBe(false);
		});
		expect(result.current.key).toBeNull();
	});

	test("clicking Stop then receiving the done reply still commits the recorded combo", async () => {
		const recorded: string[] = [];
		const { result } = renderHook(() => useKeyRecorder({ onKeyRecorded: (k) => recorded.push(k) }));

		act(() => result.current.startRecording());
		// Simulate live keypresses captured in main, then user clicks Stop.
		act(() => fire(IPC.HOTKEY_RECORDING_UPDATE, { keys: ["LCtrl", "T"] }));
		act(() => result.current.stopRecording());
		// Main responds to hotkey:stop-recording with the captured combo.
		act(() => fire(IPC.HOTKEY_RECORDING_DONE, { combo: "LCtrl+T" }));

		await waitFor(() => {
			expect(result.current.key).toBe("LCtrl+T");
		});
		expect(recorded).toEqual(["LCtrl+T"]);
		expect(result.current.recording).toBe(false);
	});

	test("recording-done only fires onKeyRecorded on the instance that started recording", async () => {
		const pttCalled: string[] = [];
		const ttsCalled: string[] = [];
		const ptt = {
			called: pttCalled,
			fn: (k: string) => {
				pttCalled.push(k);
			},
		};
		const tts = {
			called: ttsCalled,
			fn: (k: string) => {
				ttsCalled.push(k);
			},
		};

		const pttHook = renderHook(() => useKeyRecorder({ onKeyRecorded: ptt.fn }));
		const ttsHook = renderHook(() => useKeyRecorder({ onKeyRecorded: tts.fn }));

		// Only TTS starts recording — PTT is idle but still has its listener mounted.
		act(() => ttsHook.result.current.startRecording());
		act(() => fire(IPC.HOTKEY_RECORDING_DONE, { combo: "LCtrl+T" }));

		await waitFor(() => {
			expect(ttsHook.result.current.key).toBe("LCtrl+T");
		});
		expect(tts.called).toEqual(["LCtrl+T"]);
		expect(ptt.called).toEqual([]);
		expect(pttHook.result.current.key).toBeNull();
	});

	test("unmount unsubscribes both listeners", () => {
		const { unmount } = renderHook(() => useKeyRecorder());
		unmount();
		expect(listeners.get(IPC.HOTKEY_RECORDING_UPDATE)?.length ?? 0).toBe(0);
		expect(listeners.get(IPC.HOTKEY_RECORDING_DONE)?.length ?? 0).toBe(0);
	});
});
