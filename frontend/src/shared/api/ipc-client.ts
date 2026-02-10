"use client";

import type { components } from "@spec/schema";
import { IPC } from "./ipc-channels";

type AppSettings = components["schemas"]["AppSettings"];
type AudioDevice = components["schemas"]["AudioDevice"];
type GpuInfo = components["schemas"]["GpuInfo"];
type ServerStatus = components["schemas"]["ServerStatus"];
type AllowedParameter = components["schemas"]["AllowedParameter"];
type AllowedMethod = components["schemas"]["AllowedMethod"];

const noop = () => {
	/* not in electron */
};

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
	invoke<unknown>(IPC.STT_GET_PARAMETER, { parameter });

export const sttCallMethod = (method: AllowedMethod, args?: unknown[]) =>
	send(IPC.STT_CALL_METHOD, { method, args });

// Hotkey
export const hotkeyRegister = (accelerator: string) =>
	invoke<boolean>(IPC.HOTKEY_REGISTER, { accelerator });

export const hotkeyUnregister = (accelerator: string) =>
	send(IPC.HOTKEY_UNREGISTER, { accelerator });

export const hotkeyStartRecording = () => invoke<boolean>(IPC.HOTKEY_START_RECORDING);

export const hotkeyStopRecording = () => send(IPC.HOTKEY_STOP_RECORDING);

// System
export const autostartSet = (enabled: boolean) => send(IPC.AUTOSTART_SET, { enabled });
export const autostartGet = () => invoke<boolean>(IPC.AUTOSTART_GET);
export const audioSetMute = (muted: boolean) => send(IPC.AUDIO_SET_MUTE, { muted });
export const audioGetDevices = () => invoke<AudioDevice[]>(IPC.AUDIO_GET_DEVICES);
export const gpuGetInfo = () => invoke<GpuInfo | null>(IPC.GPU_GET_INFO);

// Settings
export const settingsSave = (settings: AppSettings) => send(IPC.SETTINGS_SAVE, { settings });
export const settingsLoad = () => invoke<AppSettings>(IPC.SETTINGS_LOAD);

// Server management
export const sttServerSpawn = () => invoke<void>(IPC.STT_SERVER_SPAWN);
export const sttServerKill = () => invoke<void>(IPC.STT_SERVER_KILL);
export const sttServerStatus = () => invoke<ServerStatus>(IPC.STT_SERVER_GET_STATUS);

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

export const cancelDownload = () => invoke<void>(IPC.STT_CANCEL_DOWNLOAD);

export const onModelCatalog = (cb: (models: unknown[]) => void) =>
	onTyped(IPC.STT_MODEL_CATALOG, (d: { models: unknown[] }) => d.models, cb);

export const fetchModelCatalog = () => invoke<unknown[]>(IPC.STT_GET_MODEL_CATALOG);

// Loopback
export const loopbackListDevices = () =>
	invoke<
		Array<{ index: number; name: string; defaultSampleRate: number; maxOutputChannels: number }>
	>(IPC.LOOPBACK_LIST_DEVICES);

export const loopbackStart = (deviceIndex: number) => send(IPC.LOOPBACK_START, { deviceIndex });

export const loopbackStop = () => send(IPC.LOOPBACK_STOP);

export const onLoopbackStarted = (cb: (deviceName: string) => void) =>
	onTyped(IPC.STT_LOOPBACK_STARTED, (d: { deviceName: string }) => d.deviceName, cb);

export const onLoopbackStopped = (cb: () => void) => on(IPC.STT_LOOPBACK_STOPPED, cb);

// Dialog
export const dialogOpenFile = (
	filters?: Array<{ name: string; extensions: string[] }>,
	title?: string
) => invoke<string | null>(IPC.DIALOG_OPEN_FILE, { filters, title });

// File transcription
export const fileTranscribe = (filePath: string) =>
	invoke<{ requestId: string }>(IPC.FILE_TRANSCRIBE, { filePath });

export const onFileTranscriptionProgress = (
	cb: (data: { fileName: string; progress: number; message: string }) => void
) => onCast(IPC.FILE_TRANSCRIPTION_PROGRESS, cb);

export const onFileTranscriptionComplete = (
	cb: (data: { requestId: string; fileName: string; text: string; outputPath: string }) => void
) => onCast(IPC.FILE_TRANSCRIPTION_COMPLETE, cb);

export const onFileTranscriptionError = (
	cb: (data: { requestId: string; fileName: string; error: string }) => void
) => onCast(IPC.FILE_TRANSCRIPTION_ERROR, cb);
