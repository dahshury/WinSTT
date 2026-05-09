import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { IPC } from "@/shared/api/ipc-channels";
import { useFileTranscriptionStore } from "./file-transcription-store";
import { useFileTranscriptionListener } from "./use-file-transcription-listener";

const originalApi = window.electronAPI;
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

beforeEach(() => {
	listeners.clear();
	useFileTranscriptionStore.getState().reset();
	window.electronAPI = {
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
	window.electronAPI = originalApi;
	useFileTranscriptionStore.getState().reset();
});

function fire(channel: string, ...args: unknown[]) {
	for (const cb of listeners.get(channel) ?? []) {
		cb(...args);
	}
}

describe("useFileTranscriptionListener", () => {
	test("subscribes to all three file-transcription channels", () => {
		renderHook(() => useFileTranscriptionListener());
		expect(listeners.has(IPC.FILE_TRANSCRIPTION_PROGRESS)).toBe(true);
		expect(listeners.has(IPC.FILE_TRANSCRIPTION_COMPLETE)).toBe(true);
		expect(listeners.has(IPC.FILE_TRANSCRIPTION_ERROR)).toBe(true);
	});

	test("progress events update the store", () => {
		renderHook(() => useFileTranscriptionListener());
		useFileTranscriptionStore.getState().setProcessing("a.wav");
		fire(IPC.FILE_TRANSCRIPTION_PROGRESS, {
			fileName: "a.wav",
			progress: 0.42,
			message: "halfway",
		});
		const state = useFileTranscriptionStore.getState();
		expect(state.progress).toBe(0.42);
		expect(state.message).toBe("halfway");
	});

	test("complete events transition the store to 'complete'", () => {
		renderHook(() => useFileTranscriptionListener());
		fire(IPC.FILE_TRANSCRIPTION_COMPLETE, {
			requestId: "r",
			fileName: "a.wav",
			text: "hi",
			outputPath: "/p",
		});
		expect(useFileTranscriptionStore.getState().status).toBe("complete");
	});

	test("error events transition the store to 'error' with the error message", () => {
		renderHook(() => useFileTranscriptionListener());
		fire(IPC.FILE_TRANSCRIPTION_ERROR, {
			requestId: "r",
			fileName: "a.wav",
			error: "decode failed",
		});
		const state = useFileTranscriptionStore.getState();
		expect(state.status).toBe("error");
		expect(state.message).toBe("decode failed");
	});

	test("unsubscribes all three channels on unmount", () => {
		const { unmount } = renderHook(() => useFileTranscriptionListener());
		unmount();
		expect(listeners.get(IPC.FILE_TRANSCRIPTION_PROGRESS)?.length ?? 0).toBe(0);
		expect(listeners.get(IPC.FILE_TRANSCRIPTION_COMPLETE)?.length ?? 0).toBe(0);
		expect(listeners.get(IPC.FILE_TRANSCRIPTION_ERROR)?.length ?? 0).toBe(0);
	});
});
