export const IPC = {
	// STT events (main → renderer)
	STT_REALTIME_TEXT: "stt:realtime-text",
	STT_FULL_SENTENCE: "stt:full-sentence",
	STT_NO_AUDIO_DETECTED: "stt:no-audio-detected",
	STT_RECORDING_START: "stt:recording-start",
	STT_RECORDING_STOP: "stt:recording-stop",
	STT_VAD_START: "stt:vad-start",
	STT_VAD_STOP: "stt:vad-stop",
	STT_TRANSCRIPTION_START: "stt:transcription-start",
	STT_CONNECTION_CHANGE: "stt:connection-change",
	STT_SERVER_STATUS: "stt:server-status",
	STT_WAKEWORD_DETECTED: "stt:wakeword-detected",
	STT_WAKEWORD_DETECTION_START: "stt:wakeword-detection-start",
	STT_WAKEWORD_DETECTION_END: "stt:wakeword-detection-end",
	STT_MODEL_DOWNLOAD_START: "stt:model-download-start",
	STT_MODEL_DOWNLOAD_PROGRESS: "stt:model-download-progress",
	STT_MODEL_DOWNLOAD_COMPLETE: "stt:model-download-complete",
	STT_AUDIO_LEVEL: "stt:audio-level",
	STT_MODEL_CATALOG: "stt:model-catalog",
	STT_GET_MODEL_CATALOG: "stt:get-model-catalog",
	STT_RUNTIME_INFO: "stt:runtime-info",
	STT_GET_RUNTIME_INFO: "stt:get-runtime-info",
	STT_GET_SERVER_READY: "stt:get-server-ready",
	STT_RELOAD_MODEL: "stt:reload-model",
	STT_MODEL_SWAP_STARTED: "stt:model-swap-started",
	STT_MODEL_SWAP_COMPLETED: "stt:model-swap-completed",
	STT_MODEL_SWAP_FAILED: "stt:model-swap-failed",
	STT_LIST_MODELS_WITH_STATE: "stt:list-models-with-state",
	STT_MODEL_CACHE_CHANGED: "stt:model-cache-changed",
	STT_CANCEL_DOWNLOAD: "stt:cancel-download",
	STT_DELETE_MODEL_CACHE: "stt:delete-model-cache",
	STT_GET_LIVE_RESOURCES: "stt:get-live-resources",
	STT_ASSESS_DICTATION_FIT: "stt:assess-dictation-fit",
	STT_ASSESS_OLLAMA_FIT: "stt:assess-ollama-fit",
	STT_VAD_SENSITIVITY_ADAPTED: "stt:vad-sensitivity-adapted",
	STT_SPEAKER_SEGMENTS: "stt:speaker-segments",

	// Hotkey events (main → renderer)
	HOTKEY_PRESSED: "hotkey:pressed",
	HOTKEY_RELEASED: "hotkey:released",
	HOTKEY_RECORDING_UPDATE: "hotkey:recording-update",
	HOTKEY_RECORDING_DONE: "hotkey:recording-done",

	// STT commands (renderer → main)
	STT_SET_PARAMETER: "stt:set-parameter",
	STT_GET_PARAMETER: "stt:get-parameter",
	STT_CALL_METHOD: "stt:call-method",
	STT_IS_CONNECTED: "stt:is-connected",

	// Hotkey commands (renderer → main)
	HOTKEY_REGISTER: "hotkey:register",
	HOTKEY_UNREGISTER: "hotkey:unregister",
	HOTKEY_START_RECORDING: "hotkey:start-recording",
	HOTKEY_STOP_RECORDING: "hotkey:stop-recording",

	// System commands (renderer → main)
	AUTOSTART_SET: "autostart:set",
	AUTOSTART_GET: "autostart:get",
	AUDIO_GET_DEVICES: "audio:get-devices",
	GPU_GET_INFO: "gpu:get-info",
	APP_GET_SYSTEM_LOCALE: "app:get-system-locale",

	// Settings (renderer → main)
	SETTINGS_SAVE: "settings:save",
	SETTINGS_LOAD: "settings:load",

	// Settings (main → renderer)
	SETTINGS_CHANGED: "settings:changed",
	SETTINGS_SAVE_ERROR: "settings:save-error",

	// Server management (renderer → main)
	STT_SERVER_SPAWN: "stt-server:spawn",
	STT_SERVER_KILL: "stt-server:kill",
	STT_SERVER_GET_STATUS: "stt-server:status",

	// Window controls (renderer → main)
	WINDOW_MINIMIZE: "window:minimize",
	WINDOW_MAXIMIZE: "window:maximize",
	WINDOW_CLOSE: "window:close",
	WINDOW_OPEN_SETTINGS: "window:open-settings",
	WINDOW_CLOSE_SELF: "window:close-self",
	WINDOW_SHOW: "window:show",
	WINDOW_QUIT: "window:quit",

	// Tray menu (renderer → main)
	TRAY_MENU_CLOSE: "tray-menu:close",
	TRAY_MENU_RESIZE: "tray-menu:resize",

	// Detached model-picker window (renderer → main)
	MODEL_PICKER_OPEN: "model-picker:open",
	MODEL_PICKER_CLOSE: "model-picker:close",
	MODEL_PICKER_RESIZE: "model-picker:resize",

	// Dialog (renderer → main)
	DIALOG_OPEN_FILE: "dialog:open-file",
	APP_MENU_SET_TEMPLATE: "app-menu:set-template",
	APP_MENU_RESET: "app-menu:reset",
	CONTEXT_MENU_SHOW: "context-menu:show",
	CLIPBOARD_OPERATE: "clipboard:operate",

	// File transcription (renderer → main)
	FILE_TRANSCRIBE: "file:transcribe",

	// File transcription events (main → renderer)
	FILE_TRANSCRIPTION_PROGRESS: "file:transcription-progress",
	FILE_TRANSCRIPTION_COMPLETE: "file:transcription-complete",
	FILE_TRANSCRIPTION_ERROR: "file:transcription-error",

	// Loopback commands (renderer → main)
	LOOPBACK_LIST_DEVICES: "loopback:list-devices",
	LOOPBACK_START: "loopback:start",
	LOOPBACK_STOP: "loopback:stop",

	// Loopback events (main → renderer)
	STT_LOOPBACK_STARTED: "stt:loopback-started",
	STT_LOOPBACK_STOPPED: "stt:loopback-stopped",

	// Audio device events (main → renderer)
	STT_DEVICE_SWITCH_FAILED: "stt:device-switch-failed",

	// Sound (renderer → main invoke, main → renderer push)
	SOUND_GET_DATA: "sound:get-data",
	SOUND_PLAY: "sound:play",
	SOUND_LIBRARY_ADD: "sound:library-add",
	SOUND_LIBRARY_REMOVE: "sound:library-remove",
	SOUND_LIBRARY_READ_FILE: "sound:library-read-file",

	// LLM (renderer → main)
	LLM_SCAN_MODELS: "llm:scan-models",
	LLM_PROCESS_TEXT: "llm:process-text",
	LLM_DETECT_OLLAMA: "llm:detect-ollama",
	LLM_START_OLLAMA: "llm:start-ollama",
	LLM_SCAN_OPENROUTER_MODELS: "llm:scan-openrouter-models",
	LLM_PULL_MODEL: "llm:pull-model",
	LLM_CANCEL_PULL_MODEL: "llm:cancel-pull-model",
	LLM_DELETE_MODEL: "llm:delete-model",
	LLM_PROCESS_TEXT_CUSTOM: "llm:process-text-custom",
	LLM_SEARCH_OLLAMA_LIBRARY: "llm:search-ollama-library",
	LLM_FETCH_OLLAMA_LIBRARY: "llm:fetch-ollama-library",
	LLM_FETCH_OLLAMA_TAGS: "llm:fetch-ollama-tags",

	// Transforms (renderer → main)
	TRANSFORMS_APPLY: "transforms:apply",
	TRANSFORMS_PREVIEW: "transforms:preview",

	// Transforms events (main → renderer)
	TRANSFORMS_APPLIED: "transforms:applied",
	TRANSFORMS_FAILED: "transforms:failed",

	// TTS commands (renderer → main)
	TTS_SPEAK: "tts:speak",
	TTS_SPEAK_SELECTION: "tts:speak-selection",
	TTS_CANCEL: "tts:cancel",
	TTS_INIT: "tts:init",
	TTS_LIST_VOICES: "tts:list-voices",
	// The window that owns the Web Audio queue reports when audio actually
	// starts / finishes playing (distinct from server-side synthesis
	// dispatch / completion — there's a ~1s synthesis gap before audio).
	TTS_REPORT_PLAYBACK_STARTED: "tts:report-playback-started",
	TTS_REPORT_PLAYBACK_ENDED: "tts:report-playback-ended",

	// TTS events (main → renderer)
	TTS_STARTED: "tts:started",
	TTS_CHUNK: "tts:chunk",
	TTS_COMPLETED: "tts:completed",
	TTS_FAILED: "tts:failed",
	// Re-broadcast of the report-* channels to every window so UI in a
	// window that doesn't own the audio queue (e.g. the settings window)
	// can track when playback truly starts / stops.
	TTS_PLAYBACK_STARTED: "tts:playback-started",
	TTS_PLAYBACK_ENDED: "tts:playback-ended",
	TTS_MODEL_DOWNLOAD_START: "tts:model-download-start",
	TTS_MODEL_DOWNLOAD_PROGRESS: "tts:model-download-progress",
	TTS_MODEL_DOWNLOAD_COMPLETE: "tts:model-download-complete",

	// LLM events (main → renderer)
	LLM_CATALOG: "llm:catalog",
	LLM_PULL_PROGRESS: "llm:pull-progress",
	LLM_PROCESSING_START: "llm:processing-start",
	LLM_PROCESSING_END: "llm:processing-end",
	// Streamed reasoning chunks from /api/chat. Emitted only for models that
	// support a `thinking` field (Qwen3, deepseek-r1, etc.); silent otherwise.
	// The pill renders these behind the spinner so users can watch the model
	// reason; the final answer streams in via the same chat call but is
	// surfaced separately as `STT_FULL_SENTENCE` when the call completes.
	LLM_REASONING_DELTA: "llm:reasoning-delta",
	// Warmup status — invoke pulls the last snapshot on mount, broadcast
	// fires whenever the periodic probe in main runs. Main-side wiring is
	// still WIP; until it lands, the invoke handler is missing and the
	// renderer's `invokeOrDefault` falls back to `null` so the banner stays
	// hidden.
	LLM_GET_WARMUP_STATUS: "llm:get-warmup-status",
	LLM_WARMUP_STATUS: "llm:warmup-status",
	UPDATER_GET_STATUS_HISTORY: "updater:get-status-history",
	UPDATER_CLEAR_STATUS_HISTORY: "updater:clear-status-history",
	UPDATER_STATUS: "updater:status",
	WINDOW_TELEMETRY: "window:telemetry",
	SECURE_GET_KEY: "secure:get-key",
	SECURE_INVOKE: "secure:invoke",

	// Transcription history (renderer → main)
	HISTORY_GET_ALL: "history:get-all",
	HISTORY_CLEAR: "history:clear",

	// Transcription history (main → renderer)
	HISTORY_ADDED: "history:added",

	// Diagnostics bundle (renderer → main)
	DIAG_OPEN_LOGS_FOLDER: "diag:open-logs-folder",
	DIAG_SAVE_BUNDLE: "diag:save-bundle",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/**
 * Direction of an IPC channel relative to the renderer's preload allowlists.
 *
 *   - `send`     renderer → main, fire-and-forget (`ipcRenderer.send`)
 *   - `invoke`   renderer → main, request/response (`ipcRenderer.invoke`)
 *   - `on`       main → renderer push (`ipcRenderer.on`)
 *   - `secure`   renderer → main via the encrypted secure-IPC channel
 *
 * Channels used only between main and preload itself (e.g. SECURE_GET_KEY)
 * appear with an empty direction array — they are not exposed to the renderer.
 */
export type IpcDirection = "send" | "invoke" | "on" | "secure";

/**
 * Single source of truth for which IPC channels the renderer may use, and how.
 * The preload allowlists are derived from this map, so adding a channel here
 * automatically wires it through the preload bridge — there is no parallel
 * string-literal list to forget about.
 *
 * TypeScript enforces that every IPC channel appears here.
 */
export const IPC_DIRECTIONS: Record<IpcChannel, readonly IpcDirection[]> = {
	// STT events (main → renderer)
	[IPC.STT_REALTIME_TEXT]: ["on"],
	[IPC.STT_FULL_SENTENCE]: ["on"],
	[IPC.STT_NO_AUDIO_DETECTED]: ["on"],
	[IPC.STT_RECORDING_START]: ["on"],
	[IPC.STT_RECORDING_STOP]: ["on"],
	[IPC.STT_VAD_START]: ["on"],
	[IPC.STT_VAD_STOP]: ["on"],
	[IPC.STT_TRANSCRIPTION_START]: ["on"],
	[IPC.STT_CONNECTION_CHANGE]: ["on"],
	[IPC.STT_SERVER_STATUS]: ["on"],
	[IPC.STT_WAKEWORD_DETECTED]: ["on"],
	[IPC.STT_WAKEWORD_DETECTION_START]: ["on"],
	[IPC.STT_WAKEWORD_DETECTION_END]: ["on"],
	[IPC.STT_MODEL_DOWNLOAD_START]: ["on"],
	[IPC.STT_MODEL_DOWNLOAD_PROGRESS]: ["on"],
	[IPC.STT_MODEL_DOWNLOAD_COMPLETE]: ["on"],
	[IPC.STT_AUDIO_LEVEL]: ["on"],
	[IPC.STT_MODEL_CATALOG]: ["on"],
	[IPC.STT_RUNTIME_INFO]: ["on"],
	[IPC.STT_MODEL_SWAP_STARTED]: ["on"],
	[IPC.STT_MODEL_SWAP_COMPLETED]: ["on"],
	[IPC.STT_MODEL_SWAP_FAILED]: ["on"],
	[IPC.STT_MODEL_CACHE_CHANGED]: ["on"],

	// STT commands & queries (renderer → main)
	[IPC.STT_SET_PARAMETER]: ["send"],
	[IPC.STT_GET_PARAMETER]: ["invoke"],
	[IPC.STT_CALL_METHOD]: ["send"],
	[IPC.STT_IS_CONNECTED]: ["invoke"],
	[IPC.STT_GET_MODEL_CATALOG]: ["invoke"],
	[IPC.STT_GET_RUNTIME_INFO]: ["invoke"],
	[IPC.STT_GET_SERVER_READY]: ["invoke"],
	[IPC.STT_RELOAD_MODEL]: ["send"],
	[IPC.STT_LIST_MODELS_WITH_STATE]: ["invoke"],
	[IPC.STT_CANCEL_DOWNLOAD]: ["invoke"],
	[IPC.STT_DELETE_MODEL_CACHE]: ["invoke"],
	[IPC.STT_GET_LIVE_RESOURCES]: ["invoke"],
	[IPC.STT_ASSESS_DICTATION_FIT]: ["invoke"],
	[IPC.STT_ASSESS_OLLAMA_FIT]: ["invoke"],

	// Hotkey
	[IPC.HOTKEY_PRESSED]: ["on"],
	[IPC.HOTKEY_RELEASED]: ["on"],
	[IPC.HOTKEY_RECORDING_UPDATE]: ["on"],
	[IPC.HOTKEY_RECORDING_DONE]: ["on"],
	[IPC.HOTKEY_REGISTER]: ["invoke"],
	[IPC.HOTKEY_UNREGISTER]: ["send"],
	[IPC.HOTKEY_START_RECORDING]: ["invoke"],
	[IPC.HOTKEY_STOP_RECORDING]: ["send"],

	// System
	[IPC.AUTOSTART_SET]: ["send"],
	[IPC.AUTOSTART_GET]: ["invoke"],
	[IPC.AUDIO_GET_DEVICES]: ["invoke"],
	[IPC.GPU_GET_INFO]: ["invoke"],
	[IPC.APP_GET_SYSTEM_LOCALE]: ["invoke"],

	// Settings
	[IPC.SETTINGS_SAVE]: ["send"],
	[IPC.SETTINGS_LOAD]: ["invoke"],
	[IPC.SETTINGS_CHANGED]: ["on"],
	[IPC.SETTINGS_SAVE_ERROR]: ["on"],

	// Server management
	[IPC.STT_SERVER_SPAWN]: ["invoke"],
	[IPC.STT_SERVER_KILL]: ["invoke"],
	[IPC.STT_SERVER_GET_STATUS]: ["invoke"],

	// Window controls
	[IPC.WINDOW_MINIMIZE]: ["send"],
	[IPC.WINDOW_MAXIMIZE]: ["send"],
	[IPC.WINDOW_CLOSE]: ["send"],
	[IPC.WINDOW_OPEN_SETTINGS]: ["send"],
	[IPC.WINDOW_CLOSE_SELF]: ["send"],
	[IPC.WINDOW_SHOW]: ["send"],
	[IPC.WINDOW_QUIT]: ["send"],

	// Tray menu
	[IPC.TRAY_MENU_CLOSE]: ["send"],
	[IPC.TRAY_MENU_RESIZE]: ["send"],

	// Detached model-picker window
	[IPC.MODEL_PICKER_OPEN]: ["send"],
	[IPC.MODEL_PICKER_CLOSE]: ["send"],
	[IPC.MODEL_PICKER_RESIZE]: ["send"],

	// Dialog & menus
	[IPC.DIALOG_OPEN_FILE]: ["invoke"],
	[IPC.APP_MENU_SET_TEMPLATE]: ["invoke"],
	[IPC.APP_MENU_RESET]: ["invoke"],
	[IPC.CONTEXT_MENU_SHOW]: ["invoke"],
	[IPC.CLIPBOARD_OPERATE]: ["invoke", "secure"],

	// File transcription
	[IPC.FILE_TRANSCRIBE]: ["invoke"],
	[IPC.FILE_TRANSCRIPTION_PROGRESS]: ["on"],
	[IPC.FILE_TRANSCRIPTION_COMPLETE]: ["on"],
	[IPC.FILE_TRANSCRIPTION_ERROR]: ["on"],

	// Loopback
	[IPC.LOOPBACK_LIST_DEVICES]: ["invoke"],
	[IPC.LOOPBACK_START]: ["send"],
	[IPC.LOOPBACK_STOP]: ["send"],
	[IPC.STT_LOOPBACK_STARTED]: ["on"],
	[IPC.STT_LOOPBACK_STOPPED]: ["on"],
	[IPC.STT_DEVICE_SWITCH_FAILED]: ["on"],

	// Sound
	[IPC.SOUND_GET_DATA]: ["invoke"],
	[IPC.SOUND_PLAY]: ["on"],
	[IPC.SOUND_LIBRARY_ADD]: ["invoke"],
	[IPC.SOUND_LIBRARY_REMOVE]: ["invoke"],
	[IPC.SOUND_LIBRARY_READ_FILE]: ["invoke"],

	// LLM (renderer → main)
	[IPC.LLM_SCAN_MODELS]: ["invoke"],
	[IPC.LLM_PROCESS_TEXT]: ["invoke"],
	[IPC.LLM_DETECT_OLLAMA]: ["invoke"],
	[IPC.LLM_START_OLLAMA]: ["invoke"],
	[IPC.LLM_SCAN_OPENROUTER_MODELS]: ["invoke"],
	[IPC.LLM_PULL_MODEL]: ["invoke"],
	[IPC.LLM_CANCEL_PULL_MODEL]: ["invoke"],
	[IPC.LLM_DELETE_MODEL]: ["invoke"],
	[IPC.LLM_PROCESS_TEXT_CUSTOM]: ["invoke"],
	[IPC.LLM_SEARCH_OLLAMA_LIBRARY]: ["invoke"],
	[IPC.LLM_FETCH_OLLAMA_LIBRARY]: ["invoke"],
	[IPC.LLM_FETCH_OLLAMA_TAGS]: ["invoke"],

	// Transforms
	[IPC.TRANSFORMS_APPLY]: ["invoke"],
	[IPC.TRANSFORMS_PREVIEW]: ["invoke"],
	[IPC.TRANSFORMS_APPLIED]: ["on"],
	[IPC.TRANSFORMS_FAILED]: ["on"],

	// TTS (renderer → main)
	[IPC.TTS_SPEAK]: ["invoke"],
	[IPC.TTS_SPEAK_SELECTION]: ["invoke"],
	[IPC.TTS_CANCEL]: ["send"],
	[IPC.TTS_INIT]: ["invoke"],
	[IPC.TTS_LIST_VOICES]: ["invoke"],
	[IPC.TTS_REPORT_PLAYBACK_STARTED]: ["send"],
	[IPC.TTS_REPORT_PLAYBACK_ENDED]: ["send"],

	// TTS events (main → renderer)
	[IPC.TTS_STARTED]: ["on"],
	[IPC.TTS_CHUNK]: ["on"],
	[IPC.TTS_COMPLETED]: ["on"],
	[IPC.TTS_FAILED]: ["on"],
	[IPC.TTS_PLAYBACK_STARTED]: ["on"],
	[IPC.TTS_PLAYBACK_ENDED]: ["on"],
	[IPC.TTS_MODEL_DOWNLOAD_START]: ["on"],
	[IPC.TTS_MODEL_DOWNLOAD_PROGRESS]: ["on"],
	[IPC.TTS_MODEL_DOWNLOAD_COMPLETE]: ["on"],

	// LLM events (main → renderer)
	[IPC.LLM_CATALOG]: ["on"],
	[IPC.LLM_PULL_PROGRESS]: ["on"],
	[IPC.LLM_PROCESSING_START]: ["on"],
	[IPC.LLM_PROCESSING_END]: ["on"],
	[IPC.LLM_REASONING_DELTA]: ["on"],

	// Updater
	[IPC.UPDATER_GET_STATUS_HISTORY]: ["invoke", "secure"],
	[IPC.UPDATER_CLEAR_STATUS_HISTORY]: ["invoke", "secure"],
	[IPC.UPDATER_STATUS]: ["on"],

	// Window telemetry
	[IPC.WINDOW_TELEMETRY]: ["on"],

	// Secure-IPC plumbing — preload uses these internally, not exposed to renderer
	[IPC.SECURE_GET_KEY]: [],
	[IPC.SECURE_INVOKE]: [],

	// Transcription history
	[IPC.HISTORY_GET_ALL]: ["invoke"],
	[IPC.HISTORY_CLEAR]: ["invoke"],
	[IPC.HISTORY_ADDED]: ["on"],

	// LLM warmup status
	[IPC.LLM_GET_WARMUP_STATUS]: ["invoke"],
	[IPC.LLM_WARMUP_STATUS]: ["on"],

	// VAD calibration broadcast (server → main → renderer)
	[IPC.STT_VAD_SENSITIVITY_ADAPTED]: ["on"],

	// Speaker diarization (server → main → renderer)
	[IPC.STT_SPEAKER_SEGMENTS]: ["on"],

	// Diagnostics bundle (renderer → main)
	[IPC.DIAG_OPEN_LOGS_FOLDER]: ["invoke"],
	[IPC.DIAG_SAVE_BUNDLE]: ["invoke"],
};

/** Return every channel whose direction list includes the given direction. */
export function channelsByDirection(direction: IpcDirection): readonly IpcChannel[] {
	const out: IpcChannel[] = [];
	for (const [channel, directions] of Object.entries(IPC_DIRECTIONS) as [
		IpcChannel,
		readonly IpcDirection[],
	][]) {
		if (directions.includes(direction)) {
			out.push(channel);
		}
	}
	return out;
}
