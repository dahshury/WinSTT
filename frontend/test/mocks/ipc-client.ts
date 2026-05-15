/**
 * Default shim for `@/shared/api/ipc-client` used by tests.
 *
 * ⚠️  Cross-file pollution warning: `mock.module()` in bun:test installs a
 * process-global mock that survives into every subsequent test file —
 * including `ipc-client.test.ts` itself, which tests the REAL module.
 * Spreading this complete shim into a `mock.module(...)` call will poison
 * ipc-client.test.ts and produce ~50 failures across "send wrappers",
 * "invokeOrDefault wrappers", and "typed event subscriptions".
 *
 * Safe usage:
 *   In a test that spies on one or two specific exports, override only
 *   those — bun's mock module replaces the entire export shape, so the
 *   poisoning is the same — but provide enough exports to satisfy any
 *   modules that load between test files (the global cache is shared).
 *
 * Preferred alternative for component tests:
 *   Mock at `window.electronAPI` instead. The real ipc-client.ts inspects
 *   `window.electronAPI` at call time, so installing a per-test
 *   `window.electronAPI` (with `send`, `invoke`, `on`) lets the real ipc
 *   functions run without ever calling `mock.module`.
 *
 * Each call returns a FRESH shim — never a shared reference — so spies
 * installed in one test never leak into another.
 */
export function ipcClientMock(): Record<string, unknown> {
	const noop = () => undefined;
	const noopSubscribe = (): (() => void) => noop;
	return {
		// Send-style channels (fire-and-forget)
		ipcSend: noop,
		ipcInvoke: async () => undefined,
		ipcOn: noopSubscribe,
		// Settings
		settingsSave: noop,
		settingsLoad: async () => ({}),
		// STT commands
		sttSetParameter: noop,
		sttGetParameter: async () => null,
		sttCallMethod: noop,
		sttIsConnected: async () => false,
		sttServerSpawn: async () => undefined,
		sttServerKill: async () => undefined,
		sttServerStatus: async () => "idle",
		// Hotkey
		hotkeyRegister: async () => false,
		hotkeyUnregister: noop,
		hotkeyStartRecording: async () => false,
		hotkeyStopRecording: noop,
		// System
		autostartSet: noop,
		autostartGet: async () => false,
		audioSetMute: noop,
		audioGetDevices: async () => [],
		gpuGetInfo: async () => null,
		// Window
		windowMinimize: noop,
		windowMaximize: noop,
		windowClose: noop,
		windowOpenSettings: noop,
		windowCloseSelf: noop,
		// File transcription
		fileTranscribe: async () => ({ requestId: "" }),
		// Loopback
		loopbackListDevices: async () => [],
		loopbackStart: noop,
		loopbackStop: noop,
		// Dialog/Menu
		dialogOpenFile: async () => null,
		appMenuSetTemplate: async () => ({ applied: false, itemCount: 0 }),
		appMenuReset: async () => ({ applied: false }),
		contextMenuShow: async () => ({ selectedId: null }),
		// Clipboard
		clipboardReadText: async () => "",
		clipboardWriteText: async () => ({ operation: "writeText" }),
		clipboardClear: async () => ({ operation: "clear" }),
		// Updater
		updaterGetStatusHistory: async () => [],
		updaterClearStatusHistory: async () => ({ cleared: true }),
		// Model catalog
		fetchModelCatalog: async () => [],
		cancelDownload: async () => undefined,
		// Model swap + cache state (Phase 3-5 additions)
		fetchModelsWithState: async () => null,
		sttReloadModel: noop,
		fetchRuntimeInfo: async () => null,
		// Helpers
		getFilePath: () => "",
		// LLM
		fetchOllamaModels: async () => ({ models: [], reachable: false, error: "test" }),
		detectOllama: async () => ({ installed: false }),
		startOllama: async () => ({ started: false, error: "test" }),
		fetchOpenRouterModels: async () => ({ models: [], reachable: false, error: "test" }),
		processWithLlm: async (text: string) => text,
		// Subscriptions (return no-op unsubscribers)
		onLlmCatalog: noopSubscribe,
		onModelCatalog: noopSubscribe,
		onModelDownloadStart: noopSubscribe,
		onModelDownloadProgress: noopSubscribe,
		onModelDownloadComplete: noopSubscribe,
		onRealtimeText: noopSubscribe,
		onFullSentence: noopSubscribe,
		onNoAudioDetected: noopSubscribe,
		onRecordingStart: noopSubscribe,
		onRecordingStop: noopSubscribe,
		onVadStart: noopSubscribe,
		onVadStop: noopSubscribe,
		onTranscriptionStart: noopSubscribe,
		onConnectionChange: noopSubscribe,
		onServerStatus: noopSubscribe,
		onHotkeyPressed: noopSubscribe,
		onHotkeyReleased: noopSubscribe,
		onHotkeyRecordingUpdate: noopSubscribe,
		onHotkeyRecordingDone: noopSubscribe,
		onSettingsChanged: noopSubscribe,
		onSettingsSaveError: noopSubscribe,
		onAudioLevel: noopSubscribe,
		onLoopbackStarted: noopSubscribe,
		onLoopbackStopped: noopSubscribe,
		onFileTranscriptionProgress: noopSubscribe,
		onFileTranscriptionComplete: noopSubscribe,
		onFileTranscriptionError: noopSubscribe,
		onUpdaterStatus: noopSubscribe,
		onWindowTelemetry: noopSubscribe,
		onModelSwapStarted: noopSubscribe,
		onModelSwapCompleted: noopSubscribe,
		onModelSwapFailed: noopSubscribe,
		onModelCacheChanged: noopSubscribe,
		onRuntimeInfo: noopSubscribe,
	};
}
