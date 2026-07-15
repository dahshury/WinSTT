import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { IPC } from "@test/mocks/legacy-ipc";
import { useDownloadStore } from "../model/download-store";
import { useDownloadListener } from "./use-download-listener";

const originalApi = window.nativeBridge;
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
		quantDownloads: {},
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
					(listeners.get(channel) ?? []).filter((x) => x !== cb),
				);
			};
		},
	};
});

afterEach(() => {
	window.nativeBridge = originalApi;
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

function lifecycle(
	revision: number,
	phase: "downloading" | "paused" | "ready",
) {
	return {
		modelId: "whisper-base",
		quantization: "int8",
		phase,
		requestId: "request-1",
		revision,
		downloadedBytes: phase === "ready" ? 1000 : 400,
		totalBytes: 1000,
		speedBps: phase === "downloading" ? 25 : 0,
		etaSeconds: 0,
		verificationMs: phase === "ready" ? 12 : null,
		selectedModel: null,
		residentModel: null,
		warm: false,
		error: null,
	};
}

describe("useDownloadListener authoritative per-quant lifecycle", () => {
	test("projects progress, pause, resume, and terminal readiness", () => {
		renderHook(() => useDownloadListener());
		fire("stt:model-lifecycle", lifecycle(1, "downloading"));
		expect(
			useDownloadStore.getState().quantDownloads["whisper-base@int8"]?.progress,
		).toBe(40);
		fire("stt:model-lifecycle", lifecycle(2, "paused"));
		expect(
			useDownloadStore.getState().quantDownloads["whisper-base@int8"]?.paused,
		).toBe(true);
		fire("stt:model-lifecycle", lifecycle(3, "downloading"));
		expect(
			useDownloadStore.getState().quantDownloads["whisper-base@int8"]?.paused,
		).toBe(false);
		fire("stt:model-lifecycle", lifecycle(4, "ready"));
		expect(
			useDownloadStore.getState().quantDownloads["whisper-base@int8"],
		).toBeUndefined();
	});

	test("ignores legacy per-quant events", () => {
		renderHook(() => useDownloadListener());
		fire(IPC.STT_MODEL_DOWNLOAD_PROGRESS, {
			model: "whisper-base",
			quantization: "int8",
			progress: 0.9,
		});
		expect(
			useDownloadStore.getState().quantDownloads["whisper-base@int8"],
		).toBeUndefined();
	});

	test("legacy whole-model progress remains isolated to the singleton", () => {
		renderHook(() => useDownloadListener());
		fire(IPC.STT_MODEL_DOWNLOAD_PROGRESS, { model: "tiny", progress: 0.4 });
		expect(useDownloadStore.getState().progress).toBe(40);
	});
});
