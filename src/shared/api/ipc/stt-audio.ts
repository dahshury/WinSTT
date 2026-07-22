import {
	type AppDataUsageEntry,
	commands,
	type MicrophoneLevelMonitorTarget,
	type Result,
} from "@/bindings";
import { decodeSettingsPayload } from "@/shared/config/settings-codec";
import { hasTauriRuntime } from "@/shared/lib/tauri-runtime";
import { NATIVE_EVENTS as IPC } from "../native-events";
import { callPlugin, windowOp } from "../adapter/plugins";
import { commandOrDefault, on, onCast, onTyped } from "../native-boundary";
import type {
	AllowedMethod,
	AllowedParameter,
	AppSettingsSaveInput,
	AudioDevice,
	GpuInfo,
	ServerStatus,
} from "../models";
type AppSettings = ReturnType<typeof decodeSettingsPayload>;

export interface SettingsSnapshotPayload {
	revision: number;
	settings: AppSettings;
}

export interface SettingsPatchAck extends SettingsSnapshotPayload {
	applied: boolean;
	changedSections: string[];
}

let lastKnownSettingsSnapshot: SettingsSnapshotPayload | null = null;

function unwrapResult<T, E>(result: Result<T, E>): T {
	if (result.status === "ok") {
		return result.data;
	}
	throw result.error;
}

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

export type { MicrophoneLevelMonitorTarget };

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
	void commands.winsttSetParameter(parameter, value as never);

export const sttGetParameter = (parameter: AllowedParameter) =>
	commandOrDefault(
		"winstt_get_parameter",
		() => commands.winsttGetParameter(parameter),
		null,
	);

export const sttCallMethod = (method: AllowedMethod, args?: unknown[]) =>
	void commands.winsttCallMethod(method, (args as never[] | undefined) ?? null);

/**
 * Cancel the in-flight dictation session — discards the recording, aborts any
 * running LLM cleanup, and hides the overlay. Mirrors what Escape does; used
 * by the X button on the overlay pill.
 */
export const sttAbortOperation = () => void commands.cancelCurrentOperation();

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
	commandOrDefault(
		"hotkey_register",
		() => commands.hotkeyRegister(accelerator),
		false,
	);

export const hotkeyUnregister = (accelerator: string) =>
	void commands.hotkeyUnregister(accelerator);

export const hotkeyStartRecording = () =>
	commandOrDefault(
		"hotkey_start_recording",
		() => commands.hotkeyStartRecording(),
		false,
	);

export const hotkeyStopRecording = () => void commands.hotkeyStopRecording();

// System
export const autostartSet = (enabled: boolean) => {
	void callPlugin("autostart:set", { enabled });
};
export const autostartGet = () =>
	commandOrDefault(
		"autostart_get",
		async () => Boolean(await callPlugin("autostart:get", undefined)),
		false,
	);
export const audioGetDevices = () =>
	commandOrDefault(
		"get_audio_devices",
		async () => (await commands.getAudioDevices()) as AudioDevice[],
		[],
	);
export const audioRefreshDevices = () =>
	commandOrDefault(
		"refresh_audio_devices",
		async () => (await commands.refreshAudioDevices()) as AudioDevice[],
		[],
	);
export const onAudioDevicesChanged = (cb: (devices: AudioDevice[]) => void) =>
	onTyped<AudioDevicesChangedPayload, AudioDevice[]>(
		IPC.AUDIO_DEVICES_CHANGED,
		(payload) => payload.devices,
		cb,
	);
export const onAudioDeviceChangeDetected = (cb: () => void) =>
	on(IPC.AUDIO_DEVICECHANGE_DETECTED, () => cb());
export const audioGetOutputDevices = () =>
	commandOrDefault(
		"get_audio_output_devices",
		async () => (await commands.getAudioOutputDevices()) as AudioOutputDevice[],
		[],
	);
export const audioRefreshOutputDevices = () =>
	commandOrDefault(
		"refresh_audio_output_devices",
		async () =>
			(await commands.refreshAudioOutputDevices()) as AudioOutputDevice[],
		[],
	);
export const onAudioOutputDevicesChanged = (
	cb: (devices: AudioOutputDevice[]) => void,
) =>
	onTyped<AudioOutputDevicesChangedPayload, AudioOutputDevice[]>(
		IPC.AUDIO_OUTPUT_DEVICES_CHANGED,
		(payload) => payload.devices,
		cb,
	);
export const startMicrophoneLevelMonitor = (
	targets: MicrophoneLevelMonitorTarget[],
) =>
	commandOrDefault(
		"start_microphone_level_monitor",
		() => commands.startMicrophoneLevelMonitor(targets),
		undefined,
	);
export const stopMicrophoneLevelMonitor = () =>
	commandOrDefault(
		"stop_microphone_level_monitor",
		() => commands.stopMicrophoneLevelMonitor(),
		undefined,
	);
export const onMicrophoneLevels = (
	cb: (payload: MicrophoneLevelsPayload) => void,
) => onCast<MicrophoneLevelsPayload>(IPC.AUDIO_MICROPHONE_LEVELS, cb);
export const gpuGetInfo = () =>
	commandOrDefault(
		"gpu_get_info",
		async () => (await commands.gpuGetInfo()) as GpuInfo[],
		[],
	);
export const getSystemLocale = () =>
	commandOrDefault(
		"app_get_system_locale",
		async () => String(await callPlugin("os:locale", undefined)),
		"",
	);
export const listContextApps = () =>
	commandOrDefault(
		"context_list_apps",
		async () => (await commands.contextListApps()) as ContextAppEntry[],
		[],
	);

// Settings
//
// `Partial<AppSettings>` because partial top-level sections are legal:
// `settingsSaveImpl` in main only iterates `Object.entries(payload)` and writes
// keys that appear in `ALLOWED_SETTINGS_KEYS`. Callers like `useVadCalibration`
// and `useDeviceSwitchFeedback` send only `{ audio: ... }` so they cannot
// clobber a section (e.g. `general.overlayMode`) that the user just changed in
// the settings panel but hasn't debounce-saved yet.
export const settingsSave = (settings: Partial<AppSettings>) =>
	void saveWithOneConflictRebase(settings).catch((error) => {
		console.error("[settings] save failed:", error);
	});

/**
 * Acknowledged settings save (audit #46). Resolves once the backend confirms
 * the write and REJECTS when it fails, so the caller can advance its
 * "last saved" baseline ONLY on confirmed success and keep the section dirty
 * (retry) on failure — the fire-and-forget `settingsSave` above swallowed
 * rejections, letting a section read "clean" after a rejected write and never
 * be re-sent. The backend's fallible `winstt_patch_settings` command surfaces a
 * `Result::Err` on failure, which `invoke` unwraps into a rejected promise.
 */
export const settingsSaveAck = (
	settings: Partial<AppSettings>,
	baseRevision?: number,
): Promise<SettingsPatchAck> =>
	saveSettings(
		settings as AppSettingsSaveInput,
		baseRevision ?? lastKnownSettingsSnapshot?.revision,
	);
export const settingsLoad = async (): Promise<AppSettings> =>
	(await settingsLoadSnapshot()).settings;
export const settingsLoadStrict = async (): Promise<AppSettings> =>
	(await settingsLoadSnapshotStrict()).settings;

export const settingsLoadSnapshot =
	async (): Promise<SettingsSnapshotPayload> => {
		try {
			return await settingsLoadSnapshotStrict();
		} catch {
			return {
				revision: lastKnownSettingsSnapshot?.revision ?? 0,
				settings: decodeSettingsPayload({}),
			};
		}
	};

export const settingsLoadSnapshotStrict =
	async (): Promise<SettingsSnapshotPayload> => {
		const snapshot = await loadSettingsSnapshot();
		lastKnownSettingsSnapshot = snapshot;
		return snapshot;
	};

function canUseDevSettingsBridge(): boolean {
	return (
		typeof window !== "undefined" &&
		window.location.port === "1420" &&
		!hasTauriRuntime()
	);
}

async function readDevSettingsResponse(
	response: Response,
): Promise<Record<string, unknown>> {
	let body: unknown = {};
	try {
		body = await response.json();
	} catch {
		// The HTTP status below remains the useful error signal.
	}
	if (!response.ok) {
		const message =
			body !== null &&
			typeof body === "object" &&
			"error" in body &&
			typeof body.error === "string"
				? body.error
				: `HTTP ${response.status}`;
		throw new Error(message);
	}
	return body !== null && typeof body === "object"
		? (body as Record<string, unknown>)
		: {};
}

async function loadSettingsSnapshot(): Promise<SettingsSnapshotPayload> {
	if (!canUseDevSettingsBridge()) {
		const snapshot = await commands.winsttGetSettingsSnapshot();
		return {
			revision: snapshot.revision,
			settings: decodeSettingsPayload(snapshot.settings),
		};
	}
	const response = await fetch("/__winstt/settings", {
		headers: { Accept: "application/json" },
	});
	const body = await readDevSettingsResponse(response);
	return {
		revision: typeof body["revision"] === "number" ? body["revision"] : 0,
		settings: decodeSettingsPayload(body["settings"] ?? {}),
	};
}

async function saveSettings(
	settings: AppSettingsSaveInput,
	baseRevision?: number,
): Promise<SettingsPatchAck> {
	const base =
		baseRevision ??
		lastKnownSettingsSnapshot?.revision ??
		(await loadSettingsSnapshot()).revision;
	if (!canUseDevSettingsBridge()) {
		const response = unwrapResult(
			await commands.winsttPatchSettings({
				baseRevision: base,
				settings: settings as never,
			}),
		);
		const ack: SettingsPatchAck = {
			applied: response.applied,
			changedSections: response.changedSections,
			revision: response.snapshot.revision,
			settings: decodeSettingsPayload(response.snapshot.settings),
		};
		lastKnownSettingsSnapshot = ack;
		return ack;
	}
	const response = await fetch("/__winstt/settings", {
		method: "PATCH",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ baseRevision: base, settings }),
	});
	const body = await readDevSettingsResponse(response);
	const ack: SettingsPatchAck = {
		applied: body["applied"] !== false,
		changedSections: Array.isArray(body["changedSections"])
			? body["changedSections"].filter(
					(value): value is string => typeof value === "string",
				)
			: Object.keys(settings),
		revision:
			typeof body["revision"] === "number" ? body["revision"] : base + 1,
		settings: decodeSettingsPayload(body["settings"] ?? settings),
	};
	lastKnownSettingsSnapshot = ack;
	return ack;
}

async function saveWithOneConflictRebase(
	settings: Partial<AppSettings>,
): Promise<void> {
	const first = await settingsSaveAck(settings);
	if (first.applied) {
		return;
	}
	const retry = await settingsSaveAck(settings, first.revision);
	if (!retry.applied) {
		throw new Error(
			"Settings changed concurrently twice; local update was not persisted",
		);
	}
}

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

export const removeApplicationData = async (deleteOllamaModels: boolean) =>
	(await unwrapResult(
		await commands.removeApplicationData(deleteOllamaModels),
	)) as RemoveApplicationDataResult;

export const removeDownloadedModels = async (deleteOllamaModels: boolean) =>
	(await unwrapResult(
		await commands.removeDownloadedModels(deleteOllamaModels),
	)) as RemoveDownloadedModelsResult;

// Connection status
export const sttIsConnected = () => Promise.resolve(hasTauriRuntime());

export const notifyRendererReady = () => commands.winsttEmitReady();

// Window controls
export const windowMinimize = () => void windowOp("minimize", []);
export const windowMaximize = () => void windowOp("maximize", []);
export const windowClose = () => void windowOp("hide", []);
export const windowOpenSettings = () => void trayWindowOpenSettings();
export const windowCloseSelf = () =>
	void runWindowCommand("close_self_window", () => commands.closeSelfWindow());

function commandResultError(value: unknown): unknown | null {
	if (
		value !== null &&
		typeof value === "object" &&
		"status" in value &&
		(value as { status: unknown }).status === "error"
	) {
		return (value as { error?: unknown }).error ?? "Unknown command error";
	}
	return null;
}

async function runWindowCommand(
	label: string,
	thunk: () => Promise<unknown>,
): Promise<void> {
	try {
		const value = await thunk();
		const error = commandResultError(value);
		if (error !== null) {
			throw error;
		}
	} catch (error) {
		console.error(`[ipc] window command "${label}" failed:`, error);
	}
}

export const trayWindowOpenSettings = () =>
	runWindowCommand("open_window(settings)", () =>
		commands.openWindow("settings", null, null, null, null, null, null, null),
	);

export const windowOpenContextPlayground = () =>
	runWindowCommand("open_window(context-playground)", () =>
		commands.openWindow(
			"context-playground",
			null,
			null,
			null,
			null,
			null,
			null,
			null,
		),
	);

export const windowShowMain = () =>
	runWindowCommand("show_main_window_command", () =>
		commands.showMainWindowCommand(),
	);

export const windowCloseNamed = (name: string) =>
	runWindowCommand(`close_window(${name})`, () => commands.closeWindow(name));

/** Per-category on-disk footprint of WinSTT's application data, for the About
 *  tab's "what will I free?" preview. Read-only; resolves the `Result`. */
export const appDataUsage = async (): Promise<AppDataUsageEntry[]> => {
	const result = await commands.appDataUsage();
	if (result.status === "ok") {
		return result.data;
	}
	throw new Error(
		typeof result.error === "string"
			? result.error
			: "Failed to read application data usage",
	);
};

/** Remove a SINGLE app-data category in-process (no restart). The `history`
 *  category is handled by `commands.historyClear` instead. Resolves to the list
 *  of per-path failures (empty on full success). */
export const removeAppDataCategory = async (key: string): Promise<string[]> => {
	const result = await commands.removeAppDataCategory(key);
	if (result.status === "ok") {
		return result.data;
	}
	throw new Error(
		typeof result.error === "string"
			? result.error
			: "Failed to remove application data category",
	);
};

/** Open the detached model-footprint hover panel, anchored above the trigger
 *  rect (the footer GPU/CPU chip's viewport bounds). Mirrors how the model
 *  picker is opened, but as a content-sized, non-focusable hover popup. */
export const footprintWindowOpen = (rect: {
	x: number;
	y: number;
	width: number;
	height: number;
}) =>
	runWindowCommand("open_window(model-footprint)", () =>
		commands.openWindow(
			"model-footprint",
			rect.x,
			rect.y,
			rect.width,
			rect.height,
			null,
			null,
			null,
		),
	);

export const windowResizeNamed = (
	name: string,
	width: number,
	height: number,
) =>
	runWindowCommand(`resize_window(${name})`, () =>
		commands.resizeWindow(name, width, height),
	);

export const windowQuitApp = () =>
	runWindowCommand("quit_app", () => commands.quitApp());

export const contextPlaygroundSetLive = (enabled: boolean) =>
	runWindowCommand(`context_playground_set_live(${enabled})`, () =>
		commands.contextPlaygroundSetLive(enabled),
	);

export const contextPlaygroundArmDeep = () =>
	runWindowCommand("context_playground_arm_deep", () =>
		commands.contextPlaygroundArmDeep(),
	);

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

export interface FullSentencePayload {
	text: string;
	/** Diarized global speaker id for this listen-mode caption row (0-based).
	 * `null`/absent when diarization is off, the row's span had no labeled
	 * overlap yet, or the sentence came from mic dictation. */
	speaker?: number | null;
}

export const onFullSentence = (cb: (payload: FullSentencePayload) => void) =>
	onTyped(
		IPC.STT_FULL_SENTENCE,
		(d: { text: string; speaker?: number | null }): FullSentencePayload => ({
			text: d.text,
			speaker: typeof d.speaker === "number" ? d.speaker : null,
		}),
		cb,
	);

export const onNoAudioDetected = (cb: () => void) =>
	on(IPC.STT_NO_AUDIO_DETECTED, cb);

export interface TranscriptionFailedPayload {
	message?: string | null;
}

export const onTranscriptionFailed = (
	cb: (payload: TranscriptionFailedPayload) => void,
) =>
	on(IPC.STT_TRANSCRIPTION_FAILED, (payload) => {
		if (payload !== null && typeof payload === "object") {
			cb(payload as TranscriptionFailedPayload);
			return;
		}
		cb({});
	});

export const onRecordingStart = (cb: () => void) =>
	on(IPC.STT_RECORDING_START, cb);
/** Mic confirmed open and delivering audio (first captured frame of a recording).
 * Fires once per take, after the OS finishes opening the device — distinct from
 * `onRecordingStart`, which fires as soon as `stream.play()` returns. */
export const onCaptureActive = (cb: () => void) =>
	on(IPC.STT_CAPTURE_ACTIVE, cb);
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

/** The backend rejected a modifier-only push-to-talk binding (unsupported on
 *  this OS). Payload is the attempted accelerator string (e.g. "Ctrl+Alt"). */
export const onPttModifierOnlyUnsupported = (cb: (combo: string) => void) =>
	onCast<string>(IPC.PTT_MODIFIER_ONLY_UNSUPPORTED, cb);

export const onPostProcessingProfileSwap = (cb: () => void) =>
	on(IPC.LLM_PROFILE_SWAP, () => cb());

export const onRecordingModeCycle = (cb: () => void) =>
	on(IPC.RECORDING_MODE_CYCLE, () => cb());

export const onHotkeyRecordingUpdate = (cb: (keys: string[]) => void) =>
	onTyped(IPC.HOTKEY_RECORDING_UPDATE, (d: { keys: string[] }) => d.keys, cb);

export const onHotkeyRecordingDone = (cb: (combo: string | null) => void) =>
	onTyped(
		IPC.HOTKEY_RECORDING_DONE,
		(d: { combo: string | null }) => d.combo,
		cb,
	);

export const onSettingsChanged = (cb: (settings: AppSettings) => void) =>
	onSettingsChangedSnapshot(({ settings }) => cb(settings));

export const onSettingsChangedSnapshot = (
	cb: (
		snapshot: SettingsSnapshotPayload & { changedSections: string[] },
	) => void,
) =>
	onTyped(
		IPC.SETTINGS_CHANGED,
		(d: {
			changedSections?: string[];
			revision?: number;
			settings: AppSettings;
		}) => {
			const snapshot = {
				changedSections: d.changedSections ?? [],
				revision: d.revision ?? lastKnownSettingsSnapshot?.revision ?? 0,
				settings: decodeSettingsPayload(d.settings),
			};
			if (
				lastKnownSettingsSnapshot === null ||
				snapshot.revision >= lastKnownSettingsSnapshot.revision
			) {
				lastKnownSettingsSnapshot = snapshot;
			}
			return snapshot;
		},
		(snapshot) => {
			if (snapshot.revision >= (lastKnownSettingsSnapshot?.revision ?? 0)) {
				cb(snapshot);
			}
		},
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
