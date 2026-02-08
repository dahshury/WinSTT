export const IPC = {
	// STT events (main → renderer)
	STT_REALTIME_TEXT: "stt:realtime-text",
	STT_FULL_SENTENCE: "stt:full-sentence",
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

	// Hotkey events (main → renderer)
	HOTKEY_PRESSED: "hotkey:pressed",
	HOTKEY_RELEASED: "hotkey:released",

	// STT commands (renderer → main)
	STT_SET_PARAMETER: "stt:set-parameter",
	STT_GET_PARAMETER: "stt:get-parameter",
	STT_CALL_METHOD: "stt:call-method",

	// Hotkey commands (renderer → main)
	HOTKEY_REGISTER: "hotkey:register",
	HOTKEY_UNREGISTER: "hotkey:unregister",

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
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
