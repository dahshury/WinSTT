import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ipcClientMock } from "@test/mocks/ipc-client";
import { act, renderHook } from "@testing-library/react";

type ProgressPayload = {
	downloadedBytes: number;
	model: string;
	progress: number;
	quantization: string;
	totalBytes: number;
};

type CompleteListener = (
	model: string,
	cancelled: boolean,
	quantization: string,
) => void;

let progressListeners: Array<(payload: ProgressPayload) => void> = [];
let completeListeners: CompleteListener[] = [];

const refreshSpy = mock(() => Promise.resolve());
const predownloadSpy = mock(() => Promise.resolve());
const pauseSpy = mock(() => Promise.resolve());
const resumeSpy = mock(() => Promise.resolve());
const cancelSpy = mock(() => Promise.resolve());

mock.module("@/entities/tts-catalog", () => ({
	useTtsModelStateStore: <T,>(
		selector: (state: { refresh: () => Promise<void> }) => T,
	): T => selector({ refresh: refreshSpy }),
}));

mock.module("@/shared/api/ipc-client", () => ({
	...ipcClientMock(),
	onTtsModelDownloadProgressCatalog: (
		cb: (payload: ProgressPayload) => void,
	) => {
		progressListeners.push(cb);
		return () => {
			progressListeners = progressListeners.filter((x) => x !== cb);
		};
	},
	onTtsModelDownloadCompleteCatalog: (cb: CompleteListener) => {
		completeListeners.push(cb);
		return () => {
			completeListeners = completeListeners.filter((x) => x !== cb);
		};
	},
	ttsDownloadCancel: cancelSpy,
	ttsDownloadPause: pauseSpy,
	ttsDownloadResume: resumeSpy,
	ttsPredownloadModel: predownloadSpy,
}));

const { useTtsModelDownloads } = await import("./use-tts-model-downloads");

function fireProgress(payload: ProgressPayload): void {
	act(() => {
		for (const listener of progressListeners) {
			listener(payload);
		}
	});
}

beforeEach(() => {
	progressListeners = [];
	completeListeners = [];
	refreshSpy.mockClear();
	predownloadSpy.mockClear();
	pauseSpy.mockClear();
	resumeSpy.mockClear();
	cancelSpy.mockClear();
});

afterEach(() => {
	progressListeners = [];
	completeListeners = [];
});

describe("useTtsModelDownloads", () => {
	test("keeps progress monotonic and pause sticky across late chunks", () => {
		const { result } = renderHook(() => useTtsModelDownloads());

		act(() => result.current.onDownloadAction("start", "kokoro", "fp16"));
		fireProgress({
			model: "kokoro",
			quantization: "fp16",
			progress: 0.6,
			downloadedBytes: 600,
			totalBytes: 1000,
		});
		act(() => result.current.onDownloadAction("pause", "kokoro", "fp16"));
		fireProgress({
			model: "kokoro",
			quantization: "fp16",
			progress: 0.1,
			downloadedBytes: 100,
			totalBytes: 900,
		});

		expect(result.current.getSnapshot("kokoro", "fp16")).toEqual({
			downloadedBytes: 600,
			totalBytes: 1000,
			progress: 60,
			paused: true,
		});

		act(() => result.current.onDownloadAction("resume", "kokoro", "fp16"));
		fireProgress({
			model: "kokoro",
			quantization: "fp16",
			progress: 0.2,
			downloadedBytes: 200,
			totalBytes: 1000,
		});
		expect(result.current.getSnapshot("kokoro", "fp16")).toEqual({
			downloadedBytes: 600,
			totalBytes: 1000,
			progress: 60,
			paused: false,
		});
	});

	test("resume without a live snapshot does not create a zero-progress entry", () => {
		const { result } = renderHook(() => useTtsModelDownloads());

		act(() => result.current.onDownloadAction("resume", "kokoro", "fp16"));

		expect(resumeSpy).toHaveBeenCalledWith("kokoro", "fp16");
		expect(result.current.getSnapshot("kokoro", "fp16")).toBeUndefined();
	});

	test("keeps live total bytes at least downloaded bytes", () => {
		const { result } = renderHook(() => useTtsModelDownloads());

		fireProgress({
			model: "kokoro",
			quantization: "fp16",
			progress: 1,
			downloadedBytes: 1_200,
			totalBytes: 1_000,
		});

		expect(result.current.getSnapshot("kokoro", "fp16")?.totalBytes).toBe(
			1_200,
		);
	});
});
