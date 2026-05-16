import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ipcClientMock } from "@test/mocks/ipc-client";

const cancelSpy = mock(() => undefined);

// Spread the COMPLETE, behavior-faithful ipc-client fake, then override only
// the export this suite controls. bun:test's `mock.module` is process-global
// and never torn down, so a partial shim leaks an incomplete module into
// every later test file. `ipcClientMock()` exposes every real export and
// routes each through `window.electronAPI` exactly as the real module, so the
// leak is harmless regardless of file order.
mock.module("@/shared/api/ipc-client", () => ({
	...ipcClientMock(),
	cancelDownload: cancelSpy,
}));

const { useDownloadStore, normalizeProgressPayload } = await import("./download-store");

beforeEach(() => {
	cancelSpy.mockClear();
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
});

afterEach(() => {
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
});

describe("normalizeProgressPayload", () => {
	test("converts fractional progress to integer percentage", () => {
		expect(normalizeProgressPayload({ progress: 0.456 }).progress).toBe(46);
	});
	test("defaults all optional fields to 0 when absent", () => {
		const result = normalizeProgressPayload({ progress: 0.5 });
		expect(result.downloadedBytes).toBe(0);
		expect(result.totalBytes).toBe(0);
		expect(result.speedBps).toBe(0);
		expect(result.etaSeconds).toBe(0);
	});
	test("passes through provided optional values", () => {
		const result = normalizeProgressPayload({
			progress: 0.1,
			downloadedBytes: 512,
			totalBytes: 1024,
			speedBps: 2048,
			etaSeconds: 5,
		});
		expect(result.downloadedBytes).toBe(512);
		expect(result.totalBytes).toBe(1024);
		expect(result.speedBps).toBe(2048);
		expect(result.etaSeconds).toBe(5);
	});
});

describe("useDownloadStore", () => {
	test("setDownloadStart sets isDownloading and zeroes counters", () => {
		useDownloadStore.getState().setDownloadStart("tiny");
		const state = useDownloadStore.getState();
		expect(state.isDownloading).toBe(true);
		expect(state.modelName).toBe("tiny");
		expect(state.progress).toBe(0);
		expect(state.downloadedBytes).toBe(0);
		expect(state.totalBytes).toBe(0);
		expect(state.speedBps).toBe(0);
		expect(state.etaSeconds).toBe(0);
		expect(state.cancelled).toBe(false);
	});

	test("setDownloadProgress rounds progress to integer percent", () => {
		useDownloadStore.getState().setDownloadProgress({
			progress: 0.4567,
			downloadedBytes: 100,
			totalBytes: 200,
			speedBps: 1024,
			etaSeconds: 30,
		});
		const state = useDownloadStore.getState();
		expect(state.progress).toBe(46);
		expect(state.downloadedBytes).toBe(100);
		expect(state.totalBytes).toBe(200);
		expect(state.speedBps).toBe(1024);
		expect(state.etaSeconds).toBe(30);
	});

	test("setDownloadProgress with missing optional fields zeroes them", () => {
		useDownloadStore.getState().setDownloadProgress({ progress: 0.5 });
		const state = useDownloadStore.getState();
		expect(state.progress).toBe(50);
		expect(state.downloadedBytes).toBe(0);
		expect(state.totalBytes).toBe(0);
		expect(state.speedBps).toBe(0);
		expect(state.etaSeconds).toBe(0);
	});

	test("setDownloadComplete(undefined) clears state immediately", () => {
		useDownloadStore.getState().setDownloadStart("tiny");
		useDownloadStore.getState().setDownloadComplete(false);
		const state = useDownloadStore.getState();
		expect(state.isDownloading).toBe(false);
		expect(state.modelName).toBeNull();
		expect(state.progress).toBeNull();
		expect(state.cancelled).toBe(false);
	});

	test("setDownloadComplete(true) marks cancelled and clears after a delay", async () => {
		useDownloadStore.getState().setDownloadStart("tiny");
		useDownloadStore.getState().setDownloadComplete(true);
		const state = useDownloadStore.getState();
		// Cancelled flag is set synchronously
		expect(state.cancelled).toBe(true);
		// isDownloading remains true until the deferred clear fires (~2s later)
		expect(state.isDownloading).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 2050));
		const cleared = useDownloadStore.getState();
		expect(cleared.isDownloading).toBe(false);
		expect(cleared.cancelled).toBe(false);
		expect(cleared.modelName).toBeNull();
	}, 4000);

	test("cancelDownload calls the IPC client's cancelDownload", () => {
		useDownloadStore.getState().cancelDownload();
		expect(cancelSpy).toHaveBeenCalledTimes(1);
	});
});
