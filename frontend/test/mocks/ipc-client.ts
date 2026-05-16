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
 * routing through `window.electronAPI`.
 *
 * The fix is a mock that is BOTH:
 *   1. **Semantically complete** — every export the real module ships is
 *      present, so no later module ever sees `undefined` for a key it
 *      imports (no "Export named X not found", no `useEffect` throwing on
 *      `onHotkeyPressed === undefined`).
 *   2. **Behavior-faithful** — every function delegates to `window.electronAPI`
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
 * import { ipcClientMock } from "@/test/mocks/ipc-client";
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
 * The real module reads `window.electronAPI` at CALL time (never at import
 * time). The test preload (`test/preload.ts`) installs a default
 * `window.electronAPI` and individual tests swap it for an instrumented one.
 * This fake mirrors that: it reads `window.electronAPI` on every call, so a
 * test that sets `window.electronAPI.invoke = ...` sees its impl honoured
 * through the fake exactly as through the real module.
 */

import { IPC } from "@/shared/api/ipc-channels";
import { decodeSettingsPayload } from "@/shared/api/settings-codec";

type ElectronApi = Window["electronAPI"] | undefined;

function api(): ElectronApi {
	return typeof window === "undefined"
		? undefined
		: (window as Window & { electronAPI?: ElectronApi }).electronAPI;
}

function isElectron(): boolean {
	return api() != null;
}

const noop = () => undefined;

type FallbackValue<T> = T | (() => T);

function resolveFallback<T>(fallback: FallbackValue<T>): T {
	return typeof fallback === "function" ? (fallback as () => T)() : fallback;
}

function send(channel: string, ...args: unknown[]): void {
	if (isElectron()) {
		api()?.send(channel, ...args);
	}
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
	if (isElectron()) {
		return (await api()?.invoke(channel, ...args)) as T;
	}
	return undefined as T;
}

async function invokeSecure<T>(channel: string, payload?: unknown): Promise<T> {
	if (isElectron()) {
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
		return api()?.on(channel, callback) ?? noop;
	}
	return noop;
}

function onTyped<T, V>(
	channel: string,
	extract: (data: T) => V,
	cb: (value: V) => void
): () => void {
	return on(channel, (data) => cb(extract(data as T)));
}

function onCast<T>(channel: string, cb: (value: T) => void): () => void {
	return on(channel, (data) => cb(data as T));
}

/**
 * Build a fresh, complete, behavior-faithful fake of the ipc-client module.
 * Every key mirrors the real export of the same name and routes through
 * `window.electronAPI` with identical channel + fallback semantics.
 */
export function ipcClientMock(): Record<string, unknown> {
	return {
		// Low-level wrappers (re-exported by the real module)
		ipcSend: send,
		ipcInvoke: invoke,
		ipcOn: on,

		getFilePath: (file: File): string => (isElectron() ? (api()?.getPathForFile(file) ?? "") : ""),

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
		hotkeyUnregister: (accelerator: string) => send(IPC.HOTKEY_UNREGISTER, { accelerator }),
		hotkeyStartRecording: () => invokeOrDefault<boolean>(IPC.HOTKEY_START_RECORDING, false),
		hotkeyStopRecording: () => send(IPC.HOTKEY_STOP_RECORDING),

		// System
		autostartSet: (enabled: boolean) => send(IPC.AUTOSTART_SET, { enabled }),
		autostartGet: () => invokeOrDefault<boolean>(IPC.AUTOSTART_GET, false),
		audioGetDevices: () => invokeOrDefault<unknown[]>(IPC.AUDIO_GET_DEVICES, []),
		gpuGetInfo: () => invokeOrDefault<unknown>(IPC.GPU_GET_INFO, null),
		getSystemLocale: () => invokeOrDefault<string>(IPC.APP_GET_SYSTEM_LOCALE, ""),

		// Settings
		settingsSave: (settings: unknown) => send(IPC.SETTINGS_SAVE, { settings }),
		// Faithful to the real module: it decodes the raw payload through
		// `decodeSettingsPayload`, which fills every section with schema
		// defaults. Returning the raw `{}` here (the old behaviour) left
		// `settings.general` undefined and crashed any component that read
		// `settings.general.*` when this leaked into a later suite.
		settingsLoad: async () =>
			decodeSettingsPayload(await invokeOrDefault<unknown>(IPC.SETTINGS_LOAD, {})),

		// Connection / server
		sttIsConnected: () => invokeOrDefault<boolean>(IPC.STT_IS_CONNECTED, false),
		sttServerSpawn: () => invoke<void>(IPC.STT_SERVER_SPAWN),
		sttServerKill: () => invoke<void>(IPC.STT_SERVER_KILL),
		sttServerStatus: () => invokeOrDefault<string>(IPC.STT_SERVER_GET_STATUS, "idle"),

		// Window controls
		windowMinimize: () => send(IPC.WINDOW_MINIMIZE),
		windowMaximize: () => send(IPC.WINDOW_MAXIMIZE),
		windowClose: () => send(IPC.WINDOW_CLOSE),
		windowOpenSettings: () => send(IPC.WINDOW_OPEN_SETTINGS),
		windowCloseSelf: () => send(IPC.WINDOW_CLOSE_SELF),

		// STT event subscriptions
		onRealtimeText: (cb: (t: string) => void) =>
			onTyped(IPC.STT_REALTIME_TEXT, (d: { text: string }) => d.text, cb),
		onFullSentence: (cb: (t: string) => void) =>
			onTyped(IPC.STT_FULL_SENTENCE, (d: { text: string }) => d.text, cb),
		onNoAudioDetected: (cb: () => void) => on(IPC.STT_NO_AUDIO_DETECTED, cb),
		onRecordingStart: (cb: () => void) => on(IPC.STT_RECORDING_START, cb),
		onRecordingStop: (cb: () => void) => on(IPC.STT_RECORDING_STOP, cb),
		onVadStart: (cb: () => void) => on(IPC.STT_VAD_START, cb),
		onVadStop: (cb: () => void) => on(IPC.STT_VAD_STOP, cb),
		onTranscriptionStart: (cb: (a?: string) => void) =>
			onTyped(IPC.STT_TRANSCRIPTION_START, (d: { audioBase64?: string }) => d.audioBase64, cb),
		onConnectionChange: (cb: (c: boolean) => void) =>
			onTyped(IPC.STT_CONNECTION_CHANGE, (d: { connected: boolean }) => d.connected, cb),
		onServerStatus: (cb: (s: string) => void) =>
			onTyped(IPC.STT_SERVER_STATUS, (d: { status: string }) => d.status, cb),

		// Hotkey event subscriptions
		onHotkeyPressed: (cb: () => void) => on(IPC.HOTKEY_PRESSED, cb),
		onHotkeyReleased: (cb: () => void) => on(IPC.HOTKEY_RELEASED, cb),
		onHotkeyRecordingUpdate: (cb: (keys: string[]) => void) =>
			onTyped(IPC.HOTKEY_RECORDING_UPDATE, (d: { keys: string[] }) => d.keys, cb),
		onHotkeyRecordingDone: (cb: (combo: string | null) => void) =>
			onTyped(IPC.HOTKEY_RECORDING_DONE, (d: { combo: string | null }) => d.combo, cb),

		// Settings event subscriptions
		onSettingsChanged: (cb: (s: unknown) => void) =>
			onTyped(IPC.SETTINGS_CHANGED, (d: { settings: unknown }) => d.settings, cb),
		onSettingsSaveError: (cb: (e: string) => void) =>
			onTyped(IPC.SETTINGS_SAVE_ERROR, (d: { error: string }) => d.error, cb),

		onAudioLevel: (cb: (l: number) => void) =>
			onTyped(IPC.STT_AUDIO_LEVEL, (d: { level: number }) => d.level, cb),

		// Model download
		onModelDownloadStart: (cb: (m: string) => void) =>
			onTyped(IPC.STT_MODEL_DOWNLOAD_START, (d: { model: string }) => d.model, cb),
		onModelDownloadProgress: (cb: (p: unknown) => void) =>
			onCast(IPC.STT_MODEL_DOWNLOAD_PROGRESS, cb),
		onModelDownloadComplete: (cb: (m: string, cancelled: boolean) => void) =>
			on(IPC.STT_MODEL_DOWNLOAD_COMPLETE, (data) => {
				const d = data as { model: string; cancelled?: boolean };
				cb(d.model, d.cancelled ?? false);
			}),
		cancelDownload: () => invokeOrDefault<void>(IPC.STT_CANCEL_DOWNLOAD, undefined),

		// Model catalog
		onModelCatalog: (cb: (m: unknown[]) => void) =>
			onTyped(IPC.STT_MODEL_CATALOG, (d: { models: unknown[] }) => d.models, cb),
		fetchModelCatalog: () => invokeOrDefault<unknown[]>(IPC.STT_GET_MODEL_CATALOG, []),

		// Runtime info
		onRuntimeInfo: (cb: (info: unknown) => void) =>
			on(IPC.STT_RUNTIME_INFO, (data) => cb(data ?? null)),
		fetchRuntimeInfo: () => invokeOrDefault<unknown>(IPC.STT_GET_RUNTIME_INFO, null),

		// Model swap
		sttReloadModel: (kind: unknown, name: unknown) => send(IPC.STT_RELOAD_MODEL, { kind, name }),
		onModelSwapStarted: (cb: (i: unknown) => void) =>
			on(IPC.STT_MODEL_SWAP_STARTED, (data) => cb(data)),
		onModelSwapCompleted: (cb: (i: unknown) => void) =>
			on(IPC.STT_MODEL_SWAP_COMPLETED, (data) => cb(data)),
		onModelSwapFailed: (cb: (i: unknown) => void) =>
			on(IPC.STT_MODEL_SWAP_FAILED, (data) => cb(data)),

		// Model cache state
		fetchModelsWithState: () => invokeOrDefault<unknown>(IPC.STT_LIST_MODELS_WITH_STATE, null),
		onModelCacheChanged: (cb: (id: string) => void) =>
			on(IPC.STT_MODEL_CACHE_CHANGED, (data) => {
				const d = data as { modelId?: unknown };
				if (typeof d.modelId === "string") {
					cb(d.modelId);
				}
			}),

		// Loopback
		loopbackListDevices: () => invokeOrDefault<unknown[]>(IPC.LOOPBACK_LIST_DEVICES, []),
		loopbackStart: (deviceIndex: number) => send(IPC.LOOPBACK_START, { deviceIndex }),
		loopbackStop: () => send(IPC.LOOPBACK_STOP),
		onLoopbackStarted: (cb: (n: string) => void) =>
			onTyped(IPC.STT_LOOPBACK_STARTED, (d: { deviceName: string }) => d.deviceName, cb),
		onLoopbackStopped: (cb: () => void) => on(IPC.STT_LOOPBACK_STOPPED, cb),
		onDeviceSwitchFailed: (cb: (p: unknown) => void) =>
			onTyped(IPC.STT_DEVICE_SWITCH_FAILED, (d: unknown) => d, cb),

		// Dialog / menus
		dialogOpenFile: (filters?: unknown, title?: unknown) =>
			invokeOrDefault<string | null>(IPC.DIALOG_OPEN_FILE, null, { filters, title }),
		appMenuSetTemplate: (template: unknown[]) =>
			invokeOrDefault<{ applied: boolean; itemCount: number }>(
				IPC.APP_MENU_SET_TEMPLATE,
				{ applied: false, itemCount: 0 },
				template
			),
		appMenuReset: () =>
			invokeOrDefault<{ applied: boolean }>(IPC.APP_MENU_RESET, { applied: false }),
		contextMenuShow: (template: unknown[], x?: number, y?: number) =>
			invokeOrDefault<{ selectedId: string | null }>(
				IPC.CONTEXT_MENU_SHOW,
				{ selectedId: null },
				{ template, x, y }
			),

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
				}
			);
			return result.operation === "readText" ? (result as { text: string }).text : "";
		},
		clipboardWriteText: (text: string) =>
			invokeSecureOrDefault<unknown>(
				IPC.CLIPBOARD_OPERATE,
				{ operation: "writeText", text },
				{ operation: "writeText" }
			),
		clipboardClear: () =>
			invokeSecureOrDefault<unknown>(
				IPC.CLIPBOARD_OPERATE,
				{ operation: "clear" },
				{ operation: "clear" }
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
				}
			),
		onUpdaterStatus: (cb: (e: unknown) => void) => onCast(IPC.UPDATER_STATUS, cb),

		// Window telemetry
		onWindowTelemetry: (cb: (p: unknown) => void) => onCast(IPC.WINDOW_TELEMETRY, cb),

		// Transcription history
		fetchTranscriptionHistory: () => invokeOrDefault<unknown[]>(IPC.HISTORY_GET_ALL, []),
		clearTranscriptionHistory: () =>
			invokeOrDefault<{ cleared: true }>(IPC.HISTORY_CLEAR, { cleared: true }),
		onTranscriptionHistoryAdded: (cb: (e: unknown) => void) => onCast(IPC.HISTORY_ADDED, cb),

		// File transcription
		fileTranscribe: (filePath: string) =>
			invokeOrDefault<{ requestId: string }>(IPC.FILE_TRANSCRIBE, { requestId: "" }, { filePath }),
		onFileTranscriptionProgress: (cb: (d: unknown) => void) =>
			onCast(IPC.FILE_TRANSCRIPTION_PROGRESS, cb),
		onFileTranscriptionComplete: (cb: (d: unknown) => void) =>
			onCast(IPC.FILE_TRANSCRIPTION_COMPLETE, cb),
		onFileTranscriptionError: (cb: (d: unknown) => void) =>
			onCast(IPC.FILE_TRANSCRIPTION_ERROR, cb),

		// LLM
		fetchOllamaModels: () =>
			invokeOrDefault<unknown>(IPC.LLM_SCAN_MODELS, {
				models: [],
				reachable: false,
				error: "IPC unavailable",
			}),
		detectOllama: () => invokeOrDefault<unknown>(IPC.LLM_DETECT_OLLAMA, { installed: false }),
		startOllama: () =>
			invokeOrDefault<unknown>(IPC.LLM_START_OLLAMA, {
				started: false,
				error: "IPC unavailable",
			}),
		fetchOpenRouterModels: () =>
			invokeOrDefault<unknown>(IPC.LLM_SCAN_OPENROUTER_MODELS, {
				models: [],
				reachable: false,
				error: "IPC unavailable",
			}),
		processWithLlm: (text: string) => invokeOrDefault<string>(IPC.LLM_PROCESS_TEXT, text, { text }),
		applyTransform: (transformId: string) =>
			invokeOrDefault<unknown>(
				IPC.TRANSFORMS_APPLY,
				{ transformId, before: "", after: "", source: "empty" },
				{ transformId }
			),
		previewTransform: (text: string, systemPrompt: string) =>
			invokeOrDefault<string>(IPC.TRANSFORMS_PREVIEW, text, { text, systemPrompt }),
		onTransformApplied: (cb: (p: unknown) => void) => onCast(IPC.TRANSFORMS_APPLIED, cb),
		onTransformFailed: (cb: (p: unknown) => void) => onCast(IPC.TRANSFORMS_FAILED, cb),
		onLlmCatalog: (cb: (m: unknown[]) => void) => {
			if (!isElectron()) {
				return noop;
			}
			return onTyped(IPC.LLM_CATALOG, (d: { models: unknown[] }) => d.models, cb);
		},
		pullOllamaModel: (model: string) =>
			invokeOrDefault<unknown>(
				IPC.LLM_PULL_MODEL,
				{ success: false, model: "", error: "IPC unavailable" },
				{ model }
			),
		cancelOllamaModelPull: (model: string) =>
			invokeOrDefault<{ cancelled: boolean }>(
				IPC.LLM_CANCEL_PULL_MODEL,
				{ cancelled: false },
				{ model }
			),
		deleteOllamaModel: (model: string) =>
			invokeOrDefault<unknown>(
				IPC.LLM_DELETE_MODEL,
				{ success: false, model: "", error: "IPC unavailable" },
				{ model }
			),
		onOllamaPullProgress: (cb: (p: unknown) => void) => onCast(IPC.LLM_PULL_PROGRESS, cb),
		onLlmProcessingStart: (cb: () => void) => on(IPC.LLM_PROCESSING_START, cb),
		onLlmProcessingEnd: (cb: () => void) => on(IPC.LLM_PROCESSING_END, cb),
	};
}
