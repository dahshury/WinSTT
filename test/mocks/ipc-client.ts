/**
 * Faithful fake for `@/shared/api/ipc-client` used by tests.
 *
 * ## Why a faithful fake (not a hollow stub)
 *
 * `mock.module()` in bun:test installs a PROCESS-GLOBAL replacement that is
 * never torn down, and bun caches resolved modules by absolute path. A test
 * file that mocks `@/shared/api/ipc-client` with a semantically INCOMPLETE
 * shim leaks that incomplete module into every later test file — including
 * the ~50 hook tests and the 7 component tests that rely on the REAL module
 * routing through `window.nativeBridge`.
 *
 * The fix is a mock that is BOTH:
 *   1. **Semantically complete** — every export the real module ships is
 *      present, so no later module ever sees `undefined` for a key it
 *      imports (no "Export named X not found", no `useEffect` throwing on
 *      `onHotkeyPressed === undefined`).
 *   2. **Behavior-faithful** — every function delegates to `window.nativeBridge`
 *      exactly the way the real `ipc-client.ts` does (same channels, same
 *      `invokeOrDefault` fallback semantics, same event-payload extraction).
 *      So the ~50 routing-dependent hook tests behave identically whether
 *      they get the real module or this fake leaked in from another file.
 *
 * ## Usage in a partial-mock test
 *
 * Spread this fake, then override only the one or two exports the suite
 * controls. Because the fake is complete + faithful, the leak it installs is
 * harmless regardless of bun's file ordering:
 *
 * ```ts
 * import { ipcClientMock } from "@test/mocks/ipc-client";
 * const fetchSpy = mock(async () => []);
 * mock.module("@/shared/api/ipc-client", () => ({
 *   ...ipcClientMock(),
 *   fetchModelCatalog: fetchSpy,
 * }));
 * ```
 *
 * Each call returns a FRESH object — never a shared reference — so spies
 * installed in one test never leak into another.
 *
 * ## How routing works
 *
 * The real module reads `window.nativeBridge` at CALL time (never at import
 * time). The test preload (`test/preload.ts`) installs a default
 * `window.nativeBridge` and individual tests swap it for an instrumented one.
 * This fake mirrors that: it reads `window.nativeBridge` on every call, so a
 * test that sets `window.nativeBridge.invoke = ...` sees its impl honoured
 * through the fake exactly as through the real module.
 */

import { commands } from "@/bindings";
import { IPC } from "@test/mocks/legacy-ipc";
import { decodeSettingsPayload } from "@/shared/config/settings-codec";

type NativeBridgeApi = Window["nativeBridge"] | undefined;

function api(): NativeBridgeApi {
	return typeof window === "undefined"
		? undefined
		: (window as Window & { nativeBridge?: NativeBridgeApi }).nativeBridge;
}

function hasBridge(): boolean {
	return api() != null;
}

const noop = () => undefined;

type FallbackValue<T> = T | (() => T);

function resolveFallback<T>(fallback: FallbackValue<T>): T {
	return typeof fallback === "function" ? (fallback as () => T)() : fallback;
}

function send(channel: string, ...args: unknown[]): void {
	if (hasBridge()) {
		api()?.send(channel, ...args);
	}
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
	if (hasBridge()) {
		return (await api()?.invoke(channel, ...args)) as T;
	}
	return undefined as T;
}

async function invokeSecure<T>(channel: string, payload?: unknown): Promise<T> {
	if (hasBridge()) {
		return (await api()?.secureInvoke(channel, payload)) as T;
	}
	return undefined as T;
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
	fallback: FallbackValue<T>,
): Promise<T> {
	try {
		const value = await invokeSecure<T | undefined>(channel, payload);
		return value === undefined ? resolveFallback(fallback) : value;
	} catch {
		return resolveFallback(fallback);
	}
}

function unwrapCommandResult<T>(
	result: { status: "ok"; data: T } | { status: "error"; error: unknown },
): T {
	if (result.status === "ok") {
		return result.data;
	}
	throw result.error;
}

async function commandOrDefault<T>(
	thunk: () => Promise<T>,
	fallback: FallbackValue<T>,
): Promise<T> {
	try {
		const value = await thunk();
		return value === undefined ? resolveFallback(fallback) : value;
	} catch {
		return resolveFallback(fallback);
	}
}

function on(
	channel: string,
	callback: (...args: unknown[]) => void,
): () => void {
	if (hasBridge()) {
		return api()?.on(channel, callback) ?? noop;
	}
	return noop;
}

function onTyped<T, V>(
	channel: string,
	extract: (data: T) => V,
	cb: (value: V) => void,
): () => void {
	return on(channel, (data) => cb(extract(data as T)));
}

function onCast<T>(channel: string, cb: (value: T) => void): () => void {
	return on(channel, (data) => cb(data as T));
}

/**
 * Build a fresh, complete, behavior-faithful fake of the ipc-client module.
 * Every key mirrors the real export of the same name and routes through
 * `window.nativeBridge` with identical channel + fallback semantics.
 */
export function ipcClientMock(): Record<string, unknown> {
	return {
		// Low-level wrappers (re-exported by the real module)
		noop,
		send,
		invoke,
		on,
		onTyped,
		onCast,
		hasNativeBridge: hasBridge,
		hasSettingsBackend: hasBridge,
		ipcSend: send,
		ipcInvoke: invoke,
		ipcOn: on,

		getFilePath: (file: File): string =>
			hasBridge() ? (api()?.getPathForFile(file) ?? "") : "",

		// STT commands
		sttSetParameter: (parameter: unknown, value: unknown) =>
			send(IPC.STT_SET_PARAMETER, { parameter, value }),
		sttGetParameter: (parameter: unknown) =>
			invokeOrDefault<unknown>(IPC.STT_GET_PARAMETER, null, { parameter }),
		sttCallMethod: (method: unknown, args?: unknown[]) =>
			send(IPC.STT_CALL_METHOD, { method, args }),

		// Hotkey
		hotkeyRegister: (accelerator: string) =>
			invokeOrDefault<boolean>(IPC.HOTKEY_REGISTER, false, { accelerator }),
		hotkeyUnregister: (accelerator: string) =>
			send(IPC.HOTKEY_UNREGISTER, { accelerator }),
		hotkeyStartRecording: () =>
			invokeOrDefault<boolean>(IPC.HOTKEY_START_RECORDING, false),
		hotkeyStopRecording: () => send(IPC.HOTKEY_STOP_RECORDING),

		// System
		autostartSet: (enabled: boolean) => send(IPC.AUTOSTART_SET, { enabled }),
		autostartGet: () => invokeOrDefault<boolean>(IPC.AUTOSTART_GET, false),
		audioGetDevices: () =>
			invokeOrDefault<unknown[]>(IPC.AUDIO_GET_DEVICES, []),
		audioRefreshDevices: () =>
			invokeOrDefault<unknown[]>(IPC.AUDIO_REFRESH_DEVICES, []),
		onAudioDevicesChanged: (cb: (devices: unknown[]) => void) =>
			onTyped(
				IPC.AUDIO_DEVICES_CHANGED,
				(d: { devices: unknown[] }) => d.devices,
				cb,
			),
		onAudioDeviceChangeDetected: (cb: () => void) =>
			on(IPC.AUDIO_DEVICECHANGE_DETECTED, cb),
		audioGetOutputDevices: () =>
			invokeOrDefault<unknown[]>(IPC.AUDIO_GET_OUTPUT_DEVICES, []),
		audioRefreshOutputDevices: () =>
			invokeOrDefault<unknown[]>(IPC.AUDIO_REFRESH_OUTPUT_DEVICES, []),
		onAudioOutputDevicesChanged: (cb: (devices: unknown[]) => void) =>
			onTyped(
				IPC.AUDIO_OUTPUT_DEVICES_CHANGED,
				(d: { devices: unknown[] }) => d.devices,
				cb,
			),
		startMicrophoneLevelMonitor: (targets: unknown[]) =>
			invokeOrDefault<void>(
				IPC.AUDIO_START_MICROPHONE_LEVEL_MONITOR,
				undefined,
				{ targets },
			),
		stopMicrophoneLevelMonitor: () =>
			invokeOrDefault<void>(IPC.AUDIO_STOP_MICROPHONE_LEVEL_MONITOR, undefined),
		onMicrophoneLevels: (cb: (payload: unknown) => void) =>
			onCast(IPC.AUDIO_MICROPHONE_LEVELS, cb),
		gpuGetInfo: () => invokeOrDefault<unknown>(IPC.GPU_GET_INFO, null),
		getSystemLocale: () =>
			invokeOrDefault<string>(IPC.APP_GET_SYSTEM_LOCALE, ""),
		listContextApps: () =>
			invokeOrDefault<unknown[]>(IPC.CONTEXT_LIST_APPS, []),

		// App-data usage (About tab). The real exports call the generated command
		// bindings directly and throw on a backend `Result::Err` — mirror that so
		// suites stubbing `commands.*` observe the same unwrap semantics.
		appDataUsage: async () => {
			const result = (await commands.appDataUsage()) as {
				status: string;
				data?: unknown;
				error?: unknown;
			};
			if (result.status === "ok") {
				return result.data;
			}
			throw new Error(String(result.error));
		},
		removeAppDataCategory: async (key: string) => {
			const result = (await commands.removeAppDataCategory(key)) as {
				status: string;
				data?: unknown;
				error?: unknown;
			};
			if (result.status === "ok") {
				return result.data;
			}
			throw new Error(String(result.error));
		},

		// Settings
		settingsSave: (settings: unknown) => send(IPC.SETTINGS_SAVE, { settings }),
		// Acknowledged revisioned settings save. The real export calls
		// `commands.winsttPatchSettings` directly and rejects on a backend `Result::Err`. Mirror
		// that here (through the same command binding) so a suite that leaks this mock
		// in via `mock.module` still exercises the confirmed-ack path — and so tests
		// stubbing `commands.winsttPatchSettings` capture the write. Omitting this left
		// `settingsSaveAck` undefined, throwing inside `performScheduledSave` and
		// silently dropping the save whenever this mock won the global slot.
		settingsSaveAck: async (settings: unknown, baseRevision = 0) => {
			const response = unwrapCommandResult(
				(await commands.winsttPatchSettings({
					baseRevision,
					settings: settings as never,
				})) as never,
			) as {
				applied: boolean;
				changedSections: string[];
				snapshot: { revision: number; settings: unknown };
			};
			return {
				applied: response.applied,
				changedSections: response.changedSections,
				revision: response.snapshot.revision,
				settings: decodeSettingsPayload(response.snapshot.settings),
			};
		},
		// Faithful to the real module: it decodes the raw payload through
		// `decodeSettingsPayload`, which fills every section with schema
		// defaults. Returning the raw `{}` here (the old behaviour) left
		// `settings.general` undefined and crashed any component that read
		// `settings.general.*` when this leaked into a later suite.
		settingsLoad: async () =>
			decodeSettingsPayload(
				await invokeOrDefault<unknown>(IPC.SETTINGS_LOAD, {}),
			),
		settingsLoadStrict: async () =>
			decodeSettingsPayload(
				await invokeOrDefault<unknown>(IPC.SETTINGS_LOAD, {}),
			),
		settingsLoadSnapshot: async () => ({
			revision: 0,
			settings: decodeSettingsPayload(
				await invokeOrDefault<unknown>(IPC.SETTINGS_LOAD, {}),
			),
		}),
		settingsLoadSnapshotStrict: async () => {
			const snapshot = await commands.winsttGetSettingsSnapshot();
			return {
				revision: snapshot.revision,
				settings: decodeSettingsPayload(snapshot.settings),
			};
		},
		removeApplicationData: (deleteOllamaModels: boolean) =>
			invokeOrDefault<unknown>(
				IPC.SETTINGS_REMOVE_APPLICATION_DATA,
				{
					deletePortableAppDir: false,
					deletedOllamaModels: [],
					ollamaErrors: [],
					portable: false,
					scheduled: false,
				},
				{ deleteOllamaModels },
			),
		removeDownloadedModels: (deleteOllamaModels: boolean) =>
			invokeOrDefault<unknown>(
				IPC.SETTINGS_REMOVE_DOWNLOADED_MODELS,
				{
					deletedModelCaches: 0,
					deletedOllamaModels: [],
					disabledFeatures: [],
					errors: [],
					ollamaErrors: [],
				},
				{ deleteOllamaModels },
			),

		// Connection / server
		sttIsConnected: () => invokeOrDefault<boolean>(IPC.STT_IS_CONNECTED, false),

		// Window controls
		windowMinimize: () => send(IPC.WINDOW_MINIMIZE),
		windowMaximize: () => send(IPC.WINDOW_MAXIMIZE),
		windowClose: () => send(IPC.WINDOW_CLOSE),
		windowOpenSettings: () => send(IPC.WINDOW_OPEN_SETTINGS),
		settingsWindowReady: () => send(IPC.SETTINGS_WINDOW_READY),
		windowCloseSelf: () => send(IPC.WINDOW_CLOSE_SELF),
		notifyRendererReady: () => Promise.resolve(undefined),
		trayWindowOpenSettings: () => Promise.resolve(undefined),
		windowOpenContextPlayground: () => Promise.resolve(undefined),
		footprintWindowOpen: () => Promise.resolve(undefined),
		windowShowMain: () => Promise.resolve(undefined),
		windowCloseNamed: () => Promise.resolve(undefined),
		windowResizeNamed: () => Promise.resolve(undefined),
		windowQuitApp: () => Promise.resolve(undefined),
		contextPlaygroundSetLive: () => Promise.resolve(undefined),
		contextPlaygroundArmDeep: () => Promise.resolve(undefined),

		// STT event subscriptions
		onRealtimeText: (
			cb: (payload: { text: string; isFinal: boolean }) => void,
		) =>
			onTyped(
				IPC.STT_REALTIME_TEXT,
				(d: { text: string; isFinal?: boolean; is_final?: boolean }) => ({
					text: d.text,
					isFinal: d.isFinal ?? d.is_final ?? false,
				}),
				cb,
			),
		onFullSentence: (
			cb: (payload: { text: string; speaker?: number | null }) => void,
		) =>
			onTyped(
				IPC.STT_FULL_SENTENCE,
				(d: { text: string; speaker?: number | null }) => ({
					text: d.text,
					speaker: typeof d.speaker === "number" ? d.speaker : null,
				}),
				cb,
			),
		onNoAudioDetected: (cb: () => void) => on(IPC.STT_NO_AUDIO_DETECTED, cb),
		onCaptureActive: (cb: () => void) => on(IPC.STT_CAPTURE_ACTIVE, cb),
		onRecordingStart: (cb: () => void) => on(IPC.STT_RECORDING_START, cb),
		onRecordingStop: (cb: () => void) => on(IPC.STT_RECORDING_STOP, cb),
		onVadStart: (cb: () => void) => on(IPC.STT_VAD_START, cb),
		onVadStop: (cb: () => void) => on(IPC.STT_VAD_STOP, cb),
		onTranscriptionStart: (cb: (a?: string) => void) =>
			onTyped(
				IPC.STT_TRANSCRIPTION_START,
				(d: { audioBase64?: string }) => d.audioBase64,
				cb,
			),
		onConnectionChange: (cb: (c: boolean) => void) =>
			onTyped(
				IPC.STT_CONNECTION_CHANGE,
				(d: { connected: boolean }) => d.connected,
				cb,
			),
		onServerStatus: (cb: (s: string) => void) =>
			onTyped(IPC.STT_SERVER_STATUS, (d: { status: string }) => d.status, cb),

		// Hotkey event subscriptions
		onHotkeyPressed: (cb: () => void) => on(IPC.HOTKEY_PRESSED, cb),
		onHotkeyReleased: (cb: () => void) => on(IPC.HOTKEY_RELEASED, cb),
		onPttModifierOnlyUnsupported: (cb: (combo: string) => void) =>
			onCast<string>(IPC.PTT_MODIFIER_ONLY_UNSUPPORTED, cb),
		onPostProcessingProfileSwap: (cb: () => void) =>
			on(IPC.LLM_PROFILE_SWAP, () => cb()),
		onRecordingModeCycle: (cb: () => void) =>
			on(IPC.RECORDING_MODE_CYCLE, () => cb()),
		onHotkeyRecordingUpdate: (cb: (keys: string[]) => void) =>
			onTyped(
				IPC.HOTKEY_RECORDING_UPDATE,
				(d: { keys: string[] }) => d.keys,
				cb,
			),
		onHotkeyRecordingDone: (cb: (combo: string | null) => void) =>
			onTyped(
				IPC.HOTKEY_RECORDING_DONE,
				(d: { combo: string | null }) => d.combo,
				cb,
			),

		// Settings event subscriptions
		onSettingsChanged: (cb: (s: unknown) => void) =>
			onTyped(
				IPC.SETTINGS_CHANGED,
				(d: { settings: unknown }) => d.settings,
				cb,
			),
		onSettingsChangedSnapshot: (cb: (s: unknown) => void) =>
			onTyped(
				IPC.SETTINGS_CHANGED,
				(d: {
					changedSections?: string[];
					revision?: number;
					settings: unknown;
				}) => ({
					changedSections: d.changedSections ?? [],
					revision: d.revision ?? 0,
					settings: decodeSettingsPayload(d.settings),
				}),
				cb,
			),
		onSettingsSaveError: (cb: (e: string) => void) =>
			onTyped(IPC.SETTINGS_SAVE_ERROR, (d: { error: string }) => d.error, cb),

		onAudioLevel: (cb: (l: number) => void) =>
			onTyped(IPC.STT_AUDIO_LEVEL, (d: { level: number }) => d.level, cb),
		// Model download
		onModelDownloadStart: (cb: (m: string, quantization?: string) => void) =>
			on(IPC.STT_MODEL_DOWNLOAD_START, (data) => {
				const d = data as { model: string; quantization?: string };
				cb(d.model, d.quantization);
			}),
		onModelDownloadProgress: (cb: (p: unknown) => void) =>
			onCast(IPC.STT_MODEL_DOWNLOAD_PROGRESS, cb),
		onModelDownloadComplete: (
			cb: (m: string, cancelled: boolean, quantization?: string) => void,
		) =>
			on(IPC.STT_MODEL_DOWNLOAD_COMPLETE, (data) => {
				const d = data as {
					model: string;
					cancelled?: boolean;
					quantization?: string;
				};
				cb(d.model, d.cancelled ?? false, d.quantization);
			}),
		onModelDownloadPaused: (cb: (m: string, quantization?: string) => void) =>
			on(IPC.STT_MODEL_DOWNLOAD_PAUSED, (data) => {
				const d = data as { model: string; quantization?: string };
				cb(d.model, d.quantization);
			}),
		onSttModelLifecycle: (cb: (snapshot: unknown) => void) =>
			onCast(IPC.STT_MODEL_LIFECYCLE, cb),
		fetchSttModelLifecycleSnapshots: () =>
			commands.sttModelLifecycleSnapshots(),
		cancelDownload: () =>
			invokeOrDefault<void>(IPC.STT_CANCEL_DOWNLOAD, undefined),

		// Model catalog
		onModelCatalog: (cb: (m: unknown[]) => void) =>
			onTyped(
				IPC.STT_MODEL_CATALOG,
				(d: { models: unknown[] }) => d.models,
				cb,
			),
		fetchModelCatalog: () =>
			invokeOrDefault<unknown[]>(IPC.STT_GET_MODEL_CATALOG, []),

		// Runtime info
		onRuntimeInfo: (cb: (info: unknown) => void) =>
			on(IPC.STT_RUNTIME_INFO, (data) => cb(data ?? null)),
		fetchRuntimeInfo: () =>
			invokeOrDefault<unknown>(IPC.STT_GET_RUNTIME_INFO, null),

		// Model swap
		onModelSwapStarted: (cb: (i: unknown) => void) =>
			on(IPC.STT_MODEL_SWAP_STARTED, (data) => cb(data)),
		onModelSwapCompleted: (cb: (i: unknown) => void) =>
			on(IPC.STT_MODEL_SWAP_COMPLETED, (data) => cb(data)),
		onModelSwapFailed: (cb: (i: unknown) => void) =>
			on(IPC.STT_MODEL_SWAP_FAILED, (data) => cb(data)),

		// Model cache state
		fetchModelsWithState: () =>
			invokeOrDefault<unknown>(IPC.STT_LIST_MODELS_WITH_STATE, null),
		onModelCacheChanged: (cb: (id: string) => void) =>
			on(IPC.STT_MODEL_CACHE_CHANGED, (data) => {
				const d = data as { modelId?: unknown };
				if (typeof d.modelId === "string") {
					cb(d.modelId);
				}
			}),

		// Loopback
		loopbackListDevices: () =>
			invokeOrDefault<unknown[]>(IPC.LOOPBACK_LIST_DEVICES, []),
		// The REAL `loopbackStart` returns `invokeOrDefault(...)` — a Promise —
		// and callers do `loopbackStart(...).catch(...)`. Mirror the send-style
		// routing (so `start_listen` is still observed on the send seam) AND the
		// Promise return, or this fake leaks an `undefined`-returning stub that
		// makes `loopbackStart(...).catch` throw in every later test file.
		loopbackStart: (deviceIndex: number, modelId: string) => {
			send(IPC.LOOPBACK_START, { deviceIndex, modelId });
			return Promise.resolve();
		},
		loopbackStop: () => send(IPC.LOOPBACK_STOP),
		onLoopbackStarted: (cb: (n: string) => void) =>
			onTyped(
				IPC.STT_LOOPBACK_STARTED,
				(d: { deviceName: string }) => d.deviceName,
				cb,
			),
		onLoopbackStopped: (cb: () => void) => on(IPC.STT_LOOPBACK_STOPPED, cb),
		onListenSessionChanged: (cb: (snapshot: unknown) => void) =>
			onCast(IPC.LISTEN_SESSION_CHANGED, cb),
		onDeviceSwitchFailed: (cb: (p: unknown) => void) =>
			onTyped(IPC.STT_DEVICE_SWITCH_FAILED, (d: unknown) => d, cb),

		// Dialog
		dialogOpenFile: (filters?: unknown, title?: unknown) =>
			invokeOrDefault<string | null>(IPC.DIALOG_OPEN_FILE, null, {
				filters,
				title,
			}),

		// Clipboard
		clipboardReadText: async () => {
			const result = await invokeSecureOrDefault<
				{ operation: "readText"; text: string } | { operation: string }
			>(
				IPC.CLIPBOARD_OPERATE,
				{ operation: "readText" },
				{
					operation: "readText",
					text: "",
				},
			);
			return result.operation === "readText"
				? (result as { text: string }).text
				: "";
		},
		clipboardWriteText: (text: string) =>
			invokeSecureOrDefault<unknown>(
				IPC.CLIPBOARD_OPERATE,
				{ operation: "writeText", text },
				{ operation: "writeText" },
			),
		clipboardClear: () =>
			invokeSecureOrDefault<unknown>(
				IPC.CLIPBOARD_OPERATE,
				{ operation: "clear" },
				{ operation: "clear" },
			),

		// Updater
		updaterGetStatusHistory: () =>
			invokeSecureOrDefault<unknown[]>(IPC.UPDATER_GET_STATUS_HISTORY, {}, []),
		updaterClearStatusHistory: () =>
			invokeSecureOrDefault<{ cleared: true }>(
				IPC.UPDATER_CLEAR_STATUS_HISTORY,
				{},
				{
					cleared: true,
				},
			),
		onUpdaterStatus: (cb: (e: unknown) => void) =>
			onCast(IPC.UPDATER_STATUS, cb),

		// Transcription history
		fetchTranscriptionHistory: () =>
			invokeOrDefault<unknown[]>(IPC.HISTORY_GET_ALL, []),
		clearTranscriptionHistory: () =>
			invokeOrDefault<{ cleared: true }>(IPC.HISTORY_CLEAR, { cleared: true }),
		fetchTransformHistory: () =>
			invokeOrDefault<unknown[]>(IPC.TRANSFORM_HISTORY_GET_ALL, []),
		clearTransformHistory: () =>
			invokeOrDefault<{ cleared: true }>(IPC.TRANSFORM_HISTORY_CLEAR, {
				cleared: true,
			}),
		deleteTransformHistoryEntry: (id: string) =>
			invokeOrDefault<{ deleted: boolean }>(
				IPC.TRANSFORM_HISTORY_DELETE,
				{ deleted: false },
				{ id },
			),
		onTranscriptionHistoryAdded: (cb: (e: unknown) => void) =>
			onCast(IPC.HISTORY_ADDED, cb),
		onTransformHistoryAdded: (cb: (e: unknown) => void) =>
			onCast(IPC.TRANSFORM_HISTORY_ADDED, cb),
		onTransformHistoryDeleted: (cb: (p: unknown) => void) =>
			onCast(IPC.TRANSFORM_HISTORY_DELETED, cb),

		// File transcription
		onFileTranscriptionProgress: (cb: (d: unknown) => void) =>
			onCast(IPC.FILE_TRANSCRIPTION_PROGRESS, cb),
		onFileTranscriptionComplete: (cb: (d: unknown) => void) =>
			onCast(IPC.FILE_TRANSCRIPTION_COMPLETE, cb),
		onFileTranscriptionError: (cb: (d: unknown) => void) =>
			onCast(IPC.FILE_TRANSCRIPTION_ERROR, cb),

		// LLM
		fetchOllamaModels: () =>
			commandOrDefault<unknown>(
				async () => unwrapCommandResult(await commands.ollamaRefreshModels()),
				{ models: [], reachable: false, error: "IPC unavailable" },
			),
		detectOllama: () =>
			commandOrDefault<unknown>(
				async () => unwrapCommandResult(await commands.ollamaDetect()),
				{ installed: false },
			),
		startOllama: () =>
			commandOrDefault<unknown>(
				async () => unwrapCommandResult(await commands.ollamaStart()),
				{ started: false, error: "IPC unavailable" },
			),
		fetchOpenRouterModels: () =>
			commandOrDefault<unknown>(
				async () =>
					unwrapCommandResult(await commands.openrouterRefreshModels()),
				{ models: [], reachable: false, error: "IPC unavailable" },
			),
		fetchOpenRouterSttModels: () =>
			commandOrDefault<unknown>(
				async () =>
					unwrapCommandResult(await commands.openrouterRefreshSttModels()),
				{ models: [], reachable: false, error: "IPC unavailable" },
			),
		fetchOpenRouterTtsModels: () =>
			commandOrDefault<unknown>(
				async () =>
					unwrapCommandResult(await commands.openrouterRefreshTtsModels()),
				{ models: [], reachable: false, error: "IPC unavailable" },
			),
		processWithLlm: (text: string) =>
			commandOrDefault<string>(
				async () => unwrapCommandResult(await commands.processText(text, "")),
				text,
			),
		applyTransform: (transformId: string) =>
			commandOrDefault<unknown>(
				async () => unwrapCommandResult(await commands.applyTransform()),
				{ transformId, before: "", after: "", source: "empty" },
			),
		previewTransform: (text: string, _systemPrompt: string) =>
			commandOrDefault<string>(
				async () =>
					unwrapCommandResult(
						await commands.applyTransformPreview(text, "transforms", null),
					),
				text,
			),
		onPreviewReady: (cb: (payload: unknown) => void) =>
			onCast(IPC.STT_PREVIEW_READY, cb),
		confirmPaste: (text: string) =>
			commandOrDefault<void>(async () => {
				unwrapCommandResult(await commands.confirmPaste(text));
			}, undefined),
		cancelPreview: () =>
			commandOrDefault<void>(async () => {
				unwrapCommandResult(await commands.cancelPreview());
			}, undefined),
		onTransformApplied: (cb: (p: unknown) => void) =>
			onCast(IPC.TRANSFORMS_APPLIED, cb),
		onTransformFailed: (cb: (p: unknown) => void) =>
			onCast(IPC.TRANSFORMS_FAILED, cb),
		onTransformProcessingStart: (cb: () => void) =>
			on(IPC.TRANSFORMS_PROCESSING_START, cb),
		onTransformProcessingEnd: (cb: () => void) =>
			on(IPC.TRANSFORMS_PROCESSING_END, cb),
		onLlmCatalog: (cb: (m: unknown[]) => void) => {
			if (!hasBridge()) {
				return noop;
			}
			return onTyped(
				IPC.LLM_CATALOG,
				(d: { models: unknown[] }) => d.models,
				cb,
			);
		},
		pullOllamaModel: (model: string) =>
			commandOrDefault<unknown>(
				async () => unwrapCommandResult(await commands.ollamaPull(model)),
				{ success: false, model: "", error: "IPC unavailable" },
			),
		cancelOllamaModelPull: (model: string) =>
			commandOrDefault<{ cancelled: boolean }>(
				async () => unwrapCommandResult(await commands.ollamaCancelPull(model)),
				{ cancelled: false },
			),
		deleteOllamaModel: (model: string) =>
			commandOrDefault<unknown>(
				async () => unwrapCommandResult(await commands.ollamaDelete(model)),
				{ success: false, model: "", error: "IPC unavailable" },
			),
		searchOllamaLibrary: (query: string, page = 0) =>
			commandOrDefault<unknown>(
				async () =>
					unwrapCommandResult(await commands.ollamaSearchLibrary(query, page)),
				{ hits: [], hasMore: false, page, query },
			),
		fetchOllamaLibraryTags: (model: string) =>
			commandOrDefault<unknown>(
				async () =>
					unwrapCommandResult(await commands.ollamaRefreshTags(model)),
				{ model, tags: [] },
			),
		fetchOllamaModelHit: (model: string) =>
			commandOrDefault<unknown>(
				async () =>
					unwrapCommandResult(await commands.ollamaRefreshModelHit(model)),
				{ name: model },
			),
		fetchOllamaLibraryCatalog: () =>
			commandOrDefault<unknown>(
				async () => unwrapCommandResult(await commands.ollamaRefreshLibrary()),
				{ hits: [] },
			),
		onOllamaPullProgress: (cb: (p: unknown) => void) =>
			onCast(IPC.LLM_PULL_PROGRESS, cb),
		onLlmProcessingStart: (cb: () => void) => on(IPC.LLM_PROCESSING_START, cb),
		onLlmProcessingEnd: (cb: () => void) => on(IPC.LLM_PROCESSING_END, cb),
		getLlmWarmupStatus: () =>
			commandOrDefault<unknown>(
				async () => unwrapCommandResult(await commands.llmWarmupStatus()),
				null,
			),
		retryLlmWarmup: () =>
			commandOrDefault<unknown>(
				async () => unwrapCommandResult(await commands.llmRetryWarmup()),
				null,
			),
		onLlmWarmupStatus: (cb: (status: unknown) => void) =>
			onCast(IPC.LLM_WARMUP_STATUS, cb),
		onLlmUnloadStatus: (cb: (status: unknown) => void) =>
			onCast(IPC.LLM_UNLOAD_STATUS, cb),
		onLlmReasoningDelta: (cb: (payload: { delta: string }) => void) =>
			onCast(IPC.LLM_REASONING_DELTA, cb),
		onLlmLearnedProperNouns: (
			cb: (payload: { nouns: readonly string[] }) => void,
		) => onCast(IPC.LLM_LEARNED_PROPER_NOUNS, cb),
		runLlmPreview: async (
			text: string,
			feature: "dictation" | "transforms",
			config?: unknown,
		) => {
			if (!hasBridge()) {
				return text;
			}
			// Mirrors the real module: critical-reject semantics, errors propagate.
			return unwrapCommandResult(
				await commands.applyTransformPreview(
					text,
					feature,
					(config as never) ?? null,
				),
			);
		},

		// Diarization (runtime toggle + speaker segments)
		sttRequestDiarizationToggle: (enabled: boolean) =>
			send(IPC.STT_CALL_METHOD, {
				method: "request_diarization_toggle",
				args: [enabled],
			}),
		onDiarizationToggleStarted: (cb: (info: unknown) => void) =>
			onCast(IPC.STT_DIARIZATION_TOGGLE_STARTED, cb),
		onDiarizationToggleCompleted: (cb: (info: unknown) => void) =>
			onCast(IPC.STT_DIARIZATION_TOGGLE_COMPLETED, cb),
		onDiarizationToggleFailed: (cb: (info: unknown) => void) =>
			onCast(IPC.STT_DIARIZATION_TOGGLE_FAILED, cb),

		// Model cache + fitness
		nextSttSwitchRequestId: (source = "test") =>
			`${source}-${Date.now().toString(36)}`,
		requestSttModelSwitch: (
			request: Parameters<typeof commands.sttSwitchModel>[0],
		) => commands.sttSwitchModel(request),
		deleteModelCache: (modelId: string) =>
			invokeOrDefault<unknown>(IPC.STT_DELETE_MODEL_CACHE, null, { modelId }),
		deleteModelQuantization: (modelId: string, quantization: string) =>
			invokeOrDefault<unknown>(IPC.STT_DELETE_MODEL_QUANTIZATION, null, {
				modelId,
				quantization,
			}),
		predownloadModelQuant: (modelId: string, quantization: string) =>
			invokeOrDefault<unknown>(IPC.STT_PREDOWNLOAD_QUANT, null, {
				modelId,
				quantization,
			}),
		pauseModelDownload: (modelId: string, quantization: string) =>
			invokeOrDefault<unknown>(IPC.STT_DOWNLOAD_PAUSE, null, {
				modelId,
				quantization,
			}),
		resumeModelDownload: (modelId: string, quantization: string) =>
			invokeOrDefault<unknown>(IPC.STT_DOWNLOAD_RESUME, null, {
				modelId,
				quantization,
			}),
		cancelModelDownloadQuant: (modelId: string, quantization: string) =>
			invokeOrDefault<unknown>(IPC.STT_DOWNLOAD_CANCEL_QUANT, null, {
				modelId,
				quantization,
			}),
		fetchLiveResources: (forceRefresh = false) =>
			invokeOrDefault<unknown>(IPC.STT_GET_LIVE_RESOURCES, null, {
				forceRefresh,
			}),
		assessDictationFit: (
			modelId: string,
			quantization = "",
			device: string | null = null,
		) =>
			invokeOrDefault<unknown>(IPC.STT_ASSESS_DICTATION_FIT, null, {
				modelId,
				quantization,
				device,
			}),
		assessOllamaFitOnServer: (sizeBytes: number) =>
			invokeOrDefault<unknown>(IPC.STT_ASSESS_OLLAMA_FIT, null, { sizeBytes }),

		// Sound library
		soundLibraryAdd: (sourcePath: string, name?: string) =>
			invokeOrDefault<unknown>(
				IPC.SOUND_LIBRARY_ADD,
				{ ok: false, error: "IPC unavailable" },
				{ sourcePath, name },
			),
		soundLibraryPickAndAdd: (name?: string) =>
			invokeOrDefault<unknown>(
				IPC.SOUND_LIBRARY_PICK_AND_ADD,
				{ ok: false, error: "IPC unavailable" },
				{ name },
			),
		soundLibraryRemove: (filePath: string) =>
			invokeOrDefault<unknown>(
				IPC.SOUND_LIBRARY_REMOVE,
				{ ok: false, error: "IPC unavailable" },
				{ path: filePath },
			),
		soundLibraryReadFile: (filePath: string) =>
			invokeOrDefault<Uint8Array | null>(IPC.SOUND_LIBRARY_READ_FILE, null, {
				path: filePath,
			}),

		// TTS — voice catalog + lifecycle (synthesis + playback + install)
		listTtsVoices: () =>
			commandOrDefault<unknown>(() => commands.ttsListVoices(null), {
				languages: [],
				voices: [],
				unavailable: true,
			}),
		ttsDownloadEstimate: () =>
			invokeOrDefault<unknown>(IPC.TTS_DOWNLOAD_ESTIMATE, {
				unavailable: true,
			}),
		initTts: () =>
			commandOrDefault<{ ready: boolean }>(
				async () => unwrapCommandResult(await commands.ttsInit()),
				{ ready: false },
			),
		ttsSpeak: (payload: {
			text: string;
			voice?: string;
			lang?: string;
			speed?: number;
		}) =>
			commandOrDefault<{ requestId: string }>(
				async () =>
					unwrapCommandResult(
						await commands.ttsSpeak(
							payload.text,
							payload.voice ?? null,
							payload.lang ?? null,
							payload.speed ?? null,
						),
					),
				{ requestId: "" },
			),
		ttsSpeakSelection: () =>
			commandOrDefault<unknown>(
				async () =>
					unwrapCommandResult(
						await commands.ttsSpeakSelection(null, null, null, null),
					),
				{
					requestId: "",
					text: "",
					source: "empty",
				},
			),
		ttsCancel: (requestId?: string) =>
			void commandOrDefault<void>(
				() => commands.ttsCancel(requestId ?? null),
				undefined,
			),
		ttsRequestPlaybackPause: (reason = "media-session") =>
			void commandOrDefault<void>(
				() => commands.ttsPausePlayback(reason),
				undefined,
			),
		ttsRequestPlaybackResume: (reason = "media-session") =>
			void commandOrDefault<void>(
				() => commands.ttsResumePlayback(reason),
				undefined,
			),
		ttsInstallPause: () =>
			void commandOrDefault<void>(() => commands.ttsInstallPause(), undefined),
		ttsInstallResume: () =>
			void commandOrDefault<void>(async () => {
				unwrapCommandResult(await commands.ttsInstallResume());
			}, undefined),
		ttsInstallCancel: () =>
			void commandOrDefault<void>(() => commands.ttsInstallCancel(), undefined),
		ttsReportPlaybackStarted: (requestId: string) =>
			void commandOrDefault<void>(
				() => commands.ttsReportPlaybackStarted(requestId),
				undefined,
			),
		ttsReportPlaybackEnded: (requestId: string) =>
			void commandOrDefault<void>(
				() => commands.ttsReportPlaybackEnded(requestId),
				undefined,
			),
		onTtsStarted: (cb: (payload: unknown) => void) =>
			onCast(IPC.TTS_STARTED, cb),
		onTtsChunk: (cb: (payload: unknown) => void) => onCast(IPC.TTS_CHUNK, cb),
		onTtsCompleted: (cb: (payload: unknown) => void) =>
			onCast(IPC.TTS_COMPLETED, cb),
		onTtsFailed: (cb: (payload: unknown) => void) => onCast(IPC.TTS_FAILED, cb),
		onTtsPlaybackStarted: (cb: (payload: unknown) => void) =>
			onCast(IPC.TTS_PLAYBACK_STARTED, cb),
		onTtsPlaybackEnded: (cb: (payload: unknown) => void) =>
			onCast(IPC.TTS_PLAYBACK_ENDED, cb),
		onTtsPausePlayback: (cb: () => void) =>
			onCast<Record<string, never>>(IPC.TTS_PAUSE_PLAYBACK, () => cb()),
		onTtsResumePlayback: (cb: () => void) =>
			onCast<Record<string, never>>(IPC.TTS_RESUME_PLAYBACK, () => cb()),
		onTtsDiscardPlayback: (cb: () => void) =>
			onCast<Record<string, never>>(IPC.TTS_DISCARD_PLAYBACK, () => cb()),
		onTtsModelDownloadStart: (cb: () => void) =>
			onCast<Record<string, never>>(IPC.TTS_MODEL_DOWNLOAD_START, () => cb()),
		onTtsModelDownloadProgress: (cb: (payload: unknown) => void) =>
			onCast(IPC.TTS_MODEL_DOWNLOAD_PROGRESS, cb),
		onTtsModelDownloadComplete: (cb: (payload: unknown) => void) =>
			onCast(IPC.TTS_MODEL_DOWNLOAD_COMPLETE, cb),
		onTtsInstallStatus: (cb: (payload: unknown) => void) =>
			onCast(IPC.TTS_INSTALL_STATUS, cb),
		onTtsUnloadStatus: (cb: (payload: unknown) => void) =>
			onCast(IPC.TTS_UNLOAD_STATUS, cb),
		onTtsInstallFailed: (cb: (payload: unknown) => void) =>
			onCast(IPC.TTS_INSTALL_FAILED, cb),
		onTtsInstallPaused: (cb: () => void) =>
			onCast<Record<string, never>>(IPC.TTS_INSTALL_PAUSED, () => cb()),
		onTtsInstallResumed: (cb: () => void) =>
			onCast<Record<string, never>>(IPC.TTS_INSTALL_RESUMED, () => cb()),

		// Diagnostics + About
		diagOpenLogsFolder: () =>
			invokeOrDefault<unknown>(IPC.DIAG_OPEN_LOGS_FOLDER, {
				ok: false,
				error: "IPC unavailable",
			}),
		diagSaveBundle: () =>
			commandOrDefault<unknown>(commands.diagSaveBundle, {
				ok: false,
				error: "IPC unavailable",
			}),
		webviewDiagLog: (label: string, level: string, message: string) =>
			void commands.winsttDiag(label, level, message).catch(noop),
		aboutGetLicense: () =>
			commandOrDefault<string>(commands.aboutGetLicense, ""),
		aboutGetNotices: () =>
			commandOrDefault<string>(commands.aboutGetNotices, ""),
		aboutGetAppInfo: () =>
			commandOrDefault<unknown>(commands.aboutGetAppInfo, {
				copyright: "",
				frameworkVersion: "",
				webview2Version: "",
				version: "",
			}),

		// ── Transcript / history extras + overlay / abort (Tauri-port additions) ──
		copyLastTranscript: () =>
			commandOrDefault<boolean>(commands.copyLastTranscript, false),
		historyListPage: (options: { limit: number; offset: number }) =>
			invokeOrDefault<unknown>(
				IPC.HISTORY_LIST,
				{ entries: [], hasMore: false },
				options,
			),
		historyDeleteRow: (id: number) =>
			invokeOrDefault<{ deleted: boolean }>(
				IPC.HISTORY_DELETE_ROW,
				{ deleted: false },
				{ id },
			),
		historyToggleRow: (id: number) =>
			invokeOrDefault<{ saved: boolean | null }>(
				IPC.HISTORY_TOGGLE,
				{ saved: null },
				{ id },
			),
		historyLoadAudioByRow: (id: number) =>
			invokeOrDefault<string | null>(IPC.HISTORY_LOAD_AUDIO_BY_ROW, null, {
				id,
			}),
		onHistoryRowAdded: (cb: (entry: unknown) => void) =>
			onCast(IPC.HISTORY_ROW_ADDED, cb),
		onHistoryRowDeleted: (cb: (payload: unknown) => void) =>
			onCast(IPC.HISTORY_ROW_DELETED, cb),
		onHistoryRowToggled: (cb: (payload: unknown) => void) =>
			onCast(IPC.HISTORY_ROW_TOGGLED, cb),
		alignTranscriptionHistoryAudio: (id: string) =>
			commandOrDefault<unknown[]>(
				async () => unwrapCommandResult(await commands.alignWords(id)),
				[],
			),
		deleteTranscriptionHistoryEntry: (id: string) =>
			invokeOrDefault<{ deleted: boolean }>(
				IPC.HISTORY_DELETE,
				{ deleted: false },
				id,
			),
		// Faithful to the real module: these route through the typed `commands.*`
		// bindings (→ `__TAURI_INTERNALS__.invoke` with the snake_case command name),
		// NOT `window.nativeBridge`. Routing them through nativeBridge left suites
		// that instrument `__TAURI_INTERNALS__.invoke` (e.g. HistoryTable playback)
		// blind to the load whenever this mock won the global slot.
		loadTranscriptionHistoryAudio: (id: string) =>
			commandOrDefault<string | null>(
				async () => unwrapCommandResult(await commands.historyLoadAudio(id)),
				null,
			),
		loadTtsHistoryAudio: (id: string) =>
			commandOrDefault<string | null>(
				async () => unwrapCommandResult(await commands.ttsHistoryLoadAudio(id)),
				null,
			),
		onTranscriptionHistoryDeleted: (cb: (payload: { id: string }) => void) =>
			onCast<{ id: string }>(IPC.HISTORY_DELETED, cb),
		onTranscriptionFailed: (
			cb: (payload: { message?: string | null }) => void,
		) =>
			on(IPC.STT_TRANSCRIPTION_FAILED, (payload) => {
				if (payload !== null && typeof payload === "object") {
					cb(payload as { message?: string | null });
					return;
				}
				cb({});
			}),
		onSttSessionAborted: (cb: () => void) =>
			on(IPC.STT_SESSION_ABORTED, () => cb()),
		sttAbortOperation: () => send(IPC.STT_ABORT_OPERATION),
		overlaySetIgnoreMouse: (ignore: boolean) =>
			send(IPC.OVERLAY_SET_IGNORE_MOUSE, { ignore }),
		wakewordModelStatus: () =>
			commandOrDefault<unknown>(commands.wakewordModelStatus, {
				available: false,
				downloading: false,
			}),
		wakewordStartModelDownload: () =>
			commandOrDefault<unknown>(commands.wakewordStartModelDownload, {
				available: false,
				downloading: false,
			}),
		wakewordPauseModelDownload: () =>
			commandOrDefault<unknown>(commands.wakewordPauseModelDownload, {
				available: false,
				downloading: false,
			}),
		wakewordResumeModelDownload: () =>
			commandOrDefault<unknown>(commands.wakewordResumeModelDownload, {
				available: false,
				downloading: false,
			}),
		wakewordCancelModelDownload: () =>
			commandOrDefault<unknown>(commands.wakewordCancelModelDownload, {
				available: false,
				downloading: false,
			}),
		onWakewordModelStatus: (cb: (payload: unknown) => void) =>
			onCast(IPC.WAKEWORD_MODEL_STATUS, cb),
		openCustomModelsFolder: () =>
			invokeOrDefault<unknown>(IPC.CUSTOM_MODELS_OPEN_FOLDER, {
				ok: false,
				error: "IPC unavailable",
			}),

		// ── File-transcription queue ──
		fileQueueEnqueue: (files: unknown[]) =>
			invokeOrDefault<null>(IPC.FILE_QUEUE_ENQUEUE, null, { files }),
		fileQueuePickAndEnqueue: () =>
			invokeOrDefault<null>(IPC.FILE_QUEUE_PICK_AND_ENQUEUE, null),
		fileQueueCancel: (id: string) =>
			invokeOrDefault<null>(IPC.FILE_QUEUE_CANCEL, null, { id }),
		fileQueueRetry: (id: string) =>
			invokeOrDefault<null>(IPC.FILE_QUEUE_RETRY, null, { id }),
		fileQueueCopy: (id: string) =>
			invokeOrDefault<null>(IPC.FILE_QUEUE_COPY, null, { id }),
		fileQueueClear: () => invokeOrDefault<null>(IPC.FILE_QUEUE_CLEAR, null),
		fileQueuePause: (id: string) =>
			invokeOrDefault<null>(IPC.FILE_QUEUE_PAUSE, null, { id }),
		fileQueueResume: (id: string) =>
			invokeOrDefault<null>(IPC.FILE_QUEUE_RESUME, null, { id }),
		fileQueueDiscardAll: () =>
			invokeOrDefault<null>(IPC.FILE_QUEUE_DISCARD_ALL, null),
		fileQueueGetActive: () =>
			invokeOrDefault<boolean>(IPC.FILE_QUEUE_GET_ACTIVE, false),
		onFileQueueUpdate: (cb: (data: unknown) => void) =>
			onCast(IPC.FILE_QUEUE_UPDATE, cb),
		onFileQueueProgress: (cb: (data: unknown) => void) =>
			onCast(IPC.FILE_QUEUE_PROGRESS, cb),
		onFileQueueActive: (cb: (data: unknown) => void) =>
			onCast(IPC.FILE_QUEUE_ACTIVE, cb),

		// ── TTS catalog / cloud / install (Tauri-port additions) ──
		ttsSetSpeed: (speed: number) =>
			void commandOrDefault<void>(() => commands.ttsSetSpeed(speed), undefined),
		ttsListModels: () => invokeOrDefault<unknown[]>(IPC.TTS_LIST_MODELS, []),
		ttsListModelsWithState: () =>
			commandOrDefault<unknown>(() => commands.ttsListModelsWithState(), null),
		fetchTtsModelsWithState: () =>
			commandOrDefault<unknown>(() => commands.ttsListModelsWithState(), null),
		ttsPredownloadModel: (modelId: string, quantization: string) =>
			commandOrDefault<void>(
				() => commands.ttsPredownloadModel(modelId, quantization),
				undefined,
			),
		ttsDownloadPause: (modelId: string, quantization: string) =>
			commandOrDefault<void>(
				() => commands.ttsDownloadPause(modelId, quantization),
				undefined,
			),
		ttsDownloadResume: (modelId: string, quantization: string) =>
			commandOrDefault<void>(
				() => commands.ttsDownloadResume(modelId, quantization),
				undefined,
			),
		ttsDownloadCancel: (modelId: string, quantization: string) =>
			commandOrDefault<void>(
				() => commands.ttsDownloadCancel(modelId, quantization),
				undefined,
			),
		ttsDeleteModel: (modelId: string, quantization: string) =>
			commandOrDefault<void>(async () => {
				unwrapCommandResult(
					await commands.ttsDeleteModel(modelId, quantization),
				);
			}, undefined),
		ttsCloudListVoices: () =>
			commandOrDefault<unknown>(
				async () => unwrapCommandResult(await commands.ttsListCloudVoices()),
				{ voices: [], unavailable: true },
			),
		ttsCloudPreview: (payload: { previewUrl: string }) =>
			commandOrDefault<unknown>(
				async () =>
					unwrapCommandResult(
						await commands.ttsPreviewCloud(payload.previewUrl),
					),
				{ requestId: "" },
			),
		ttsOpenRouterPreview: (payload: {
			model?: string;
			voice?: string;
			speed?: number;
		}) =>
			commandOrDefault<unknown>(
				async () =>
					unwrapCommandResult(
						await commands.ttsPreviewOpenrouter(
							payload.model ?? "",
							payload.voice ?? "",
							payload.speed ?? null,
						),
					),
				{ requestId: "" },
			),
		ttsCloudSubscription: () =>
			commandOrDefault<unknown>(
				async () => unwrapCommandResult(await commands.ttsCloudSubscription()),
				{ creditsExhausted: false },
			),
		onTtsModelCacheChanged: (cb: (modelId: string) => void) =>
			on(IPC.TTS_CATALOG_MODEL_CACHE_CHANGED, (data) => {
				const d = data as { modelId?: unknown };
				if (typeof d.modelId === "string") {
					cb(d.modelId);
				}
			}),
		onTtsModelDownloadProgressCatalog: (cb: (payload: unknown) => void) =>
			onCast(IPC.TTS_CATALOG_MODEL_DOWNLOAD_PROGRESS, cb),
		onTtsModelDownloadCompleteCatalog: (
			cb: (model: string, cancelled: boolean, quantization: string) => void,
		) =>
			on(IPC.TTS_CATALOG_MODEL_DOWNLOAD_COMPLETE, (data) => {
				const d = data as {
					cancelled?: boolean;
					model: string;
					quantization: string;
				};
				cb(d.model, d.cancelled ?? false, d.quantization);
			}),

		// ── Updater (action commands) ──
		updaterCheckNow: (options?: { includePrereleaseUpdates?: boolean }) =>
			invokeOrDefault<unknown>(
				IPC.UPDATER_CHECK_NOW,
				{ triggered: false },
				options,
			),
		updaterQuitAndInstall: () =>
			invokeOrDefault<unknown>(IPC.UPDATER_QUIT_AND_INSTALL, {
				triggered: false,
			}),
	};
}
