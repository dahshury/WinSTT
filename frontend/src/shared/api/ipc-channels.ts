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
	STT_GET_SERVER_READY: "stt:get-server-ready",
	STT_CANCEL_DOWNLOAD: "stt:cancel-download",

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
	AUDIO_SET_MUTE: "audio:set-mute",
	AUDIO_GET_DEVICES: "audio:get-devices",
	GPU_GET_INFO: "gpu:get-info",

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

	// Sound (renderer → main invoke, main → renderer push)
	SOUND_GET_DATA: "sound:get-data",
	SOUND_PLAY: "sound:play",

	// LLM (renderer → main)
	LLM_SCAN_MODELS: "llm:scan-models",
	LLM_PROCESS_TEXT: "llm:process-text",
	LLM_DETECT_OLLAMA: "llm:detect-ollama",
	LLM_START_OLLAMA: "llm:start-ollama",

	// LLM events (main → renderer)
	LLM_CATALOG: "llm:catalog",
	UPDATER_GET_STATUS_HISTORY: "updater:get-status-history",
	UPDATER_CLEAR_STATUS_HISTORY: "updater:clear-status-history",
	UPDATER_STATUS: "updater:status",
	WINDOW_TELEMETRY: "window:telemetry",
	SECURE_GET_KEY: "secure:get-key",
	SECURE_INVOKE: "secure:invoke",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
