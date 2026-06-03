import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ipcClientMock } from "@test/mocks/ipc-client";
import { renderHook } from "@testing-library/react";
import { IPC } from "@/shared/api/ipc-channels";
import type { OnnxQuantization } from "@/shared/config/defaults";

// download-store's actions delegate to ipc-client, which routes through
// `window.nativeBridge`. Install the complete behavior-faithful fake so the
// store import chain resolves and each store action issues the real IPC
// channel through our instrumented `window.nativeBridge` below.
mock.module("@/shared/api/ipc-client", () => ipcClientMock());

const { useDownloadStore } = await import("./download-store");
const { useQuantActions } = await import("./use-quant-actions");

import type { QuantDownloadState } from "./download-store";

const INITIAL_STATE = useDownloadStore.getInitialState();
const originalNativeBridge = window.nativeBridge;

// Records every `window.nativeBridge.invoke` channel + payload so we can assert
// the handlers reach the right server command with the right envelope.
let invokeCalls: Array<{ channel: string; payload: unknown }> = [];

function installNativeBridgeStub(): void {
	window.nativeBridge = {
		getPathForFile: () => "",
		send: () => undefined,
		invoke: async (channel: string, payload?: unknown) => {
			invokeCalls.push({ channel, payload });
			return null;
		},
		secureInvoke: async () => undefined,
		on: () => () => undefined,
	};
}

function makeQuantEntry(
	modelId: string,
	quantization: string,
	paused: boolean
): QuantDownloadState {
	return {
		modelId,
		quantization,
		progress: 25,
		downloadedBytes: 100,
		totalBytes: 400,
		speedBps: 10,
		paused,
	};
}

beforeEach(() => {
	invokeCalls = [];
	installNativeBridgeStub();
	useDownloadStore.setState({ quantDownloads: {} });
});

afterEach(() => {
	window.nativeBridge = originalNativeBridge;
	useDownloadStore.setState({ quantDownloads: INITIAL_STATE.quantDownloads });
});

const Q4 = "q4" as OnnxQuantization;

describe("useQuantActions", () => {
	test("exposes the documented handler surface", () => {
		const { result } = renderHook(() => useQuantActions());
		expect(typeof result.current.handleDeleteQuant).toBe("function");
		expect(typeof result.current.handleDownloadAction).toBe("function");
		expect(typeof result.current.handleDownloadSnapshot).toBe("function");
	});

	test("handleDeleteQuant drops the local snapshot AND fires the delete IPC", async () => {
		useDownloadStore.setState({
			quantDownloads: { "whisper-base@q4": makeQuantEntry("whisper-base", "q4", false) },
		});
		const { result } = renderHook(() => useQuantActions());
		result.current.handleDeleteQuant("whisper-base", Q4);

		// Local snapshot wiped synchronously so the badge's stale stop/pause
		// chrome disappears the instant the user confirms delete.
		expect(useDownloadStore.getState().quantDownloads["whisper-base@q4"]).toBeUndefined();

		// And the IPC delete command was issued with the right envelope.
		await Promise.resolve();
		expect(invokeCalls).toContainEqual({
			channel: IPC.STT_DELETE_MODEL_QUANTIZATION,
			payload: { modelId: "whisper-base", quantization: "q4" },
		});
	});

	test("handleDownloadSnapshot returns the live entry for an existing key", () => {
		const entry = makeQuantEntry("whisper-base", "q4", true);
		useDownloadStore.setState({ quantDownloads: { "whisper-base@q4": entry } });
		const { result } = renderHook(() => useQuantActions());
		expect(result.current.handleDownloadSnapshot("whisper-base", Q4)).toEqual(entry);
	});

	test("handleDownloadSnapshot returns undefined for a missing key", () => {
		const { result } = renderHook(() => useQuantActions());
		expect(result.current.handleDownloadSnapshot("nope", Q4)).toBeUndefined();
	});

	test("handleDownloadSnapshot keys on the empty quant as `modelId@`", () => {
		const empty = "" as OnnxQuantization;
		const entry = makeQuantEntry("whisper-base", "", false);
		useDownloadStore.setState({ quantDownloads: { "whisper-base@": entry } });
		const { result } = renderHook(() => useQuantActions());
		expect(result.current.handleDownloadSnapshot("whisper-base", empty)).toEqual(entry);
	});

	test("action 'start' seeds an indeterminate entry AND fires predownload IPC", async () => {
		const { result } = renderHook(() => useQuantActions());
		result.current.handleDownloadAction("start", "whisper-base", Q4);

		// predownloadQuant seeds the entry so the badge flips to "downloading"
		// instantly, before the first server progress event.
		const seeded = useDownloadStore.getState().quantDownloads["whisper-base@q4"];
		expect(seeded).toEqual({
			modelId: "whisper-base",
			quantization: "q4",
			progress: null,
			downloadedBytes: 0,
			totalBytes: 0,
			speedBps: 0,
			paused: false,
		});

		await Promise.resolve();
		expect(invokeCalls).toContainEqual({
			channel: IPC.STT_PREDOWNLOAD_QUANT,
			payload: { modelId: "whisper-base", quantization: "q4" },
		});
	});

	test("action 'pause' optimistically flips the local entry AND fires pause IPC", async () => {
		useDownloadStore.setState({
			quantDownloads: { "whisper-base@q4": makeQuantEntry("whisper-base", "q4", false) },
		});
		const { result } = renderHook(() => useQuantActions());
		result.current.handleDownloadAction("pause", "whisper-base", Q4);

		// Optimistic local flip so the badge re-renders before the server's
		// confirmation event lands.
		expect(useDownloadStore.getState().quantDownloads["whisper-base@q4"]?.paused).toBe(true);

		await Promise.resolve();
		expect(invokeCalls).toContainEqual({
			channel: IPC.STT_DOWNLOAD_PAUSE,
			payload: { modelId: "whisper-base", quantization: "q4" },
		});
	});

	test("action 'pause' on an unknown entry still fires the pause IPC (no local flip to apply)", async () => {
		const { result } = renderHook(() => useQuantActions());
		result.current.handleDownloadAction("pause", "ghost", Q4);
		// No entry to flip — store stays empty, but the server command still goes.
		expect(useDownloadStore.getState().quantDownloads["ghost@q4"]).toBeUndefined();
		await Promise.resolve();
		expect(invokeCalls).toContainEqual({
			channel: IPC.STT_DOWNLOAD_PAUSE,
			payload: { modelId: "ghost", quantization: "q4" },
		});
	});

	test("action 'resume' clears the local paused flag AND fires resume IPC", async () => {
		useDownloadStore.setState({
			quantDownloads: { "whisper-base@q4": makeQuantEntry("whisper-base", "q4", true) },
		});
		const { result } = renderHook(() => useQuantActions());
		result.current.handleDownloadAction("resume", "whisper-base", Q4);

		expect(useDownloadStore.getState().quantDownloads["whisper-base@q4"]?.paused).toBe(false);

		await Promise.resolve();
		expect(invokeCalls).toContainEqual({
			channel: IPC.STT_DOWNLOAD_RESUME,
			payload: { modelId: "whisper-base", quantization: "q4" },
		});
	});

	test("action 'resume' on an unknown entry fires resume IPC and leaves the map empty", async () => {
		const { result } = renderHook(() => useQuantActions());
		result.current.handleDownloadAction("resume", "ghost", Q4);
		expect(useDownloadStore.getState().quantDownloads["ghost@q4"]).toBeUndefined();
		await Promise.resolve();
		expect(invokeCalls).toContainEqual({
			channel: IPC.STT_DOWNLOAD_RESUME,
			payload: { modelId: "ghost", quantization: "q4" },
		});
	});

	test("action 'cancel' fires cancel IPC without touching the local snapshot", async () => {
		const entry = makeQuantEntry("whisper-base", "q4", false);
		useDownloadStore.setState({ quantDownloads: { "whisper-base@q4": entry } });
		const { result } = renderHook(() => useQuantActions());
		result.current.handleDownloadAction("cancel", "whisper-base", Q4);

		// cancel leaves the local entry intact (cached files survive until a
		// separate discardQuantCache wipes them).
		expect(useDownloadStore.getState().quantDownloads["whisper-base@q4"]).toEqual(entry);

		await Promise.resolve();
		expect(invokeCalls).toContainEqual({
			channel: IPC.STT_DOWNLOAD_CANCEL_QUANT,
			payload: { modelId: "whisper-base", quantization: "q4" },
		});
	});
});
