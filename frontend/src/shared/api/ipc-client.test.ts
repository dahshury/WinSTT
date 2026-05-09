import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { IPC } from "./ipc-channels";
import * as ipc from "./ipc-client";

const originalApi = window.electronAPI;

interface MockApi {
	getPathForFile: ReturnType<typeof mock>;
	invoke: ReturnType<typeof mock>;
	listeners: Map<string, Array<(...args: unknown[]) => void>>;
	on: ReturnType<typeof mock>;
	secureInvoke: ReturnType<typeof mock>;
	send: ReturnType<typeof mock>;
}

function installMockApi(opts?: {
	invokeImpl?: (channel: string, ...args: unknown[]) => unknown;
	secureInvokeImpl?: (channel: string, payload?: unknown) => unknown;
}): MockApi {
	const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
	const api: MockApi = {
		listeners,
		send: mock(() => undefined),
		invoke: mock(async (channel: string, ...args: unknown[]) => {
			if (opts?.invokeImpl) {
				return opts.invokeImpl(channel, ...args);
			}
			return;
		}),
		secureInvoke: mock(async (channel: string, payload?: unknown) => {
			if (opts?.secureInvokeImpl) {
				return opts.secureInvokeImpl(channel, payload);
			}
			return;
		}),
		on: mock((channel: string, cb: (...args: unknown[]) => void) => {
			const list = listeners.get(channel) ?? [];
			list.push(cb);
			listeners.set(channel, list);
			return () => {
				listeners.set(
					channel,
					(listeners.get(channel) ?? []).filter((x) => x !== cb)
				);
			};
		}),
		getPathForFile: mock(() => "/mock/path"),
	};
	window.electronAPI = api as unknown as typeof window.electronAPI;
	return api;
}

function fire(api: MockApi, channel: string, ...args: unknown[]) {
	for (const cb of api.listeners.get(channel) ?? []) {
		cb(...args);
	}
}

beforeEach(() => {
	// reset to clean baseline before each test
	window.electronAPI = originalApi;
});

afterEach(() => {
	window.electronAPI = originalApi;
});

describe("getFilePath", () => {
	test("delegates to electronAPI.getPathForFile when in electron", () => {
		const api = installMockApi();
		const file = new File(["hi"], "x.wav", { type: "audio/wav" });
		expect(ipc.getFilePath(file)).toBe("/mock/path");
		expect(api.getPathForFile).toHaveBeenCalledTimes(1);
	});

	test("returns empty string when not in electron", () => {
		const previous = window.electronAPI;
		(window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
		try {
			expect(ipc.getFilePath(new File([], "x.wav"))).toBe("");
		} finally {
			window.electronAPI = previous;
		}
	});
});

describe("send wrappers", () => {
	test("hotkeyUnregister forwards accelerator", () => {
		const api = installMockApi();
		ipc.hotkeyUnregister("Ctrl+S");
		expect(api.send).toHaveBeenCalledWith(IPC.HOTKEY_UNREGISTER, { accelerator: "Ctrl+S" });
	});

	test("hotkeyStopRecording sends with no payload", () => {
		const api = installMockApi();
		ipc.hotkeyStopRecording();
		expect(api.send).toHaveBeenCalledWith(IPC.HOTKEY_STOP_RECORDING);
	});

	test("autostartSet sends enabled flag", () => {
		const api = installMockApi();
		ipc.autostartSet(true);
		expect(api.send).toHaveBeenCalledWith(IPC.AUTOSTART_SET, { enabled: true });
	});

	test("audioSetMute sends muted flag", () => {
		const api = installMockApi();
		ipc.audioSetMute(false);
		expect(api.send).toHaveBeenCalledWith(IPC.AUDIO_SET_MUTE, { muted: false });
	});

	test("settingsSave sends settings", () => {
		const api = installMockApi();
		ipc.settingsSave({} as Parameters<typeof ipc.settingsSave>[0]);
		expect(api.send).toHaveBeenCalledWith(IPC.SETTINGS_SAVE, { settings: {} });
	});

	test("window controls send their channels", () => {
		const api = installMockApi();
		ipc.windowMinimize();
		ipc.windowMaximize();
		ipc.windowClose();
		ipc.windowOpenSettings();
		ipc.windowCloseSelf();
		const channels = (api.send as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
			(c) => c[0]
		);
		expect(channels).toEqual([
			IPC.WINDOW_MINIMIZE,
			IPC.WINDOW_MAXIMIZE,
			IPC.WINDOW_CLOSE,
			IPC.WINDOW_OPEN_SETTINGS,
			IPC.WINDOW_CLOSE_SELF,
		]);
	});

	test("loopbackStart and loopbackStop send their payloads", () => {
		const api = installMockApi();
		ipc.loopbackStart(3);
		ipc.loopbackStop();
		expect(api.send).toHaveBeenNthCalledWith(1, IPC.LOOPBACK_START, { deviceIndex: 3 });
		expect(api.send).toHaveBeenNthCalledWith(2, IPC.LOOPBACK_STOP);
	});

	test("sttSetParameter and sttCallMethod send full payloads", () => {
		const api = installMockApi();
		ipc.sttSetParameter("model", "tiny");
		ipc.sttCallMethod("abort", [1, 2]);
		expect(api.send).toHaveBeenNthCalledWith(1, IPC.STT_SET_PARAMETER, {
			parameter: "model",
			value: "tiny",
		});
		expect(api.send).toHaveBeenNthCalledWith(2, IPC.STT_CALL_METHOD, {
			method: "abort",
			args: [1, 2],
		});
	});
});

describe("invokeOrDefault wrappers", () => {
	test("returns the resolved value when invoke succeeds", async () => {
		installMockApi({
			invokeImpl: (channel) => (channel === IPC.AUTOSTART_GET ? true : undefined),
		});
		expect(await ipc.autostartGet()).toBe(true);
	});

	test("returns the fallback when invoke resolves undefined", async () => {
		installMockApi();
		expect(await ipc.autostartGet()).toBe(false);
	});

	test("returns the fallback when invoke throws", async () => {
		installMockApi({
			invokeImpl: () => {
				throw new Error("bad");
			},
		});
		expect(await ipc.autostartGet()).toBe(false);
	});

	test("hotkeyRegister forwards accelerator and returns the result", async () => {
		const api = installMockApi({
			invokeImpl: () => true,
		});
		expect(await ipc.hotkeyRegister("Ctrl+S")).toBe(true);
		expect(api.invoke).toHaveBeenCalledWith(IPC.HOTKEY_REGISTER, { accelerator: "Ctrl+S" });
	});

	test("settingsLoad decodes the returned payload", async () => {
		installMockApi({
			invokeImpl: () => ({ general: { recordingMode: "toggle" } }),
		});
		const settings = await ipc.settingsLoad();
		expect(settings.general.recordingMode).toBe("toggle");
		// Other fields filled with defaults
		expect(settings.general.minimizeToTray).toBe(true);
	});

	test("processWithLlm passes the input text through", async () => {
		const api = installMockApi({
			invokeImpl: () => "processed!",
		});
		expect(await ipc.processWithLlm("raw")).toBe("processed!");
		expect(api.invoke).toHaveBeenCalledWith(IPC.LLM_PROCESS_TEXT, { text: "raw" });
	});

	test("processWithLlm falls back to original text when invoke returns undefined", async () => {
		installMockApi();
		expect(await ipc.processWithLlm("raw")).toBe("raw");
	});

	test("dialogOpenFile passes filters and title", async () => {
		const api = installMockApi({
			invokeImpl: () => "C:\\foo.wav",
		});
		expect(await ipc.dialogOpenFile([{ name: "Audio", extensions: ["wav"] }], "Pick")).toBe(
			"C:\\foo.wav"
		);
		expect(api.invoke).toHaveBeenCalledWith(IPC.DIALOG_OPEN_FILE, {
			filters: [{ name: "Audio", extensions: ["wav"] }],
			title: "Pick",
		});
	});

	test("appMenuSetTemplate forwards template and returns result", async () => {
		const api = installMockApi({
			invokeImpl: () => ({ applied: true, itemCount: 4 }),
		});
		const out = await ipc.appMenuSetTemplate([{ label: "File" }]);
		expect(out).toEqual({ applied: true, itemCount: 4 });
		expect(api.invoke).toHaveBeenCalledWith(IPC.APP_MENU_SET_TEMPLATE, [{ label: "File" }]);
	});

	test("appMenuReset returns parsed result", async () => {
		installMockApi({
			invokeImpl: () => ({ applied: true }),
		});
		expect(await ipc.appMenuReset()).toEqual({ applied: true });
	});

	test("contextMenuShow passes template and coordinates", async () => {
		const api = installMockApi({
			invokeImpl: () => ({ selectedId: "ok" }),
		});
		const out = await ipc.contextMenuShow([{ id: "ok", label: "OK" }], 10, 20);
		expect(out).toEqual({ selectedId: "ok" });
		expect(api.invoke).toHaveBeenCalledWith(IPC.CONTEXT_MENU_SHOW, {
			template: [{ id: "ok", label: "OK" }],
			x: 10,
			y: 20,
		});
	});

	test("fileTranscribe forwards filePath", async () => {
		const api = installMockApi({
			invokeImpl: () => ({ requestId: "req-1" }),
		});
		expect(await ipc.fileTranscribe("C:\\a.wav")).toEqual({ requestId: "req-1" });
		expect(api.invoke).toHaveBeenCalledWith(IPC.FILE_TRANSCRIBE, { filePath: "C:\\a.wav" });
	});

	test("fetchOllamaModels returns scan result", async () => {
		const fixture = { models: [{ name: "m" }], reachable: true };
		installMockApi({ invokeImpl: () => fixture });
		expect(await ipc.fetchOllamaModels()).toBe(fixture);
	});

	test("fetchOllamaModels falls back to disconnected scan when invoke fails", async () => {
		installMockApi({
			invokeImpl: () => {
				throw new Error("nope");
			},
		});
		const out = await ipc.fetchOllamaModels();
		expect(out.reachable).toBe(false);
		expect(out.models).toEqual([]);
	});

	test("detectOllama returns fallback when invoke unset", async () => {
		installMockApi();
		expect(await ipc.detectOllama()).toEqual({ installed: false });
	});

	test("startOllama returns fallback on no-electron-path", async () => {
		installMockApi();
		const out = await ipc.startOllama();
		expect(out.started).toBe(false);
		expect(typeof out.error).toBe("string");
	});

	test("fetchOpenRouterModels returns fallback when invoke fails", async () => {
		installMockApi({
			invokeImpl: () => {
				throw new Error("offline");
			},
		});
		const out = await ipc.fetchOpenRouterModels();
		expect(out.reachable).toBe(false);
		expect(out.models).toEqual([]);
	});

	test("sttServerSpawn and sttServerKill resolve via invoke", async () => {
		const api = installMockApi();
		await ipc.sttServerSpawn();
		await ipc.sttServerKill();
		const channels = (api.invoke as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
			(c) => c[0]
		);
		expect(channels).toContain(IPC.STT_SERVER_SPAWN);
		expect(channels).toContain(IPC.STT_SERVER_KILL);
	});

	test("cancelDownload resolves to undefined fallback", async () => {
		installMockApi();
		expect(await ipc.cancelDownload()).toBeUndefined();
	});
});

describe("invokeSecureOrDefault wrappers", () => {
	test("clipboardReadText returns the text from a readText response", async () => {
		const api = installMockApi({
			secureInvokeImpl: () => ({ operation: "readText", text: "hi" }),
		});
		expect(await ipc.clipboardReadText()).toBe("hi");
		expect(api.secureInvoke).toHaveBeenCalledWith(IPC.CLIPBOARD_OPERATE, {
			operation: "readText",
		});
	});

	test("clipboardReadText returns empty string if response is wrong shape", async () => {
		installMockApi({
			secureInvokeImpl: () => ({ operation: "writeText" }),
		});
		expect(await ipc.clipboardReadText()).toBe("");
	});

	test("clipboardReadText returns empty string when secureInvoke throws", async () => {
		installMockApi({
			secureInvokeImpl: () => {
				throw new Error("denied");
			},
		});
		expect(await ipc.clipboardReadText()).toBe("");
	});

	test("clipboardWriteText forwards the text payload", async () => {
		const api = installMockApi({
			secureInvokeImpl: () => ({ operation: "writeText" }),
		});
		await ipc.clipboardWriteText("hello");
		expect(api.secureInvoke).toHaveBeenCalledWith(IPC.CLIPBOARD_OPERATE, {
			operation: "writeText",
			text: "hello",
		});
	});

	test("clipboardClear sends a clear operation", async () => {
		const api = installMockApi({
			secureInvokeImpl: () => ({ operation: "clear" }),
		});
		await ipc.clipboardClear();
		expect(api.secureInvoke).toHaveBeenCalledWith(IPC.CLIPBOARD_OPERATE, {
			operation: "clear",
		});
	});

	test("updaterGetStatusHistory returns the array on success", async () => {
		const fixture = [{ status: "checking" as const, timestamp: 1 }];
		installMockApi({ secureInvokeImpl: () => fixture });
		expect(await ipc.updaterGetStatusHistory()).toBe(fixture);
	});

	test("updaterGetStatusHistory returns [] when secureInvoke fails", async () => {
		installMockApi({
			secureInvokeImpl: () => {
				throw new Error("blocked");
			},
		});
		expect(await ipc.updaterGetStatusHistory()).toEqual([]);
	});

	test("updaterClearStatusHistory returns ok on success", async () => {
		installMockApi({ secureInvokeImpl: () => ({ cleared: true }) });
		expect(await ipc.updaterClearStatusHistory()).toEqual({ cleared: true });
	});
});

describe("typed event subscriptions", () => {
	test("onRealtimeText extracts text from {text}", () => {
		const api = installMockApi();
		const cb = mock(() => undefined);
		ipc.onRealtimeText(cb);
		fire(api, IPC.STT_REALTIME_TEXT, { text: "hi" });
		expect(cb).toHaveBeenCalledWith("hi");
	});

	test("onFullSentence extracts text", () => {
		const api = installMockApi();
		const cb = mock(() => undefined);
		ipc.onFullSentence(cb);
		fire(api, IPC.STT_FULL_SENTENCE, { text: "ok" });
		expect(cb).toHaveBeenCalledWith("ok");
	});

	test("simple event subscriptions pass arguments through unchanged", () => {
		const api = installMockApi();
		const noAudio = mock(() => undefined);
		const recStart = mock(() => undefined);
		const recStop = mock(() => undefined);
		ipc.onNoAudioDetected(noAudio);
		ipc.onRecordingStart(recStart);
		ipc.onRecordingStop(recStop);
		fire(api, IPC.STT_NO_AUDIO_DETECTED);
		fire(api, IPC.STT_RECORDING_START);
		fire(api, IPC.STT_RECORDING_STOP);
		expect(noAudio).toHaveBeenCalled();
		expect(recStart).toHaveBeenCalled();
		expect(recStop).toHaveBeenCalled();
	});

	test("onTranscriptionStart extracts audioBase64", () => {
		const api = installMockApi();
		const cb = mock(() => undefined);
		ipc.onTranscriptionStart(cb);
		fire(api, IPC.STT_TRANSCRIPTION_START, { audioBase64: "abc" });
		expect(cb).toHaveBeenCalledWith("abc");
	});

	test("onConnectionChange extracts boolean", () => {
		const api = installMockApi();
		const cb = mock(() => undefined);
		ipc.onConnectionChange(cb);
		fire(api, IPC.STT_CONNECTION_CHANGE, { connected: true });
		expect(cb).toHaveBeenCalledWith(true);
	});

	test("onServerStatus extracts status", () => {
		const api = installMockApi();
		const cb = mock(() => undefined);
		ipc.onServerStatus(cb);
		fire(api, IPC.STT_SERVER_STATUS, { status: "ready" });
		expect(cb).toHaveBeenCalledWith("ready");
	});

	test("onHotkeyRecordingUpdate / onHotkeyRecordingDone extract their fields", () => {
		const api = installMockApi();
		const upd = mock(() => undefined);
		const done = mock(() => undefined);
		ipc.onHotkeyRecordingUpdate(upd);
		ipc.onHotkeyRecordingDone(done);
		fire(api, IPC.HOTKEY_RECORDING_UPDATE, { keys: ["LCtrl", "A"] });
		fire(api, IPC.HOTKEY_RECORDING_DONE, { combo: "LCtrl+A" });
		expect(upd).toHaveBeenCalledWith(["LCtrl", "A"]);
		expect(done).toHaveBeenCalledWith("LCtrl+A");
	});

	test("onSettingsChanged and onSettingsSaveError extract their fields", () => {
		const api = installMockApi();
		const changed = mock(() => undefined);
		const errCb = mock(() => undefined);
		ipc.onSettingsChanged(changed);
		ipc.onSettingsSaveError(errCb);
		fire(api, IPC.SETTINGS_CHANGED, { settings: { foo: 1 } });
		fire(api, IPC.SETTINGS_SAVE_ERROR, { error: "boom" });
		expect(changed).toHaveBeenCalledWith({ foo: 1 });
		expect(errCb).toHaveBeenCalledWith("boom");
	});

	test("onAudioLevel extracts level number", () => {
		const api = installMockApi();
		const cb = mock(() => undefined);
		ipc.onAudioLevel(cb);
		fire(api, IPC.STT_AUDIO_LEVEL, { level: 0.5 });
		expect(cb).toHaveBeenCalledWith(0.5);
	});

	test("onModelDownloadStart extracts model id", () => {
		const api = installMockApi();
		const cb = mock(() => undefined);
		ipc.onModelDownloadStart(cb);
		fire(api, IPC.STT_MODEL_DOWNLOAD_START, { model: "tiny" });
		expect(cb).toHaveBeenCalledWith("tiny");
	});

	test("onModelDownloadProgress passes the full payload", () => {
		const api = installMockApi();
		const cb = mock(() => undefined);
		ipc.onModelDownloadProgress(cb);
		fire(api, IPC.STT_MODEL_DOWNLOAD_PROGRESS, { model: "tiny", progress: 0.5 });
		expect(cb).toHaveBeenCalledWith({ model: "tiny", progress: 0.5 });
	});

	test("onModelDownloadComplete passes (model, cancelled) — defaulting cancelled to false", () => {
		const api = installMockApi();
		const cb = mock(() => undefined);
		ipc.onModelDownloadComplete(cb);
		fire(api, IPC.STT_MODEL_DOWNLOAD_COMPLETE, { model: "tiny" });
		expect(cb).toHaveBeenCalledWith("tiny", false);
		fire(api, IPC.STT_MODEL_DOWNLOAD_COMPLETE, { model: "base", cancelled: true });
		expect(cb).toHaveBeenCalledWith("base", true);
	});

	test("onModelCatalog and fetchModelCatalog handle models list", async () => {
		const api = installMockApi({ invokeImpl: () => [{ name: "tiny" }] });
		const cb = mock(() => undefined);
		ipc.onModelCatalog(cb);
		fire(api, IPC.STT_MODEL_CATALOG, { models: [1, 2] });
		expect(cb).toHaveBeenCalledWith([1, 2]);
		expect(await ipc.fetchModelCatalog()).toEqual([{ name: "tiny" }]);
	});

	test("loopback events extract their fields", () => {
		const api = installMockApi();
		const started = mock(() => undefined);
		const stopped = mock(() => undefined);
		ipc.onLoopbackStarted(started);
		ipc.onLoopbackStopped(stopped);
		fire(api, IPC.STT_LOOPBACK_STARTED, { deviceName: "Speakers" });
		fire(api, IPC.STT_LOOPBACK_STOPPED);
		expect(started).toHaveBeenCalledWith("Speakers");
		expect(stopped).toHaveBeenCalled();
	});

	test("file-transcription events pass payload through unchanged", () => {
		const api = installMockApi();
		const onProgress = mock(() => undefined);
		const onComplete = mock(() => undefined);
		const onError = mock(() => undefined);
		ipc.onFileTranscriptionProgress(onProgress);
		ipc.onFileTranscriptionComplete(onComplete);
		ipc.onFileTranscriptionError(onError);
		fire(api, IPC.FILE_TRANSCRIPTION_PROGRESS, { fileName: "a", progress: 0.1, message: "x" });
		fire(api, IPC.FILE_TRANSCRIPTION_COMPLETE, {
			requestId: "r",
			fileName: "a",
			text: "t",
			outputPath: "/p",
		});
		fire(api, IPC.FILE_TRANSCRIPTION_ERROR, { requestId: "r", fileName: "a", error: "e" });
		expect(onProgress).toHaveBeenCalledWith({ fileName: "a", progress: 0.1, message: "x" });
		expect(onComplete).toHaveBeenCalledWith({
			requestId: "r",
			fileName: "a",
			text: "t",
			outputPath: "/p",
		});
		expect(onError).toHaveBeenCalledWith({ requestId: "r", fileName: "a", error: "e" });
	});

	test("onUpdaterStatus and onWindowTelemetry pass payload through", () => {
		const api = installMockApi();
		const updater = mock(() => undefined);
		const tele = mock(() => undefined);
		ipc.onUpdaterStatus(updater);
		ipc.onWindowTelemetry(tele);
		fire(api, IPC.UPDATER_STATUS, { status: "downloaded", timestamp: 1 });
		fire(api, IPC.WINDOW_TELEMETRY, {
			event: "moved",
			bounds: { x: 0, y: 0, width: 1, height: 1 },
		});
		expect(updater).toHaveBeenCalled();
		expect(tele).toHaveBeenCalled();
	});

	test("onLlmCatalog returns no-op when not in electron", () => {
		const previous = window.electronAPI;
		(window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
		try {
			const cb = mock(() => undefined);
			const unsub = ipc.onLlmCatalog(cb);
			unsub();
			expect(cb).not.toHaveBeenCalled();
		} finally {
			window.electronAPI = previous;
		}
	});

	test("onLlmCatalog subscribes when in electron and extracts models array", () => {
		const api = installMockApi();
		const cb = mock(() => undefined);
		const unsub = ipc.onLlmCatalog(cb);
		fire(api, IPC.LLM_CATALOG, { models: [{ name: "a" }] });
		expect(cb).toHaveBeenCalledWith([{ name: "a" }]);
		unsub();
		fire(api, IPC.LLM_CATALOG, { models: [{ name: "b" }] });
		// after unsub, no further calls
		expect((cb as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(1);
	});

	test("ipcOn returns a no-op unsubscribe when not in electron", () => {
		const previous = window.electronAPI;
		(window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
		try {
			const unsub = ipc.ipcOn("foo", () => undefined);
			expect(typeof unsub).toBe("function");
			unsub(); // should not throw
		} finally {
			window.electronAPI = previous;
		}
	});

	test("ipcSend is a no-op when not in electron", () => {
		const previous = window.electronAPI;
		(window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
		try {
			expect(() => ipc.ipcSend("foo", 1, 2)).not.toThrow();
		} finally {
			window.electronAPI = previous;
		}
	});

	test("ipcInvoke resolves to undefined when not in electron", async () => {
		const previous = window.electronAPI;
		(window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
		try {
			expect(await ipc.ipcInvoke("foo")).toBeUndefined();
		} finally {
			window.electronAPI = previous;
		}
	});

	test("clipboardReadText returns empty string when not in electron (secureInvoke fallback)", async () => {
		const previous = window.electronAPI;
		(window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
		try {
			expect(await ipc.clipboardReadText()).toBe("");
		} finally {
			window.electronAPI = previous;
		}
	});
});
