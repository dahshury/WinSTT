import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { IPC } from "@/shared/api/ipc-channels";
import { useFileTranscriptionStore } from "./file-transcription-store";
import { useFileTranscriptionListener } from "./use-file-transcription-listener";

const originalApi = window.nativeBridge;
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

beforeEach(() => {
	listeners.clear();
	useFileTranscriptionStore.getState().reset();
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
	window.nativeBridge = originalApi;
	useFileTranscriptionStore.getState().reset();
});

function fire(channel: string, ...args: unknown[]) {
	for (const cb of listeners.get(channel) ?? []) {
		cb(...args);
	}
}

describe("useFileTranscriptionListener", () => {
	test("subscribes to all three queue channels", () => {
		renderHook(() => useFileTranscriptionListener());
		expect(listeners.has(IPC.FILE_QUEUE_UPDATE)).toBe(true);
		expect(listeners.has(IPC.FILE_QUEUE_PROGRESS)).toBe(true);
		expect(listeners.has(IPC.FILE_QUEUE_ACTIVE)).toBe(true);
	});

	test("queue-update replaces the items", () => {
		renderHook(() => useFileTranscriptionListener());
		fire(IPC.FILE_QUEUE_UPDATE, {
			items: [
				{
					id: "a",
					fileName: "a.wav",
					status: "queued",
					progress: 0,
					stage: "queued",
					message: "",
				},
			],
		});
		expect(useFileTranscriptionStore.getState().items.map((i) => i.id)).toEqual(
			["a"],
		);
	});

	test("queue-progress patches the matching row's progress", () => {
		renderHook(() => useFileTranscriptionListener());
		fire(IPC.FILE_QUEUE_UPDATE, {
			items: [
				{
					id: "a",
					fileName: "a.wav",
					status: "transcribing",
					progress: 0,
					stage: "transcribing",
					message: "",
				},
			],
		});
		fire(IPC.FILE_QUEUE_PROGRESS, {
			id: "a",
			progress: 0.5,
			stage: "transcribing",
		});
		expect(useFileTranscriptionStore.getState().items[0]?.progress).toBe(0.5);
	});

	test("queue-active updates the cross-window busy flag", () => {
		renderHook(() => useFileTranscriptionListener());
		fire(IPC.FILE_QUEUE_ACTIVE, { active: true });
		expect(useFileTranscriptionStore.getState().queueActive).toBe(true);
	});

	test("unsubscribes all channels on unmount", () => {
		const { unmount } = renderHook(() => useFileTranscriptionListener());
		unmount();
		expect(listeners.get(IPC.FILE_QUEUE_UPDATE)?.length ?? 0).toBe(0);
		expect(listeners.get(IPC.FILE_QUEUE_PROGRESS)?.length ?? 0).toBe(0);
		expect(listeners.get(IPC.FILE_QUEUE_ACTIVE)?.length ?? 0).toBe(0);
	});
});
