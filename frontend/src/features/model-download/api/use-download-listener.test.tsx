import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { IPC } from "@/shared/api/ipc-channels";
import { useDownloadStore } from "../model/download-store";
import { useDownloadListener } from "./use-download-listener";

const originalApi = window.electronAPI;
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

beforeEach(() => {
	listeners.clear();
	useDownloadStore.setState({
		isDownloading: false,
		modelName: null,
		progress: null,
		downloadedBytes: 0,
		totalBytes: 0,
		speedBps: 0,
		etaSeconds: 0,
		cancelled: false,
	});
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
});

function fire(channel: string, ...args: unknown[]) {
	for (const cb of listeners.get(channel) ?? []) {
		cb(...args);
	}
}

describe("useDownloadListener", () => {
	test("subscribes to all three model-download channels", () => {
		renderHook(() => useDownloadListener());
		expect(listeners.has(IPC.STT_MODEL_DOWNLOAD_START)).toBe(true);
		expect(listeners.has(IPC.STT_MODEL_DOWNLOAD_PROGRESS)).toBe(true);
		expect(listeners.has(IPC.STT_MODEL_DOWNLOAD_COMPLETE)).toBe(true);
	});

	test("download start updates the store", () => {
		renderHook(() => useDownloadListener());
		fire(IPC.STT_MODEL_DOWNLOAD_START, { model: "tiny" });
		expect(useDownloadStore.getState().isDownloading).toBe(true);
		expect(useDownloadStore.getState().modelName).toBe("tiny");
	});

	test("download progress updates the store", () => {
		renderHook(() => useDownloadListener());
		fire(IPC.STT_MODEL_DOWNLOAD_PROGRESS, { progress: 0.5, model: "tiny" });
		expect(useDownloadStore.getState().progress).toBe(50);
	});

	test("download complete clears the download state", () => {
		renderHook(() => useDownloadListener());
		useDownloadStore.getState().setDownloadStart("tiny");
		fire(IPC.STT_MODEL_DOWNLOAD_COMPLETE, { model: "tiny", cancelled: false });
		expect(useDownloadStore.getState().isDownloading).toBe(false);
		expect(useDownloadStore.getState().modelName).toBeNull();
	});

	test("unsubscribes on unmount", () => {
		const { unmount } = renderHook(() => useDownloadListener());
		unmount();
		expect(listeners.get(IPC.STT_MODEL_DOWNLOAD_START)?.length ?? 0).toBe(0);
		expect(listeners.get(IPC.STT_MODEL_DOWNLOAD_PROGRESS)?.length ?? 0).toBe(0);
		expect(listeners.get(IPC.STT_MODEL_DOWNLOAD_COMPLETE)?.length ?? 0).toBe(0);
	});
});
