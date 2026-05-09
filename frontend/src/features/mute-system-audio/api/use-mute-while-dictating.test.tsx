import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { IPC } from "@/shared/api/ipc-channels";
import { useMuteWhileDictating } from "./use-mute-while-dictating";

const originalApi = window.electronAPI;
const sentChannels: Array<{ channel: string; args: unknown[] }> = [];
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

function makeApi() {
	listeners.clear();
	sentChannels.length = 0;
	return {
		...originalApi,
		send: (channel: string, ...args: unknown[]) => {
			sentChannels.push({ channel, args });
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
	window.electronAPI = makeApi();
});

afterEach(() => {
	window.electronAPI = originalApi;
});

function fire(channel: string) {
	for (const cb of listeners.get(channel) ?? []) {
		cb();
	}
}

describe("useMuteWhileDictating", () => {
	test("does NOT subscribe when enabled=false", () => {
		renderHook(() => useMuteWhileDictating(false));
		expect(listeners.has(IPC.STT_RECORDING_START)).toBe(false);
	});

	test("subscribes to recording start/stop when enabled=true", () => {
		renderHook(() => useMuteWhileDictating(true));
		expect(listeners.has(IPC.STT_RECORDING_START)).toBe(true);
		expect(listeners.has(IPC.STT_RECORDING_STOP)).toBe(true);
	});

	test("recording-start mutes system audio (audio:set-mute true)", () => {
		renderHook(() => useMuteWhileDictating(true));
		fire(IPC.STT_RECORDING_START);
		expect(
			sentChannels.some(
				(c) => c.channel === IPC.AUDIO_SET_MUTE && (c.args[0] as { muted: boolean }).muted === true
			)
		).toBe(true);
	});

	test("recording-stop unmutes system audio (audio:set-mute false)", () => {
		renderHook(() => useMuteWhileDictating(true));
		fire(IPC.STT_RECORDING_STOP);
		expect(
			sentChannels.some(
				(c) => c.channel === IPC.AUDIO_SET_MUTE && (c.args[0] as { muted: boolean }).muted === false
			)
		).toBe(true);
	});

	test("unmount unsubscribes both listeners and unmutes system audio", () => {
		const { unmount } = renderHook(() => useMuteWhileDictating(true));
		unmount();
		expect(listeners.get(IPC.STT_RECORDING_START)?.length ?? 0).toBe(0);
		expect(listeners.get(IPC.STT_RECORDING_STOP)?.length ?? 0).toBe(0);
		// final audioSetMute(false) is called on cleanup
		expect(sentChannels.some((c) => c.channel === IPC.AUDIO_SET_MUTE)).toBe(true);
	});
});
