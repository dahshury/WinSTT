"use client";

import { IPC } from "./ipc-channels";
import type {
	AllowedMethod,
	AllowedParameter,
	AppSettingsSaveInput,
	AudioDevice,
	GpuInfo,
	OllamaDetectResult,
	OllamaModel,
	OllamaScanResult,
	ServerStatus,
} from "./models";
import { decodeSettingsPayload } from "./settings-codec";

type AppSettings = ReturnType<typeof decodeSettingsPayload>;

const noop = () => {
	/* not in electron */
};

type FallbackValue<T> = T | (() => T);

function isElectron(): boolean {
	return typeof window !== "undefined" && window.electronAPI != null;
}

function send(channel: string, ...args: unknown[]) {
	if (isElectron()) {
		window.electronAPI.send(channel, ...args);
	}
}

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
	if (isElectron()) {
		return window.electronAPI.invoke(channel, ...args) as Promise<T>;
	}
	return Promise.resolve(undefined as T);
}

function invokeSecure<T>(channel: string, payload?: unknown): Promise<T> {
	if (isElectron()) {
		return window.electronAPI.secureInvoke(channel, payload) as Promise<T>;
	}
	return Promise.resolve(undefined as T);
}

function resolveFallback<T>(fallback: FallbackValue<T>): T {
	return typeof fallback === "function" ? (fallback as () => T)() : fallback;
}

async function invokeOrDefault<T>(
	channel: string,
	fallback: FallbackValue<T>,
	...args: unknown[]
): Promise<T> {
	try {
		const value = await invoke<T | undefined>(channel, ...args);
		return value === undefined ? resolveFallback(fallback) : value;
	} catch {
		return resolveFallback(fallback);
	}
}

async function invokeSecureOrDefault<T>(
	channel: string,
	payload: unknown,
	fallback: FallbackValue<T>
): Promise<T> {
	try {
		const value = await invokeSecure<T | undefined>(channel, payload);
		return value === undefined ? resolveFallback(fallback) : value;
	} catch {
		return resolveFallback(fallback);
	}
}

function on(channel: string, callback: (...args: unknown[]) => void): () => void {
	if (isElectron()) {
		return window.electronAPI.on(channel, callback);
	}
	return noop;
}

export { send as ipcSend, invoke as ipcInvoke, on as ipcOn };

/** Subscribe to an IPC channel, cast the payload to `T`, extract a value, and pass it to the callback. */
function onTyped<T, V>(
	channel: string,
	extract: (data: T) => V,
	cb: (value: V) => void
): () => void {
	return on(channel, (data) => cb(extract(data as T)));
}

/** Subscribe to an IPC channel, cast the entire payload to `T`, and pass it to the callback. */
function onCast<T>(channel: string, cb: (value: T) => void): () => void {
	return on(channel, (data) => cb(data as T));
}

/** Get the native file path for a dropped File object (works with sandbox: true). */
export function getFilePath(file: File): string {
	if (isElectron()) {
		return window.electronAPI.getPathForFile(file);
	}
	return "";
}

// STT commands
export const sttSetParameter = (parameter: AllowedParameter, value: unknown) =>
	send(IPC.STT_SET_PARAMETER, { parameter, value });

export const sttGetParameter = (parameter: AllowedParameter) =>
	invokeOrDefault<unknown>(IPC.STT_GET_PARAMETER, null, { parameter });

export const sttCallMethod = (method: AllowedMethod, args?: unknown[]) =>
	send(IPC.STT_CALL_METHOD, { method, args });

// Hotkey
export const hotkeyRegister = (accelerator: string) =>
	invokeOrDefault<boolean>(IPC.HOTKEY_REGISTER, false, { accelerator });

export const hotkeyUnregister = (accelerator: string) =>
	send(IPC.HOTKEY_UNREGISTER, { accelerator });

export const hotkeyStartRecording = () =>
	invokeOrDefault<boolean>(IPC.HOTKEY_START_RECORDING, false);

export const hotkeyStopRecording = () => send(IPC.HOTKEY_STOP_RECORDING);

// System
export const autostartSet = (enabled: boolean) => send(IPC.AUTOSTART_SET, { enabled });
export const autostartGet = () => invokeOrDefault<boolean>(IPC.AUTOSTART_GET, false);
export const audioSetMute = (muted: boolean) => send(IPC.AUDIO_SET_MUTE, { muted });
export const audioGetDevices = () => invokeOrDefault<AudioDevice[]>(IPC.AUDIO_GET_DEVICES, []);
export const gpuGetInfo = () => invokeOrDefault<GpuInfo | null>(IPC.GPU_GET_INFO, null);

// Settings
export const settingsSave = (settings: AppSettingsSaveInput) =>
	send(IPC.SETTINGS_SAVE, { settings });
export const settingsLoad = async (): Promise<AppSettings> => {
	const payload = await invokeOrDefault<unknown>(IPC.SETTINGS_LOAD, {});
	return decodeSettingsPayload(payload);
};

// Connection status
export const sttIsConnected = () => invokeOrDefault<boolean>(IPC.STT_IS_CONNECTED, false);

// Server management
export const sttServerSpawn = () => invoke<void>(IPC.STT_SERVER_SPAWN);
export const sttServerKill = () => invoke<void>(IPC.STT_SERVER_KILL);
export const sttServerStatus = () =>
	invokeOrDefault<ServerStatus>(IPC.STT_SERVER_GET_STATUS, "idle");

// Window controls
export const windowMinimize = () => send(IPC.WINDOW_MINIMIZE);
export const windowMaximize = () => send(IPC.WINDOW_MAXIMIZE);
export const windowClose = () => send(IPC.WINDOW_CLOSE);
export const windowOpenSettings = () => send(IPC.WINDOW_OPEN_SETTINGS);
export const windowCloseSelf = () => send(IPC.WINDOW_CLOSE_SELF);

// Event subscriptions
// Note: preload strips the IpcRendererEvent, so callbacks receive only the data args
export const onRealtimeText = (cb: (text: string) => void) =>
	onTyped(IPC.STT_REALTIME_TEXT, (d: { text: string }) => d.text, cb);

export const onFullSentence = (cb: (text: string) => void) =>
	onTyped(IPC.STT_FULL_SENTENCE, (d: { text: string }) => d.text, cb);

export const onNoAudioDetected = (cb: () => void) => on(IPC.STT_NO_AUDIO_DETECTED, cb);

export const onRecordingStart = (cb: () => void) => on(IPC.STT_RECORDING_START, cb);
export const onRecordingStop = (cb: () => void) => on(IPC.STT_RECORDING_STOP, cb);
export const onVadStart = (cb: () => void) => on(IPC.STT_VAD_START, cb);
export const onVadStop = (cb: () => void) => on(IPC.STT_VAD_STOP, cb);

export const onTranscriptionStart = (cb: (audioBase64?: string) => void) =>
	onTyped(IPC.STT_TRANSCRIPTION_START, (d: { audioBase64?: string }) => d.audioBase64, cb);

export const onConnectionChange = (cb: (connected: boolean) => void) =>
	onTyped(IPC.STT_CONNECTION_CHANGE, (d: { connected: boolean }) => d.connected, cb);

export const onServerStatus = (cb: (status: ServerStatus) => void) =>
	onTyped(IPC.STT_SERVER_STATUS, (d: { status: ServerStatus }) => d.status, cb);

export const onHotkeyPressed = (cb: () => void) => on(IPC.HOTKEY_PRESSED, cb);
export const onHotkeyReleased = (cb: () => void) => on(IPC.HOTKEY_RELEASED, cb);

export const onHotkeyRecordingUpdate = (cb: (keys: string[]) => void) =>
	onTyped(IPC.HOTKEY_RECORDING_UPDATE, (d: { keys: string[] }) => d.keys, cb);

export const onHotkeyRecordingDone = (cb: (combo: string | null) => void) =>
	onTyped(IPC.HOTKEY_RECORDING_DONE, (d: { combo: string | null }) => d.combo, cb);

export const onSettingsChanged = (cb: (settings: AppSettings) => void) =>
	onTyped(IPC.SETTINGS_CHANGED, (d: { settings: AppSettings }) => d.settings, cb);

export const onSettingsSaveError = (cb: (error: string) => void) =>
	onTyped(IPC.SETTINGS_SAVE_ERROR, (d: { error: string }) => d.error, cb);

export const onAudioLevel = (cb: (level: number) => void) =>
	onTyped(IPC.STT_AUDIO_LEVEL, (d: { level: number }) => d.level, cb);

export const onModelDownloadStart = (cb: (model: string) => void) =>
	onTyped(IPC.STT_MODEL_DOWNLOAD_START, (d: { model: string }) => d.model, cb);

export interface DownloadProgressPayload {
	model: string;
	progress: number;
	downloadedBytes?: number;
	totalBytes?: number;
	speedBps?: number;
	etaSeconds?: number;
}

export const onModelDownloadProgress = (cb: (payload: DownloadProgressPayload) => void) =>
	onCast(IPC.STT_MODEL_DOWNLOAD_PROGRESS, cb);

export const onModelDownloadComplete = (cb: (model: string, cancelled: boolean) => void) =>
	on(IPC.STT_MODEL_DOWNLOAD_COMPLETE, (data) => {
		const d = data as { model: string; cancelled?: boolean };
		cb(d.model, d.cancelled ?? false);
	});

export const cancelDownload = () => invokeOrDefault<void>(IPC.STT_CANCEL_DOWNLOAD, undefined);

export const onModelCatalog = (cb: (models: unknown[]) => void) =>
	onTyped(IPC.STT_MODEL_CATALOG, (d: { models: unknown[] }) => d.models, cb);

export const fetchModelCatalog = () => invokeOrDefault<unknown[]>(IPC.STT_GET_MODEL_CATALOG, []);

// Loopback
export const loopbackListDevices = () =>
	invokeOrDefault<
		Array<{ index: number; name: string; defaultSampleRate: number; maxOutputChannels: number }>
	>(IPC.LOOPBACK_LIST_DEVICES, []);

export const loopbackStart = (deviceIndex: number) => send(IPC.LOOPBACK_START, { deviceIndex });

export const loopbackStop = () => send(IPC.LOOPBACK_STOP);

export const onLoopbackStarted = (cb: (deviceName: string) => void) =>
	onTyped(IPC.STT_LOOPBACK_STARTED, (d: { deviceName: string }) => d.deviceName, cb);

export const onLoopbackStopped = (cb: () => void) => on(IPC.STT_LOOPBACK_STOPPED, cb);

// Dialog
export const dialogOpenFile = (
	filters?: Array<{ name: string; extensions: string[] }>,
	title?: string
) => invokeOrDefault<string | null>(IPC.DIALOG_OPEN_FILE, null, { filters, title });

export type AppMenuTemplateItem =
	| { type: "separator" }
	| {
			label: string;
			enabled?: boolean;
			checked?: boolean;
			accelerator?: string;
			actionId?: string;
			submenu?: AppMenuTemplateItem[];
	  };

export const appMenuSetTemplate = (template: AppMenuTemplateItem[]) =>
	invokeOrDefault<{ applied: boolean; itemCount: number }>(
		IPC.APP_MENU_SET_TEMPLATE,
		{ applied: false, itemCount: 0 },
		template
	);

export const appMenuReset = () =>
	invokeOrDefault<{ applied: boolean }>(IPC.APP_MENU_RESET, { applied: false });

export type ContextMenuTemplateItem =
	| { type: "separator" }
	| {
			id?: string;
			type?: "normal" | "checkbox" | "radio";
			label?: string;
			sublabel?: string;
			role?: string;
			accelerator?: string;
			enabled?: boolean;
			visible?: boolean;
			checked?: boolean;
			submenu?: ContextMenuTemplateItem[];
	  };

export const contextMenuShow = (template: ContextMenuTemplateItem[], x?: number, y?: number) =>
	invokeOrDefault<{ selectedId: string | null }>(
		IPC.CONTEXT_MENU_SHOW,
		{ selectedId: null },
		{
			template,
			x,
			y,
		}
	);

type ClipboardOperateResponse =
	| { operation: "readText"; text: string }
	| { operation: "writeText" }
	| { operation: "clear" };

export const clipboardReadText = async () => {
	const result = await invokeSecureOrDefault<ClipboardOperateResponse>(
		IPC.CLIPBOARD_OPERATE,
		{
			operation: "readText",
		},
		{ operation: "readText", text: "" }
	);
	return result.operation === "readText" ? result.text : "";
};

export const clipboardWriteText = (text: string) =>
	invokeSecureOrDefault<ClipboardOperateResponse>(
		IPC.CLIPBOARD_OPERATE,
		{
			operation: "writeText",
			text,
		},
		{ operation: "writeText" }
	);

export const clipboardClear = () =>
	invokeSecureOrDefault<ClipboardOperateResponse>(
		IPC.CLIPBOARD_OPERATE,
		{
			operation: "clear",
		},
		{ operation: "clear" }
	);

export interface UpdaterStatusEntry {
	status: "idle" | "checking" | "available" | "not-available" | "downloaded" | "error";
	timestamp: number;
	version?: string;
	message?: string;
}

export const updaterGetStatusHistory = () =>
	invokeSecureOrDefault<UpdaterStatusEntry[]>(IPC.UPDATER_GET_STATUS_HISTORY, {}, []);

export const updaterClearStatusHistory = () =>
	invokeSecureOrDefault<{ cleared: true }>(IPC.UPDATER_CLEAR_STATUS_HISTORY, {}, { cleared: true });

export const onUpdaterStatus = (cb: (entry: UpdaterStatusEntry) => void) =>
	onCast(IPC.UPDATER_STATUS, cb);

export interface WindowTelemetryPayload {
	event:
		| "moved"
		| "resized"
		| "focused"
		| "blurred"
		| "shown"
		| "hidden"
		| "minimized"
		| "restored"
		| "maximized"
		| "unmaximized";
	bounds: { x: number; y: number; width: number; height: number };
}

export const onWindowTelemetry = (cb: (payload: WindowTelemetryPayload) => void) =>
	onCast(IPC.WINDOW_TELEMETRY, cb);

// File transcription
export const fileTranscribe = (filePath: string) =>
	invokeOrDefault<{ requestId: string }>(IPC.FILE_TRANSCRIBE, { requestId: "" }, { filePath });

export const onFileTranscriptionProgress = (
	cb: (data: { fileName: string; progress: number; message: string }) => void
) => onCast(IPC.FILE_TRANSCRIPTION_PROGRESS, cb);

export const onFileTranscriptionComplete = (
	cb: (data: { requestId: string; fileName: string; text: string; outputPath: string }) => void
) => onCast(IPC.FILE_TRANSCRIPTION_COMPLETE, cb);

export const onFileTranscriptionError = (
	cb: (data: { requestId: string; fileName: string; error: string }) => void
) => onCast(IPC.FILE_TRANSCRIPTION_ERROR, cb);

// LLM
export type { OllamaDetectResult, OllamaModel, OllamaScanResult } from "./models";

const OLLAMA_SCAN_FALLBACK: OllamaScanResult = {
	models: [],
	reachable: false,
	error: "IPC unavailable",
};

const OLLAMA_DETECT_FALLBACK: OllamaDetectResult = { installed: false };

export const fetchOllamaModels = (): Promise<OllamaScanResult> =>
	invokeOrDefault<OllamaScanResult>(IPC.LLM_SCAN_MODELS, OLLAMA_SCAN_FALLBACK);

export const detectOllama = (): Promise<OllamaDetectResult> =>
	invokeOrDefault<OllamaDetectResult>(IPC.LLM_DETECT_OLLAMA, OLLAMA_DETECT_FALLBACK);

export const startOllama = (): Promise<{ started: boolean; error?: string }> =>
	invokeOrDefault<{ started: boolean; error?: string }>(IPC.LLM_START_OLLAMA, {
		started: false,
		error: "IPC unavailable",
	});

export const processWithLlm = (text: string, model: string, preset: string): Promise<string> =>
	invokeOrDefault<string>(IPC.LLM_PROCESS_TEXT, text, { text, model, preset });

export const onLlmCatalog = (callback: (models: OllamaModel[]) => void): (() => void) => {
	if (!isElectron()) {
		return noop;
	}
	return onTyped(IPC.LLM_CATALOG, (d: { models: OllamaModel[] }) => d.models, callback);
};
