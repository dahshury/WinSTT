export const IPC = {
	// STT events (main → renderer)
	STT_REALTIME_TEXT: "stt:realtime-text",
	STT_FULL_SENTENCE: "stt:full-sentence",
	STT_NO_AUDIO_DETECTED: "stt:no-audio-detected",
	STT_TRANSCRIPTION_FAILED: "stt:transcription-failed",
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
	// WAKEWORD_*_MODEL_DOWNLOAD / GET_MODEL_STATUS commands were RETIRED — their
	// wrappers call `commands.*` directly. The model-status EVENT stays.
	WAKEWORD_MODEL_STATUS: "wakeword:model-status",
	STT_MODEL_DOWNLOAD_START: "stt:model-download-start",
	STT_MODEL_DOWNLOAD_PROGRESS: "stt:model-download-progress",
	STT_MODEL_DOWNLOAD_COMPLETE: "stt:model-download-complete",
	STT_MODEL_DOWNLOAD_PAUSED: "stt:model-download-paused",
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
	STT_DELETE_MODEL_QUANTIZATION: "stt:delete-model-quantization",
	STT_PREDOWNLOAD_QUANT: "stt:predownload-quant",
	STT_DOWNLOAD_PAUSE: "stt:download-pause",
	STT_DOWNLOAD_RESUME: "stt:download-resume",
	STT_DOWNLOAD_CANCEL_QUANT: "stt:download-cancel-quant",
	STT_GET_LIVE_RESOURCES: "stt:get-live-resources",
	STT_ASSESS_DICTATION_FIT: "stt:assess-dictation-fit",
	STT_ASSESS_OLLAMA_FIT: "stt:assess-ollama-fit",
	STT_SPEAKER_SEGMENTS: "stt:speaker-segments",
	STT_DIARIZATION_TOGGLE_STARTED: "stt:diarization-toggle-started",
	STT_DIARIZATION_TOGGLE_COMPLETED: "stt:diarization-toggle-completed",
	STT_DIARIZATION_TOGGLE_FAILED: "stt:diarization-toggle-failed",
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
	// User-initiated cancel of the in-flight dictation session. Triggered by the
	// overlay's X button (and parallel to the Escape shortcut). Routes to
	// `handleAbortOperation` which markSessionAborted + abort active Ollama
	// chats + recorder.abort + clear_audio_queue + hide overlay.
	STT_ABORT_OPERATION: "stt:abort-operation",
	// Main → renderer: a user-initiated cancel just landed. Lets the renderer
	// reset local "session is active" state (the toggle-mode `isActiveRef` in
	// usePushToTalk) so the next hotkey press starts a fresh recording instead
	// of toggling off a session the server already aborted.
	STT_SESSION_ABORTED: "stt:session-aborted",
	// Toggle whether the current overlay window accepts mouse events. The Tauri
	// overlay normally owns this from the native show/hide lifecycle; this route
	// remains for bridge parity and narrow future
	// renderer-controlled cases.
	OVERLAY_SET_IGNORE_MOUSE: "overlay:set-ignore-mouse",

	// Hotkey commands (renderer → main)
	HOTKEY_REGISTER: "hotkey:register",
	HOTKEY_UNREGISTER: "hotkey:unregister",
	HOTKEY_START_RECORDING: "hotkey:start-recording",
	HOTKEY_STOP_RECORDING: "hotkey:stop-recording",

	// System commands (renderer → main)
	AUTOSTART_SET: "autostart:set",
	AUTOSTART_GET: "autostart:get",
	AUDIO_GET_DEVICES: "audio:get-devices",
	AUDIO_REFRESH_DEVICES: "audio:refresh-devices",
	AUDIO_GET_OUTPUT_DEVICES: "audio:get-output-devices",
	AUDIO_REFRESH_OUTPUT_DEVICES: "audio:refresh-output-devices",
	AUDIO_SET_SELECTED_MICROPHONE: "audio:set-selected-microphone",
	AUDIO_START_MICROPHONE_LEVEL_MONITOR: "audio:start-microphone-level-monitor",
	AUDIO_STOP_MICROPHONE_LEVEL_MONITOR: "audio:stop-microphone-level-monitor",
	GPU_GET_INFO: "gpu:get-info",
	APP_GET_SYSTEM_LOCALE: "app:get-system-locale",
	CONTEXT_LIST_APPS: "context:list-apps",

	// Settings (renderer → main)
	SETTINGS_SAVE: "settings:save",
	SETTINGS_LOAD: "settings:load",
	SETTINGS_REMOVE_APPLICATION_DATA: "settings:remove-application-data",
	SETTINGS_REMOVE_DOWNLOADED_MODELS: "settings:remove-downloaded-models",

	// Settings (main → renderer)
	SETTINGS_CHANGED: "settings:changed",
	SETTINGS_SAVE_ERROR: "settings:save-error",

	// Window controls (renderer → main)
	WINDOW_MINIMIZE: "window:minimize",
	WINDOW_MAXIMIZE: "window:maximize",
	WINDOW_CLOSE: "window:close",
	WINDOW_OPEN_SETTINGS: "window:open-settings",
	SETTINGS_WINDOW_READY: "settings:window-ready",
	WINDOW_CLOSE_SELF: "window:close-self",
	WINDOW_SHOW: "window:show",
	WINDOW_QUIT: "window:quit",

	// Tray-menu close/resize and the detached device-picker open/close/resize are
	// handled by the typed `windowCloseNamed`/`windowResizeNamed` wrappers
	// (`commands.closeWindow`/`resizeWindow`), so they have no string channel here.

	// Detached model-picker window: OPEN/CLOSE/RESIZE are typed in
	// COMMAND_INVOKERS (call `open_window`/`close_window`/`resize_window`); only
	// the two placement events below are still string channels.
	MODEL_PICKER_OPEN: "model-picker:open",
	MODEL_PICKER_CLOSE: "model-picker:close",
	MODEL_PICKER_RESIZE: "model-picker:resize",
	// Main → renderer: where to place the panel inside the full-screen
	// backdrop window (window-local CSS px). Everything else in the window
	// is a transparent click-to-dismiss backdrop.
	MODEL_PICKER_ANCHOR: "model-picker:anchor",
	// Main → renderer: close animation should start; Rust hides the window
	// after the dropdown close duration.
	MODEL_PICKER_CLOSING: "model-picker:closing",

	// Context-awareness playground (DEBUG-ONLY — gated by
	// `shared/config/debug-flags.ts` CONTEXT_PLAYGROUND_ENABLED; never wired
	// when the flag is off, so end users never see these channels).
	// The OPEN/CLOSE/SET_LIVE/ARM_DEEP commands are issued via the typed
	// `windowOpenContextPlayground`/`windowCloseNamed`/`contextPlaygroundSetLive`/
	// `contextPlaygroundArmDeep` wrappers (`commands.*`), so only the push REPORT
	// channel remains. REPORT: main → renderer, push a capture report (or a
	// "waiting" heartbeat).
	CONTEXT_PLAYGROUND_REPORT: "context-playground:report",

	// First-run onboarding wizard (renderer → main).
	// The wizard owns a dedicated BrowserWindow opened before the main window
	// when `general.onboarded` is false. ONBOARDING_FINISH closes the window,
	// flips `general.onboarded` to true (with an `onboardedAt` timestamp and
	// the chosen track), and triggers the main-window boot path. Payload:
	//   { completed: boolean, track?: "" | "local" | "cloud" }
	// `completed=true` ⇒ user walked through to the end; `false` ⇒ user hit
	// "Skip" or closed the window. Either way the wizard never re-appears.
	ONBOARDING_FINISH: "onboarding:finish",

	// Dialog (renderer → main)
	DIALOG_OPEN_FILE: "dialog:open-file",
	CLIPBOARD_OPERATE: "clipboard:operate",

	// File transcription events (main → renderer)
	FILE_TRANSCRIPTION_PROGRESS: "file:transcription-progress",
	FILE_TRANSCRIPTION_COMPLETE: "file:transcription-complete",
	FILE_TRANSCRIPTION_ERROR: "file:transcription-error",

	// Multi-file transcription queue (renderer → main)
	FILE_QUEUE_ENQUEUE: "file:queue-enqueue",
	FILE_QUEUE_PICK_AND_ENQUEUE: "file:queue-pick-and-enqueue",
	FILE_QUEUE_CANCEL: "file:queue-cancel",
	FILE_QUEUE_RETRY: "file:queue-retry",
	FILE_QUEUE_COPY: "file:queue-copy",
	FILE_QUEUE_CLEAR: "file:queue-clear",
	FILE_QUEUE_PAUSE: "file:queue-pause",
	FILE_QUEUE_RESUME: "file:queue-resume",
	FILE_QUEUE_DISCARD_ALL: "file:queue-discard-all",
	FILE_QUEUE_GET_ACTIVE: "file:queue-get-active",

	// Multi-file transcription queue events (main → renderer)
	FILE_QUEUE_UPDATE: "file:queue-update",
	FILE_QUEUE_PROGRESS: "file:queue-progress",
	FILE_QUEUE_ACTIVE: "file:queue-active",

	// Loopback commands (renderer → main)
	LOOPBACK_LIST_DEVICES: "loopback:list-devices",
	LOOPBACK_START: "loopback:start",
	LOOPBACK_STOP: "loopback:stop",

	// Loopback events (main → renderer)
	STT_LOOPBACK_STARTED: "stt:loopback-started",
	STT_LOOPBACK_STOPPED: "stt:loopback-stopped",

	// Audio device events (main → renderer)
	AUDIO_DEVICES_CHANGED: "audio:devices-changed",
	AUDIO_DEVICECHANGE_DETECTED: "audio:devicechange-detected",
	AUDIO_OUTPUT_DEVICES_CHANGED: "audio:output-devices-changed",
	AUDIO_MICROPHONE_LEVELS: "audio:microphone-levels",
	STT_DEVICE_SWITCH_FAILED: "stt:device-switch-failed",

	// Clamshell lid events (main → renderer) — informational. The actual
	// mic-swap is owned by the main-process detector; renderers can subscribe
	// to surface a "switched to clamshell mic" toast or update overlay state.
	LID_CLOSED: "lid:closed",
	LID_OPENED: "lid:opened",

	// Sound (renderer → main invoke, main → renderer push)
	SOUND_PLAY: "sound:play",
	SOUND_LIBRARY_ADD: "sound:library-add",
	SOUND_LIBRARY_PICK_AND_ADD: "sound:library-pick-and-add",
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
	LLM_FETCH_OLLAMA_LIBRARY: "llm:fetch-ollama-library",
	LLM_FETCH_OLLAMA_TAGS: "llm:fetch-ollama-tags",

	// Integrations / cloud STT credential verification (`verify_credential`) is
	// issued via the typed `verifyCredentialCommand` wrapper
	// (features/verify-credentials → `commands.verifyCredential`), so it has no
	// string channel here. set/remove still flow through the SETTINGS_SAVE pipe
	// (apiKey is a normal settings field, encrypted at rest).

	// Cloud STT model discovery (renderer → main): list OpenRouter transcription
	// models (output_modalities=transcription) for the cloud picker. Uses the
	// shared OpenRouter LLM key.
	STT_SCAN_OPENROUTER_MODELS: "stt:scan-openrouter-models",
	// Cloud TTS model discovery: list OpenRouter speech models
	// (output_modalities=speech). Same shared OpenRouter key.
	TTS_SCAN_OPENROUTER_MODELS: "tts:scan-openrouter-models",

	// Cloud STT error events (main → renderer) — fired by stt-cloud.ts
	// when an AI SDK transcribe() call fails. Each maps to a distinct
	// toast in the renderer via the verify-credentials feature.
	STT_CLOUD_AUTH_FAILED: "stt:cloud-auth-failed",
	STT_CLOUD_NETWORK_ERROR: "stt:cloud-network-error",
	STT_CLOUD_KEY_MISSING: "stt:cloud-key-missing",
	STT_CLOUD_RATE_LIMITED: "stt:cloud-rate-limited",
	STT_CLOUD_PROVIDER_ERROR: "stt:cloud-provider-error",
	CLOUD_CONNECTIVITY: "cloud:connectivity",

	// Transforms (renderer → main)
	TRANSFORMS_APPLY: "transforms:apply",
	TRANSFORMS_PREVIEW: "transforms:preview",

	// Transforms events (main → renderer)
	TRANSFORMS_APPLIED: "transforms:applied",
	TRANSFORMS_FAILED: "transforms:failed",
	TRANSFORMS_PROCESSING_START: "transforms:processing-start",
	TRANSFORMS_PROCESSING_END: "transforms:processing-end",

	// Transform history (renderer ↔ main) — persisted with the same retention
	// settings as transcription history but rendered as a separate History tab
	// section.
	TRANSFORM_HISTORY_GET_ALL: "transform-history:get-all",
	TRANSFORM_HISTORY_CLEAR: "transform-history:clear",
	TRANSFORM_HISTORY_DELETE: "transform-history:delete",
	TRANSFORM_HISTORY_ADDED: "transform-history:added",
	TRANSFORM_HISTORY_DELETED: "transform-history:deleted",

	// Preview-before-pasting (renderer → main)
	PREVIEW_CONFIRM_PASTE: "preview:confirm-paste",
	PREVIEW_CANCEL: "preview:cancel",
	// Preview-before-pasting event (main → renderer): the finalized transcript is
	// held back from auto-paste; carries `{ original, text }` for the editable pill.
	STT_PREVIEW_READY: "stt:preview-ready",

	// TTS commands (renderer → main)
	TTS_SPEAK: "tts:speak",
	TTS_CANCEL: "tts:cancel",
	// Set the read-aloud speed from the pill's speed control. Applies to the
	// active read's UPCOMING sentences (next-sentence, natural pitch) and persists
	// to the active source's speed setting.
	TTS_SET_SPEED: "tts:set-speed",
	// Renderer -> backend requests used by Media Session handlers for OS media
	// keys. Rust rebroadcasts the matching `tts:*playback` event below.
	TTS_REQUEST_PLAYBACK_PAUSE: "tts:request-playback-pause",
	TTS_REQUEST_PLAYBACK_RESUME: "tts:request-playback-resume",
	TTS_INIT: "tts:init",
	TTS_LIST_VOICES: "tts:list-voices",
	// Cloud (ElevenLabs) voice catalog — GET /v2/voices. Mirrors
	// TTS_LIST_VOICES but for the cloud source; synthesis still reuses
	// the existing TTS_SPEAK / TTS_CHUNK / TTS_COMPLETED contract.
	TTS_CLOUD_LIST_VOICES: "tts:cloud-list-voices",
	// Play a cloud voice's FREE pre-generated sample (`preview_url` from
	// /v2/voices) through the playback pipeline. Main fetches the CDN mp3 — the
	// renderer can't (CSP blocks external hosts) — so browsing voices costs no
	// ElevenLabs character credits (unlike a real synthesis).
	TTS_CLOUD_PREVIEW: "tts:cloud-preview",
	// Retired from string-channel routing; the wrapper calls the generated
	// `tts_preview_openrouter` binding directly.
	TTS_OPENROUTER_PREVIEW: "tts:openrouter-preview",
	// Read the ElevenLabs key's subscription tier (GET /v1/user/subscription) so
	// the picker can hide cloned/professional voices on a free plan (they 402 on
	// synthesis). Returns `{ tier: null }` when the key lacks user-read scope.
	TTS_CLOUD_SUBSCRIPTION: "tts:cloud-subscription",
	// Side-effect-free probe: what enabling TTS will download (engine pack +
	// model + voices). Drives the confirm dialog; never triggers a download.
	TTS_DOWNLOAD_ESTIMATE: "tts:download-estimate",
	// Install-lifecycle controls (renderer → main). Pause preserves the
	// partial file for resume; cancel discards every partial. Distinct from
	// TTS_CANCEL (which scopes to a single in-flight synthesis).
	TTS_INSTALL_PAUSE: "tts:install-pause",
	TTS_INSTALL_RESUME: "tts:install-resume",
	TTS_INSTALL_CANCEL: "tts:install-cancel",
	// The window that owns the Web Audio queue reports when audio actually
	// starts / finishes playing (distinct from server-side synthesis
	// dispatch / completion — there's a ~1s synthesis gap before audio).
	TTS_REPORT_PLAYBACK_STARTED: "tts:report-playback-started",
	TTS_REPORT_PLAYBACK_ENDED: "tts:report-playback-ended",

	// Multi-provider TTS catalog (renderer → main): model-aware picker.
	TTS_LIST_MODELS: "tts:list-models",
	TTS_LIST_MODELS_WITH_STATE: "tts:list-models-with-state",
	TTS_PREDOWNLOAD: "tts:predownload",
	TTS_DOWNLOAD_PAUSE: "tts:download-pause",
	TTS_DOWNLOAD_RESUME: "tts:download-resume",
	TTS_DOWNLOAD_CANCEL: "tts:download-cancel",
	TTS_DELETE_MODEL: "tts:delete-model",

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
	// Main asks the overlay-owned Web Audio queue to pause playback without
	// cancelling the active TTS request (used when dictation starts and when
	// renderer Media Session handlers report OS media-key pause to the backend).
	TTS_PAUSE_PLAYBACK: "tts:pause-playback",
	// Backend asks the overlay-owned Web Audio queue to resume playback without
	// starting a new TTS request (used when OS media-key play/resume reaches the
	// renderer's Media Session handler and is round-tripped through Rust).
	TTS_RESUME_PLAYBACK: "tts:resume-playback",
	// Main asks the overlay-owned Web Audio queue to discard playback entirely
	// (used by Escape after any foreground dictation layer has been cancelled).
	TTS_DISCARD_PLAYBACK: "tts:discard-playback",
	TTS_MODEL_DOWNLOAD_START: "tts:model-download-start",
	TTS_MODEL_DOWNLOAD_PROGRESS: "tts:model-download-progress",
	TTS_MODEL_DOWNLOAD_COMPLETE: "tts:model-download-complete",
	// Install-phase ping (engine pack → voice model → ready) so the
	// progress UI can label which part of the on-demand install is running.
	TTS_INSTALL_STATUS: "tts:install-status",
	// Eager warm-up failed (engine pack download / ONNX session load went
	// south). Distinct from TTS_FAILED, which is per-utterance. Drives the
	// install-error banner in the Settings → TTS section.
	TTS_INSTALL_FAILED: "tts:install-failed",
	// Confirmation that the downloader actually paused / resumed after the
	// renderer sent a pause/resume command. Drives the bar's "paused"
	// styling and re-enables the Pause button after Resume.
	TTS_INSTALL_PAUSED: "tts:install-paused",
	TTS_INSTALL_RESUMED: "tts:install-resumed",

	// Multi-provider TTS catalog download events (main → renderer). Distinct
	// wire strings from the legacy single-install TTS_MODEL_DOWNLOAD_* above
	// (which carry no model/quantization) so the catalog picker updates the
	// right per-model badge. PROGRESS { model, quantization, progress,
	// downloadedBytes, totalBytes }; COMPLETE { model, quantization, cancelled };
	// CACHE_CHANGED { modelId }.
	TTS_CATALOG_MODEL_DOWNLOAD_PROGRESS: "tts:catalog-model-download-progress",
	TTS_CATALOG_MODEL_DOWNLOAD_COMPLETE: "tts:catalog-model-download-complete",
	TTS_CATALOG_MODEL_CACHE_CHANGED: "tts:model-cache-changed",

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
	// Proper nouns the cleanup model identified in the user's dictation
	// during the last successful structured-output call. Emitted as a
	// single event with `{ nouns: string[] }`. Consumed by the
	// dictionary auto-add UI which surfaces each noun as an
	// Accept/Decline pill. Skipped if the array is empty.
	LLM_LEARNED_PROPER_NOUNS: "llm:learned-proper-nouns",
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
	// Manual "check for updates" trigger (renderer → main). Fire-and-success;
	// the real outcome arrives asynchronously over UPDATER_STATUS like the
	// periodic check. See setupUpdaterStatusHandlers.
	UPDATER_CHECK_NOW: "updater:check-now",
	// Restart the app to apply a downloaded update (renderer → main). Calls
	// the updater's `quitAndInstall`. The renderer wires this to the
	// "Restart to install" button shown once status === "downloaded".
	UPDATER_QUIT_AND_INSTALL: "updater:quit-and-install",
	SECURE_GET_KEY: "secure:get-key",
	SECURE_INVOKE: "secure:invoke",

	// Transcription history (renderer → main) — persisted store backed.
	// Layered alongside the SQLite history (`history:*` channels below);
	// not deleted yet because the settings panel still reads from it.
	HISTORY_GET_ALL: "history:get-all",
	HISTORY_CLEAR: "history:clear",
	// Delete a single entry by id. Also unlinks the associated WAV (if
	// `audioFilePath` was set) so disk usage drops in sync with the UI.
	HISTORY_DELETE: "history:delete",
	// Lazy-load the WAV bytes for an entry so the renderer can play it
	// without granting raw filesystem access. Resolves to a base64 dataURI
	// the <audio> element can consume directly.
	HISTORY_LOAD_AUDIO: "history:load-audio",

	// Lazily align an entry's WAV to per-word timestamps (server-side
	// timestamped-Whisper DTW) so playback can highlight words as they're heard.
	HISTORY_ALIGN_AUDIO: "history:align-audio",

	// Transcription history (main → renderer)
	HISTORY_ADDED: "history:added",
	// Broadcast when a single entry is deleted (per-row) so other windows
	// listing history (settings panel, future overlay history list) trim
	// their local cache without a full reload.
	HISTORY_DELETED: "history:deleted",

	// SQLite-backed transcription history (renderer → main).
	// Owns the `{userData}/history.db` rusqlite-equivalent table and the
	// `{userData}/recordings/` WAV files. Pagination + retention live here;
	// the legacy persisted store history above is kept until callers migrate.
	HISTORY_LIST: "history:list",
	HISTORY_DELETE_ROW: "history:delete-row",
	HISTORY_TOGGLE: "history:toggle",
	HISTORY_LOAD_AUDIO_BY_ROW: "history:load-audio-by-row",

	// SQLite history broadcasts (main → renderer)
	HISTORY_ROW_ADDED: "history:row-added",
	HISTORY_ROW_DELETED: "history:row-deleted",
	HISTORY_ROW_TOGGLED: "history:row-toggled",

	// Diagnostics — logs-folder opener (plugin route; the save-bundle / webview-log
	// channels were retired in favor of direct `commands.*` calls).
	DIAG_OPEN_LOGS_FOLDER: "diag:open-logs-folder",

	// Custom-models management (renderer → main)
	CUSTOM_MODELS_OPEN_FOLDER: "custom-models:open-folder",
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
	[IPC.STT_TRANSCRIPTION_FAILED]: ["on"],
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
	[IPC.WAKEWORD_MODEL_STATUS]: ["on"],
	[IPC.STT_MODEL_DOWNLOAD_START]: ["on"],
	[IPC.STT_MODEL_DOWNLOAD_PROGRESS]: ["on"],
	[IPC.STT_MODEL_DOWNLOAD_COMPLETE]: ["on"],
	[IPC.STT_MODEL_DOWNLOAD_PAUSED]: ["on"],
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
	[IPC.STT_ABORT_OPERATION]: ["send"],
	[IPC.STT_SESSION_ABORTED]: ["on"],
	[IPC.OVERLAY_SET_IGNORE_MOUSE]: ["send"],
	[IPC.STT_GET_MODEL_CATALOG]: ["invoke"],
	[IPC.STT_GET_RUNTIME_INFO]: ["invoke"],
	[IPC.STT_GET_SERVER_READY]: ["invoke"],
	[IPC.STT_RELOAD_MODEL]: ["send"],
	[IPC.STT_LIST_MODELS_WITH_STATE]: ["invoke"],
	[IPC.STT_CANCEL_DOWNLOAD]: ["invoke"],
	[IPC.STT_DELETE_MODEL_CACHE]: ["invoke"],
	[IPC.STT_DELETE_MODEL_QUANTIZATION]: ["invoke"],
	[IPC.STT_PREDOWNLOAD_QUANT]: ["invoke"],
	[IPC.STT_DOWNLOAD_PAUSE]: ["invoke"],
	[IPC.STT_DOWNLOAD_RESUME]: ["invoke"],
	[IPC.STT_DOWNLOAD_CANCEL_QUANT]: ["invoke"],
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
	[IPC.AUDIO_REFRESH_DEVICES]: ["invoke"],
	[IPC.AUDIO_GET_OUTPUT_DEVICES]: ["invoke"],
	[IPC.AUDIO_REFRESH_OUTPUT_DEVICES]: ["invoke"],
	[IPC.AUDIO_SET_SELECTED_MICROPHONE]: ["invoke"],
	[IPC.AUDIO_START_MICROPHONE_LEVEL_MONITOR]: ["invoke"],
	[IPC.AUDIO_STOP_MICROPHONE_LEVEL_MONITOR]: ["invoke"],
	[IPC.GPU_GET_INFO]: ["invoke"],
	[IPC.APP_GET_SYSTEM_LOCALE]: ["invoke"],
	[IPC.CONTEXT_LIST_APPS]: ["invoke"],

	// Settings
	[IPC.SETTINGS_SAVE]: ["send"],
	[IPC.SETTINGS_LOAD]: ["invoke"],
	[IPC.SETTINGS_CHANGED]: ["on"],
	[IPC.SETTINGS_SAVE_ERROR]: ["on"],

	// Window controls
	[IPC.WINDOW_MINIMIZE]: ["send"],
	[IPC.WINDOW_MAXIMIZE]: ["send"],
	[IPC.WINDOW_CLOSE]: ["send"],
	[IPC.WINDOW_OPEN_SETTINGS]: ["send"],
	[IPC.SETTINGS_WINDOW_READY]: ["send"],
	[IPC.WINDOW_CLOSE_SELF]: ["send"],
	[IPC.WINDOW_SHOW]: ["send"],
	[IPC.WINDOW_QUIT]: ["send"],

	// Detached model-picker window (OPEN/CLOSE/RESIZE are typed commands now;
	// only the two placement events carry a bridge direction).
	[IPC.MODEL_PICKER_OPEN]: ["send"],
	[IPC.MODEL_PICKER_CLOSE]: ["send"],
	[IPC.MODEL_PICKER_RESIZE]: ["send"],
	[IPC.MODEL_PICKER_ANCHOR]: ["on"],
	[IPC.MODEL_PICKER_CLOSING]: ["on"],

	// Context-awareness playground (debug-only) — only the push REPORT event
	// remains; the command channels are issued via typed `commands.*` wrappers.
	[IPC.CONTEXT_PLAYGROUND_REPORT]: ["on"],

	// First-run onboarding
	[IPC.ONBOARDING_FINISH]: ["send"],

	// Dialog & menus
	[IPC.DIALOG_OPEN_FILE]: ["invoke"],
	[IPC.CLIPBOARD_OPERATE]: ["invoke", "secure"],

	// File transcription
	[IPC.FILE_TRANSCRIPTION_PROGRESS]: ["on"],
	[IPC.FILE_TRANSCRIPTION_COMPLETE]: ["on"],
	[IPC.FILE_TRANSCRIPTION_ERROR]: ["on"],

	// Multi-file transcription queue
	[IPC.FILE_QUEUE_ENQUEUE]: ["invoke"],
	[IPC.FILE_QUEUE_PICK_AND_ENQUEUE]: ["invoke"],
	[IPC.FILE_QUEUE_CANCEL]: ["invoke"],
	[IPC.FILE_QUEUE_RETRY]: ["invoke"],
	[IPC.FILE_QUEUE_COPY]: ["invoke"],
	[IPC.FILE_QUEUE_CLEAR]: ["invoke"],
	[IPC.FILE_QUEUE_PAUSE]: ["invoke"],
	[IPC.FILE_QUEUE_RESUME]: ["invoke"],
	[IPC.FILE_QUEUE_DISCARD_ALL]: ["invoke"],
	[IPC.FILE_QUEUE_GET_ACTIVE]: ["invoke"],
	[IPC.FILE_QUEUE_UPDATE]: ["on"],
	[IPC.FILE_QUEUE_PROGRESS]: ["on"],
	[IPC.FILE_QUEUE_ACTIVE]: ["on"],

	// Loopback
	[IPC.LOOPBACK_LIST_DEVICES]: ["invoke"],
	[IPC.LOOPBACK_START]: ["send"],
	[IPC.LOOPBACK_STOP]: ["send"],
	[IPC.STT_LOOPBACK_STARTED]: ["on"],
	[IPC.STT_LOOPBACK_STOPPED]: ["on"],
	[IPC.AUDIO_DEVICES_CHANGED]: ["on"],
	[IPC.AUDIO_DEVICECHANGE_DETECTED]: ["on"],
	[IPC.AUDIO_OUTPUT_DEVICES_CHANGED]: ["on"],
	[IPC.AUDIO_MICROPHONE_LEVELS]: ["on"],
	[IPC.STT_DEVICE_SWITCH_FAILED]: ["on"],

	// Clamshell lid events (informational broadcasts)
	[IPC.LID_CLOSED]: ["on"],
	[IPC.LID_OPENED]: ["on"],

	// Sound
	[IPC.SOUND_PLAY]: ["on"],
	[IPC.SOUND_LIBRARY_ADD]: ["invoke"],
	[IPC.SOUND_LIBRARY_PICK_AND_ADD]: ["invoke"],
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
	[IPC.LLM_FETCH_OLLAMA_LIBRARY]: ["invoke"],
	[IPC.LLM_FETCH_OLLAMA_TAGS]: ["invoke"],

	// Cloud STT / TTS OpenRouter model discovery (credential VERIFY now goes
	// through the typed `verifyCredentialCommand` wrapper — no channel here).
	[IPC.STT_SCAN_OPENROUTER_MODELS]: ["invoke"],
	[IPC.TTS_SCAN_OPENROUTER_MODELS]: ["invoke"],

	// Cloud STT error events (main → renderer)
	[IPC.STT_CLOUD_AUTH_FAILED]: ["on"],
	[IPC.STT_CLOUD_NETWORK_ERROR]: ["on"],
	[IPC.STT_CLOUD_KEY_MISSING]: ["on"],
	[IPC.STT_CLOUD_RATE_LIMITED]: ["on"],
	[IPC.STT_CLOUD_PROVIDER_ERROR]: ["on"],
	[IPC.CLOUD_CONNECTIVITY]: ["on"],

	// Transforms
	[IPC.TRANSFORMS_APPLY]: ["invoke"],
	[IPC.TRANSFORMS_PREVIEW]: ["invoke"],
	[IPC.TRANSFORMS_APPLIED]: ["on"],
	[IPC.TRANSFORMS_FAILED]: ["on"],
	[IPC.TRANSFORMS_PROCESSING_START]: ["on"],
	[IPC.TRANSFORMS_PROCESSING_END]: ["on"],
	[IPC.TRANSFORM_HISTORY_GET_ALL]: ["invoke"],
	[IPC.TRANSFORM_HISTORY_CLEAR]: ["invoke"],
	[IPC.TRANSFORM_HISTORY_DELETE]: ["invoke"],
	[IPC.TRANSFORM_HISTORY_ADDED]: ["on"],
	[IPC.TRANSFORM_HISTORY_DELETED]: ["on"],

	// Preview-before-pasting
	[IPC.PREVIEW_CONFIRM_PASTE]: ["invoke"],
	[IPC.PREVIEW_CANCEL]: ["invoke"],
	[IPC.STT_PREVIEW_READY]: ["on"],

	// TTS (renderer → main)
	[IPC.TTS_SPEAK]: ["invoke"],
	[IPC.TTS_CANCEL]: ["send"],
	[IPC.TTS_SET_SPEED]: ["send"],
	[IPC.TTS_REQUEST_PLAYBACK_PAUSE]: ["send"],
	[IPC.TTS_REQUEST_PLAYBACK_RESUME]: ["send"],
	[IPC.TTS_INIT]: ["invoke"],
	[IPC.TTS_LIST_VOICES]: ["invoke"],
	[IPC.TTS_CLOUD_LIST_VOICES]: ["invoke"],
	[IPC.TTS_CLOUD_PREVIEW]: ["invoke"],
	[IPC.TTS_OPENROUTER_PREVIEW]: [],
	[IPC.TTS_CLOUD_SUBSCRIPTION]: ["invoke"],
	[IPC.TTS_DOWNLOAD_ESTIMATE]: ["invoke"],
	[IPC.TTS_INSTALL_PAUSE]: ["send"],
	[IPC.TTS_INSTALL_RESUME]: ["send"],
	[IPC.TTS_INSTALL_CANCEL]: ["send"],
	[IPC.TTS_REPORT_PLAYBACK_STARTED]: ["send"],
	[IPC.TTS_REPORT_PLAYBACK_ENDED]: ["send"],
	[IPC.TTS_LIST_MODELS]: ["invoke"],
	[IPC.TTS_LIST_MODELS_WITH_STATE]: ["invoke"],
	[IPC.TTS_PREDOWNLOAD]: ["invoke"],
	[IPC.TTS_DOWNLOAD_PAUSE]: ["invoke"],
	[IPC.TTS_DOWNLOAD_RESUME]: ["invoke"],
	[IPC.TTS_DOWNLOAD_CANCEL]: ["invoke"],
	[IPC.TTS_DELETE_MODEL]: ["invoke"],

	// TTS events (main → renderer)
	[IPC.TTS_STARTED]: ["on"],
	[IPC.TTS_CHUNK]: ["on"],
	[IPC.TTS_COMPLETED]: ["on"],
	[IPC.TTS_FAILED]: ["on"],
	[IPC.TTS_PLAYBACK_STARTED]: ["on"],
	[IPC.TTS_PLAYBACK_ENDED]: ["on"],
	[IPC.TTS_PAUSE_PLAYBACK]: ["on"],
	[IPC.TTS_RESUME_PLAYBACK]: ["on"],
	[IPC.TTS_DISCARD_PLAYBACK]: ["on"],
	[IPC.TTS_MODEL_DOWNLOAD_START]: ["on"],
	[IPC.TTS_MODEL_DOWNLOAD_PROGRESS]: ["on"],
	[IPC.TTS_MODEL_DOWNLOAD_COMPLETE]: ["on"],
	[IPC.TTS_INSTALL_STATUS]: ["on"],
	[IPC.TTS_INSTALL_FAILED]: ["on"],
	[IPC.TTS_INSTALL_PAUSED]: ["on"],
	[IPC.TTS_INSTALL_RESUMED]: ["on"],
	[IPC.TTS_CATALOG_MODEL_DOWNLOAD_PROGRESS]: ["on"],
	[IPC.TTS_CATALOG_MODEL_DOWNLOAD_COMPLETE]: ["on"],
	[IPC.TTS_CATALOG_MODEL_CACHE_CHANGED]: ["on"],

	// LLM events (main → renderer)
	[IPC.LLM_CATALOG]: ["on"],
	[IPC.LLM_PULL_PROGRESS]: ["on"],
	[IPC.LLM_PROCESSING_START]: ["on"],
	[IPC.LLM_PROCESSING_END]: ["on"],
	[IPC.LLM_REASONING_DELTA]: ["on"],
	[IPC.LLM_LEARNED_PROPER_NOUNS]: ["on"],

	// Updater
	[IPC.UPDATER_GET_STATUS_HISTORY]: ["invoke", "secure"],
	[IPC.UPDATER_CLEAR_STATUS_HISTORY]: ["invoke", "secure"],
	[IPC.UPDATER_STATUS]: ["on"],
	[IPC.UPDATER_CHECK_NOW]: ["invoke"],
	[IPC.UPDATER_QUIT_AND_INSTALL]: ["invoke"],

	// Secure-IPC plumbing — preload uses these internally, not exposed to renderer
	[IPC.SECURE_GET_KEY]: [],
	[IPC.SECURE_INVOKE]: [],

	// Transcription history
	[IPC.HISTORY_GET_ALL]: ["invoke"],
	[IPC.HISTORY_CLEAR]: ["invoke"],
	[IPC.HISTORY_DELETE]: ["invoke"],
	[IPC.HISTORY_LOAD_AUDIO]: ["invoke"],
	[IPC.HISTORY_ALIGN_AUDIO]: ["invoke"],
	[IPC.HISTORY_ADDED]: ["on"],
	[IPC.HISTORY_DELETED]: ["on"],

	// SQLite-backed transcription history
	[IPC.HISTORY_LIST]: ["invoke"],
	[IPC.HISTORY_DELETE_ROW]: ["invoke"],
	[IPC.HISTORY_TOGGLE]: ["invoke"],
	[IPC.HISTORY_LOAD_AUDIO_BY_ROW]: ["invoke"],
	[IPC.HISTORY_ROW_ADDED]: ["on"],
	[IPC.HISTORY_ROW_DELETED]: ["on"],
	[IPC.HISTORY_ROW_TOGGLED]: ["on"],

	// LLM warmup status
	[IPC.LLM_GET_WARMUP_STATUS]: ["invoke"],
	[IPC.LLM_WARMUP_STATUS]: ["on"],

	// Speaker diarization (server → main → renderer)
	[IPC.STT_SPEAKER_SEGMENTS]: ["on"],
	[IPC.STT_DIARIZATION_TOGGLE_STARTED]: ["on"],
	[IPC.STT_DIARIZATION_TOGGLE_COMPLETED]: ["on"],
	[IPC.STT_DIARIZATION_TOGGLE_FAILED]: ["on"],

	// Diagnostics — logs-folder opener (plugin route)
	[IPC.DIAG_OPEN_LOGS_FOLDER]: ["invoke"],

	// Custom-models management (renderer → main)
	[IPC.CUSTOM_MODELS_OPEN_FOLDER]: ["invoke"],

	[IPC.SETTINGS_REMOVE_APPLICATION_DATA]: ["invoke"],
	[IPC.SETTINGS_REMOVE_DOWNLOADED_MODELS]: ["invoke"],
};

/** Return every channel whose direction list includes the given direction. */
export function channelsByDirection(
	direction: IpcDirection,
): readonly IpcChannel[] {
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
