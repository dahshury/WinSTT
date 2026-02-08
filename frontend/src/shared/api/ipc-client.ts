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
	on(IPC.STT_REALTIME_TEXT, (data) => cb((data as { text: string }).text));

export const onFullSentence = (cb: (text: string) => void) =>
	on(IPC.STT_FULL_SENTENCE, (data) => cb((data as { text: string }).text));

export const onRecordingStart = (cb: () => void) => on(IPC.STT_RECORDING_START, cb);
export const onRecordingStop = (cb: () => void) => on(IPC.STT_RECORDING_STOP, cb);
export const onVadStart = (cb: () => void) => on(IPC.STT_VAD_START, cb);
export const onVadStop = (cb: () => void) => on(IPC.STT_VAD_STOP, cb);

export const onTranscriptionStart = (cb: (audioBase64?: string) => void) =>
	on(IPC.STT_TRANSCRIPTION_START, (data) => cb((data as { audioBase64?: string }).audioBase64));

export const onConnectionChange = (cb: (connected: boolean) => void) =>
	on(IPC.STT_CONNECTION_CHANGE, (data) => cb((data as { connected: boolean }).connected));

export const onServerStatus = (cb: (status: ServerStatus) => void) =>
	on(IPC.STT_SERVER_STATUS, (data) => cb((data as { status: ServerStatus }).status));

export const onHotkeyPressed = (cb: () => void) => on(IPC.HOTKEY_PRESSED, cb);
export const onHotkeyReleased = (cb: () => void) => on(IPC.HOTKEY_RELEASED, cb);

export const onSettingsChanged = (cb: (settings: AppSettings) => void) =>
	on(IPC.SETTINGS_CHANGED, (data) => cb((data as { settings: AppSettings }).settings));
