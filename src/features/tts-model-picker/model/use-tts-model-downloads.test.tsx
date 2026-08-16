import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ipcClientMock } from "@test/mocks/ipc-client";
import { act, renderHook } from "@testing-library/react";
import * as realTtsCatalog from "@/entities/tts-catalog";

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

type MockTtsModelState = {
	isLoaded: boolean;
	refresh: () => Promise<void>;
	statesById: Record<string, unknown>;
};

const mockTtsModelState: MockTtsModelState = {
	isLoaded: true,
	refresh: refreshSpy,
	statesById: {},
};

function useTtsModelStateStore<T>(
	selector: (state: MockTtsModelState) => T,
): T {
	return selector(mockTtsModelState);
}

useTtsModelStateStore.setState = (patch: Partial<MockTtsModelState>): void => {
	Object.assign(mockTtsModelState, patch, { refresh: refreshSpy });
};

// `mock.module` is process-global. Within the features layer (how CI runs this
// file) the barrel is only needed for `useTtsModelStateStore`; expose
// `useTtsSwapStore` too so a co-running features test that pulls the real barrel
// (e.g. via a component import) still resolves the binding added for TTS quant
// switching.
const ttsSwapState = {
	active: null,
	begin: () => undefined,
	confirm: () => undefined,
	clear: () => undefined,
};
function useTtsSwapStore<T>(selector: (state: typeof ttsSwapState) => T): T {
	return selector(ttsSwapState);
}
useTtsSwapStore.getState = () => ttsSwapState;

mock.module("@/entities/tts-catalog", () => ({
	...realTtsCatalog,
	useTtsModelStateStore,
	useTtsSwapStore,
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

function fireComplete(
	model: string,
	cancelled: boolean,
	quantization: string,
): void {
	act(() => {
		for (const listener of completeListeners) {
			listener(model, cancelled, quantization);
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
	useTtsModelStateStore.setState({ isLoaded: true, statesById: {} });
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
			downloadedBytes: 1200,
			totalBytes: 1000,
		});

		expect(result.current.getSnapshot("kokoro", "fp16")?.totalBytes).toBe(1200);
	});

	test("does not resurrect a completed download from a late 100% progress event", () => {
		const { result } = renderHook(() => useTtsModelDownloads());

		fireProgress({
			model: "kitten-tts-nano",
			quantization: "fp32",
			progress: 0.99,
			downloadedBytes: 990,
			totalBytes: 1000,
		});
		fireComplete("kitten-tts-nano", false, "fp32");
		fireProgress({
			model: "kitten-tts-nano",
			quantization: "fp32",
			progress: 1,
			downloadedBytes: 1000,
			totalBytes: 1000,
		});

		expect(refreshSpy).toHaveBeenCalledTimes(1);
		expect(
			result.current.getSnapshot("kitten-tts-nano", "fp32"),
		).toBeUndefined();
	});

	test("accepts progress again after an explicit restart", () => {
		const { result } = renderHook(() => useTtsModelDownloads());

		fireComplete("kitten-tts-nano", false, "fp32");
		act(() =>
			result.current.onDownloadAction("start", "kitten-tts-nano", "fp32"),
		);
		fireProgress({
			model: "kitten-tts-nano",
			quantization: "fp32",
			progress: 0.25,
			downloadedBytes: 250,
			totalBytes: 1000,
		});

		expect(
			result.current.getSnapshot("kitten-tts-nano", "fp32")?.progress,
		).toBe(25);
	});
});
