import { commands } from "@/bindings";
import { IPC } from "../ipc-channels";
import {
	commandOrDefault,
	invoke,
	invokeOrDefault,
	on,
	onCast,
	onTyped,
	send,
} from "../ipc-transport";
import type {
	AllowedMethod,
	AllowedParameter,
	AppSettingsSaveInput,
	AudioDevice,
	GpuInfo,
	ServerStatus,
} from "../models";
import { decodeSettingsPayload } from "../settings-codec";

type AppSettings = ReturnType<typeof decodeSettingsPayload>;

interface AudioDevicesChangedPayload {
	devices: AudioDevice[];
}

/**
 * One audio OUTPUT device as the Rust backend sees it (cpal enumeration). The
 * backend can't supply the browser's `MediaDeviceInfo.deviceId` (needed for
 * `setSinkId`), so it owns the authoritative MEMBERSHIP — name + default —
 * which the renderer joins to a browser `deviceId` by name. See
 * `use-output-devices.ts`.
 */
export interface AudioOutputDevice {
	index: number;
	isDefault: boolean;
	name: string;
}

interface AudioOutputDevicesChangedPayload {
	devices: AudioOutputDevice[];
}

export interface MicrophoneLevelMonitorTarget {
	deviceIndex: number | null;
	id: string;
}

export interface MicrophoneLevelEntry {
	id: string;
	level: number;
}

export interface MicrophoneLevelsPayload {
	levels: MicrophoneLevelEntry[];
}

export interface ContextAppEntry {
	exe: string;
	icon?: string | null;
	id: string;
	label: string;
	title?: string | null;
}

// STT commands
export const sttSetParameter = (parameter: AllowedParameter, value: unknown) =>
	send(IPC.STT_SET_PARAMETER, { parameter, value });

export const sttGetParameter = (parameter: AllowedParameter) =>
	invokeOrDefault<unknown>(IPC.STT_GET_PARAMETER, null, { parameter });

export const sttCallMethod = (method: AllowedMethod, args?: unknown[]) =>
	send(IPC.STT_CALL_METHOD, { method, args });

/**
 * Cancel the in-flight dictation session — discards the recording, aborts any
 * running LLM cleanup, and hides the overlay. Mirrors what Escape does; used
 * by the X button on the overlay pill.
 */
export const sttAbortOperation = () => send(IPC.STT_ABORT_OPERATION);

/**
 * Subscribe to the "user-initiated cancel just landed" event broadcast by
 * `handleAbortOperation` in main. Lets renderer hooks (usePushToTalk's toggle
 * mirror) reset their local "session is active" state so the next hotkey press
 * starts a fresh recording instead of toggling off a session the server has
 * already aborted.
 */
export const onSttSessionAborted = (cb: () => void) =>
	on(IPC.STT_SESSION_ABORTED, () => cb());

// Hotkey
export const hotkeyRegister = (accelerator: string) =>
	invokeOrDefault<boolean>(IPC.HOTKEY_REGISTER, false, { accelerator });

export const hotkeyUnregister = (accelerator: string) =>
	send(IPC.HOTKEY_UNREGISTER, { accelerator });

export const hotkeyStartRecording = () =>
	invokeOrDefault<boolean>(IPC.HOTKEY_START_RECORDING, false);

export const hotkeyStopRecording = () => send(IPC.HOTKEY_STOP_RECORDING);

// System
export const autostartSet = (enabled: boolean) =>
	send(IPC.AUTOSTART_SET, { enabled });
export const autostartGet = () =>
	invokeOrDefault<boolean>(IPC.AUTOSTART_GET, false);
export const audioGetDevices = () =>
	invokeOrDefault<AudioDevice[]>(IPC.AUDIO_GET_DEVICES, []);
export const audioRefreshDevices = () =>
	invokeOrDefault<AudioDevice[]>(IPC.AUDIO_REFRESH_DEVICES, []);
export const onAudioDevicesChanged = (cb: (devices: AudioDevice[]) => void) =>
	onTyped<AudioDevicesChangedPayload, AudioDevice[]>(
		IPC.AUDIO_DEVICES_CHANGED,
		(payload) => payload.devices,
		cb,
	);
export const onAudioDeviceChangeDetected = (cb: () => void) =>
	on(IPC.AUDIO_DEVICECHANGE_DETECTED, () => cb());
export const audioGetOutputDevices = () =>
	invokeOrDefault<AudioOutputDevice[]>(IPC.AUDIO_GET_OUTPUT_DEVICES, []);
export const audioRefreshOutputDevices = () =>
	invokeOrDefault<AudioOutputDevice[]>(IPC.AUDIO_REFRESH_OUTPUT_DEVICES, []);
export const onAudioOutputDevicesChanged = (
	cb: (devices: AudioOutputDevice[]) => void,
) =>
	onTyped<AudioOutputDevicesChangedPayload, AudioOutputDevice[]>(
		IPC.AUDIO_OUTPUT_DEVICES_CHANGED,
		(payload) => payload.devices,
		cb,
	);
export const audioSetSelectedMicrophone = (deviceName: string) =>
	invoke<void>(IPC.AUDIO_SET_SELECTED_MICROPHONE, { deviceName });
export const startMicrophoneLevelMonitor = (
	targets: MicrophoneLevelMonitorTarget[],
) =>
	invokeOrDefault<void>(IPC.AUDIO_START_MICROPHONE_LEVEL_MONITOR, undefined, {
		targets,
	});
export const stopMicrophoneLevelMonitor = () =>
	invokeOrDefault<void>(IPC.AUDIO_STOP_MICROPHONE_LEVEL_MONITOR, undefined);
export const onMicrophoneLevels = (
	cb: (payload: MicrophoneLevelsPayload) => void,
) => onCast<MicrophoneLevelsPayload>(IPC.AUDIO_MICROPHONE_LEVELS, cb);
export const gpuGetInfo = () =>
	invokeOrDefault<GpuInfo[]>(IPC.GPU_GET_INFO, []);
export const getSystemLocale = () =>
	invokeOrDefault<string>(IPC.APP_GET_SYSTEM_LOCALE, "");
export const listContextApps = () =>
	invokeOrDefault<ContextAppEntry[]>(IPC.CONTEXT_LIST_APPS, []);

// Settings
//
// `Partial<AppSettings>` because partial top-level sections are legal:
// `settingsSaveImpl` in main only iterates `Object.entries(payload)` and writes
// keys that appear in `ALLOWED_SETTINGS_KEYS`. Callers like `useVadCalibration`
// and `useDeviceSwitchFeedback` send only `{ audio: ... }` so they cannot
// clobber a section (e.g. `general.overlayMode`) that the user just changed in
// the settings panel but hasn't debounce-saved yet.
export const settingsSave = (settings: Partial<AppSettings>) =>
	send(IPC.SETTINGS_SAVE, { settings: settings as AppSettingsSaveInput });
export const settingsLoad = async (): Promise<AppSettings> => {
	const payload = await invokeOrDefault<unknown>(IPC.SETTINGS_LOAD, {});
	return decodeSettingsPayload(payload);
};
export const settingsLoadStrict = async (): Promise<AppSettings> => {
	const payload = await invoke<unknown>(IPC.SETTINGS_LOAD);
	return decodeSettingsPayload(payload ?? {});
};

export interface RemoveApplicationDataResult {
	deletePortableAppDir: boolean;
	deletedOllamaModels: string[];
	ollamaErrors: string[];
	portable: boolean;
	scheduled: boolean;
}

export interface RemoveDownloadedModelsResult {
	deletedModelCaches: number;
	disabledFeatures: string[];
	deletedOllamaModels: string[];
	ollamaErrors: string[];
	errors: string[];
}

export const removeApplicationData = (deleteOllamaModels: boolean) =>
	invokeOrDefault<RemoveApplicationDataResult>(
		IPC.SETTINGS_REMOVE_APPLICATION_DATA,
		{
			deletePortableAppDir: false,
			deletedOllamaModels: [],
			ollamaErrors: [],
			portable: false,
			scheduled: false,
		},
		{ deleteOllamaModels },
	);

export const removeDownloadedModels = (deleteOllamaModels: boolean) =>
	invokeOrDefault<RemoveDownloadedModelsResult>(
		IPC.SETTINGS_REMOVE_DOWNLOADED_MODELS,
		{
			deletedModelCaches: 0,
			disabledFeatures: [],
			deletedOllamaModels: [],
			ollamaErrors: [],
			errors: [],
		},
		{ deleteOllamaModels },
	);

// Connection status
export const sttIsConnected = () =>
	invokeOrDefault<boolean>(IPC.STT_IS_CONNECTED, false);

export const notifyRendererReady = () => commands.winsttEmitReady();

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
export const settingsWindowReady = () => send(IPC.SETTINGS_WINDOW_READY);
export const windowCloseSelf = () => send(IPC.WINDOW_CLOSE_SELF);

export interface RealtimeTextPayload {
	text: string;
	isFinal: boolean;
}

function realtimeTextPayload(d: {
	text: string;
	isFinal?: boolean;
	is_final?: boolean;
}): RealtimeTextPayload {
	return {
		text: d.text,
		isFinal: d.isFinal ?? d.is_final ?? false,
	};
}

// Event subscriptions
// Note: preload strips the IpcRendererEvent, so callbacks receive only the data args
export const onRealtimeText = (cb: (payload: RealtimeTextPayload) => void) =>
	onTyped(IPC.STT_REALTIME_TEXT, realtimeTextPayload, cb);

export const onFullSentence = (cb: (text: string) => void) =>
	onTyped(IPC.STT_FULL_SENTENCE, (d: { text: string }) => d.text, cb);

export const onNoAudioDetected = (cb: () => void) =>
	on(IPC.STT_NO_AUDIO_DETECTED, cb);

export const onTranscriptionFailed = (cb: () => void) =>
	on(IPC.STT_TRANSCRIPTION_FAILED, cb);

export const onRecordingStart = (cb: () => void) =>
	on(IPC.STT_RECORDING_START, cb);
export const onRecordingStop = (cb: () => void) =>
	on(IPC.STT_RECORDING_STOP, cb);
export const onVadStart = (cb: () => void) => on(IPC.STT_VAD_START, cb);
export const onVadStop = (cb: () => void) => on(IPC.STT_VAD_STOP, cb);

export const onTranscriptionStart = (cb: (audioBase64?: string) => void) =>
	onTyped(
		IPC.STT_TRANSCRIPTION_START,
		(d: { audioBase64?: string }) => d.audioBase64,
		cb,
	);

export const onConnectionChange = (cb: (connected: boolean) => void) =>
	onTyped(
		IPC.STT_CONNECTION_CHANGE,
		(d: { connected: boolean }) => d.connected,
		cb,
	);

export const onServerStatus = (cb: (status: ServerStatus) => void) =>
	onTyped(IPC.STT_SERVER_STATUS, (d: { status: ServerStatus }) => d.status, cb);

export const onHotkeyPressed = (cb: () => void) => on(IPC.HOTKEY_PRESSED, cb);
export const onHotkeyReleased = (cb: () => void) => on(IPC.HOTKEY_RELEASED, cb);

export const onHotkeyRecordingUpdate = (cb: (keys: string[]) => void) =>
	onTyped(IPC.HOTKEY_RECORDING_UPDATE, (d: { keys: string[] }) => d.keys, cb);

export const onHotkeyRecordingDone = (cb: (combo: string | null) => void) =>
	onTyped(
		IPC.HOTKEY_RECORDING_DONE,
		(d: { combo: string | null }) => d.combo,
		cb,
	);

export const onSettingsChanged = (cb: (settings: AppSettings) => void) =>
	onTyped(
		IPC.SETTINGS_CHANGED,
		(d: { settings: AppSettings }) => d.settings,
		cb,
	);

export const onSettingsSaveError = (cb: (error: string) => void) =>
	onTyped(IPC.SETTINGS_SAVE_ERROR, (d: { error: string }) => d.error, cb);

export interface WakewordModelStatusPayload {
	available: boolean;
	artifactLabel?: string;
	downloadedBytes?: number | null;
	downloadSizeLabel?: string;
	downloading: boolean;
	engine?: string;
	engineLabel?: string;
	etaSeconds?: number | null;
	error?: string | null;
	phase?: "idle" | "downloading" | "paused" | "complete" | "failed";
	progress?: number | null;
	qualityLabel?: string;
	speedBps?: number | null;
	totalBytes?: number | null;
}

const DEFAULT_WAKEWORD_MODEL_STATUS: WakewordModelStatusPayload = {
	available: false,
	downloading: false,
};

export const wakewordModelStatus = () =>
	commandOrDefault(
		"wakeword_model_status",
		commands.wakewordModelStatus,
		DEFAULT_WAKEWORD_MODEL_STATUS,
	);

export const wakewordStartModelDownload = () =>
	commandOrDefault(
		"wakeword_start_model_download",
		commands.wakewordStartModelDownload,
		DEFAULT_WAKEWORD_MODEL_STATUS,
	);

export const wakewordPauseModelDownload = () =>
	commandOrDefault(
		"wakeword_pause_model_download",
		commands.wakewordPauseModelDownload,
		DEFAULT_WAKEWORD_MODEL_STATUS,
	);

export const wakewordResumeModelDownload = () =>
	commandOrDefault(
		"wakeword_resume_model_download",
		commands.wakewordResumeModelDownload,
		DEFAULT_WAKEWORD_MODEL_STATUS,
	);

export const wakewordCancelModelDownload = () =>
	commandOrDefault(
		"wakeword_cancel_model_download",
		commands.wakewordCancelModelDownload,
		DEFAULT_WAKEWORD_MODEL_STATUS,
	);

export const onWakewordModelStatus = (
	cb: (payload: WakewordModelStatusPayload) => void,
) => onCast(IPC.WAKEWORD_MODEL_STATUS, cb);

export const onAudioLevel = (cb: (level: number) => void) =>
	onTyped(IPC.STT_AUDIO_LEVEL, (d: { level: number }) => d.level, cb);

// VAD sensitivity adaptation — emitted by the STT server when the
// adaptive Silero calibrator settles on a new value. Main-side relay is
// still WIP; until it's hooked up, the subscriber never fires and the
// renderer's calibration store stays at its last persisted value.
export interface VadSensitivityAdaptedEvent {
	newSensitivity: number;
	noiseFloorRms?: number;
	speechPeakRms?: number;
}

export const onVadSensitivityAdapted = (
	cb: (event: VadSensitivityAdaptedEvent) => void,
): (() => void) => onCast(IPC.STT_VAD_SENSITIVITY_ADAPTED, cb);
