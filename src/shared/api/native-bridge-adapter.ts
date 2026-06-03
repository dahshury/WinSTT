// PORT — WU-0 (app/PORT/10_frontend_port_plan.md §2/§3).
//
// THE single new renderer file the WinSTT→Tauri port introduces. It installs a
// `window.nativeBridge` polyfill backed by `@tauri-apps/api` so the entire
// ~401-file WinSTT renderer (and `ipc-client.ts` itself) runs VERBATIM. Every
// `nativeBridge.{send,invoke,secureInvoke,on,getPathForFile}` call routes through
// the ROUTE table below to either:
//   - a Tauri command   (invoke(cmd, args))   — `lib_wiring.md §3`
//   - a Tauri event      (listen(event, cb))   — `lib_wiring.md §4`
//   - a window op        (getCurrentWindow().minimize() …)
//   - a Tauri plugin     (dialog / clipboard / os / opener / updater / autostart)
//   - a polyfill / noop  (no backend — shimmed locally)
//
// Encryption (secureInvoke) collapses to plain invoke: Tauri's IPC is already
// process-isolated, so the reference secure channel has no analogue.
//
// install() is idempotent and called once from `app/providers/IpcProvider` (and
// safe to import from any entry before a view mounts). Channels that are NOT in
// ROUTE log a single warning and resolve to `undefined` (the renderer's
// `invokeOrDefault` then supplies its declared fallback).

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { IPC } from "./ipc-channels";

// Exhaustiveness guard for discriminated-union switches. Reaching it is a
// COMPILE error (`x: never`) when every case is handled — so adding a new
// `WindowOp` / `PluginTarget` member without a matching case fails to build
// instead of silently falling through to a `return undefined`.
function assertNever(x: never): never {
	throw new Error(`unhandled: ${JSON.stringify(x)}`);
}

// `@tauri-apps/api/core` + `/event` are statically imported so `install()` can
// run SYNCHRONOUSLY (before React's first render fires the IPC hooks). The heavy
// plugins (dialog/clipboard/os/updater/…) stay dynamic in callPlugin().
const core = {
	invoke: tauriInvoke as <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>,
};
const evt = {
	listen: tauriListen as unknown as (
		event: string,
		handler: (e: { payload: unknown }) => void
	) => Promise<() => void>,
};

// ── Route kinds ───────────────────────────────────────────────────────────────
type WindowOp =
	| "minimize"
	| "maximize"
	| "close"
	| "hide"
	| "show"
	| "quit"
	| "ignore-mouse";

type Route =
	| { kind: "command"; cmd: string; inject?: Record<string, unknown> }
	| { kind: "event"; event: string }
	| { kind: "window"; op: WindowOp }
	| { kind: "plugin"; plugin: PluginTarget }
	| { kind: "noop" };

// Plugin targets are handled by a small dispatch (see callPlugin) so we don't
// statically import every plugin at module top (keeps the cold path lean).
type PluginTarget =
	| "dialog:open"
	| "clipboard:operate"
	| "os:locale"
	| "opener:logs"
	| "opener:custom-models"
	| "updater:status-history"
	| "updater:clear-status-history"
	| "updater:check-now"
	| "updater:quit-and-install"
	| "autostart:set"
	| "autostart:get";

// ── The ROUTE table: WinSTT channel → Tauri target ─────────────────────────────
// Grounded in `frontend/src/shared/api/ipc-channels.ts` (IPC + IPC_DIRECTIONS)
// and the §1b/§3 mapping. Commands marked ⚠MISSING in the plan still route to a
// command name here; the backend command is filed under the owning slice's WU.
const ROUTE: Partial<Record<string, Route>> = {
	// ── STT dictation core (send/invoke commands) ──
	[IPC.STT_SET_PARAMETER]: { kind: "command", cmd: "winstt_set_parameter" },
	[IPC.STT_GET_PARAMETER]: { kind: "command", cmd: "winstt_get_parameter" },
	[IPC.STT_CALL_METHOD]: { kind: "command", cmd: "winstt_call_method" },
	[IPC.STT_IS_CONNECTED]: { kind: "noop" }, // engine in-proc → always-connected shim (returns false → ipc-client default; overridden in install)
	[IPC.STT_ABORT_OPERATION]: { kind: "command", cmd: "cancel_current_operation" },
	[IPC.OVERLAY_SET_IGNORE_MOUSE]: { kind: "window", op: "ignore-mouse" },
	[IPC.STT_SERVER_SPAWN]: { kind: "noop" },
	[IPC.STT_SERVER_KILL]: { kind: "noop" },
	[IPC.STT_SERVER_GET_STATUS]: { kind: "noop" },
	[IPC.STT_GET_SERVER_READY]: { kind: "noop" },
	[IPC.STT_RELOAD_MODEL]: { kind: "command", cmd: "set_winstt_model" },

	// ── STT events (main → renderer) ──
	[IPC.STT_REALTIME_TEXT]: { kind: "event", event: "realtime-update" },
	[IPC.STT_FULL_SENTENCE]: { kind: "event", event: "stt:full-sentence" },
	[IPC.STT_NO_AUDIO_DETECTED]: { kind: "event", event: "stt:no-audio-detected" },
	[IPC.STT_TRANSCRIPTION_FAILED]: { kind: "event", event: "stt:transcription-failed" },
	[IPC.STT_RECORDING_START]: { kind: "event", event: "stt:recording-start" },
	[IPC.STT_RECORDING_STOP]: { kind: "event", event: "stt:recording-stop" },
	[IPC.STT_VAD_START]: { kind: "event", event: "stt:vad-start" },
	[IPC.STT_VAD_STOP]: { kind: "event", event: "stt:vad-stop" },
	[IPC.STT_TRANSCRIPTION_START]: { kind: "event", event: "stt:transcription-start" },
	[IPC.STT_CONNECTION_CHANGE]: { kind: "event", event: "stt:connection-change" },
	[IPC.STT_SERVER_STATUS]: { kind: "event", event: "stt:server-status" },
	[IPC.STT_SESSION_ABORTED]: { kind: "event", event: "stt:session-aborted" },
	[IPC.STT_AUDIO_LEVEL]: { kind: "event", event: "stt:audio-level" },
	[IPC.STT_WAKEWORD_DETECTED]: { kind: "event", event: "wake_word_detected" },
	[IPC.STT_WAKEWORD_DETECTION_START]: { kind: "event", event: "stt:wakeword-detection-start" },
	[IPC.STT_WAKEWORD_DETECTION_END]: { kind: "event", event: "stt:wakeword-detection-end" },
	[IPC.STT_VAD_SENSITIVITY_ADAPTED]: { kind: "event", event: "vad-sensitivity-adapted" },
	[IPC.STT_SPEAKER_SEGMENTS]: { kind: "event", event: "speaker-segments" },
	[IPC.STT_RESTART_REQUIRED]: { kind: "event", event: "stt:restart-required" },

	// ── Model catalog / picker / download (slices 01/03) ──
	[IPC.STT_GET_MODEL_CATALOG]: { kind: "command", cmd: "list_models" },
	[IPC.STT_LIST_MODELS_WITH_STATE]: { kind: "command", cmd: "list_models_with_state" },
	[IPC.STT_MODEL_CATALOG]: { kind: "event", event: "stt:model-catalog" },
	[IPC.STT_GET_RUNTIME_INFO]: { kind: "command", cmd: "get_runtime_info" },
	[IPC.STT_RUNTIME_INFO]: { kind: "event", event: "stt:runtime-info" },
	[IPC.STT_GET_LIVE_RESOURCES]: { kind: "command", cmd: "get_live_resources" },
	[IPC.STT_ASSESS_DICTATION_FIT]: { kind: "command", cmd: "assess_dictation_fit" },
	[IPC.STT_ASSESS_OLLAMA_FIT]: { kind: "command", cmd: "assess_ollama_fit" },
	[IPC.STT_PREDOWNLOAD_QUANT]: { kind: "command", cmd: "predownload_quant" },
	[IPC.STT_DOWNLOAD_PAUSE]: { kind: "command", cmd: "download_pause_quant" },
	[IPC.STT_DOWNLOAD_RESUME]: { kind: "command", cmd: "download_resume_quant" },
	[IPC.STT_DOWNLOAD_CANCEL_QUANT]: { kind: "command", cmd: "download_cancel_quant" },
	[IPC.STT_DELETE_MODEL_QUANTIZATION]: { kind: "command", cmd: "delete_model_quantization" },
	[IPC.STT_DELETE_MODEL_CACHE]: { kind: "command", cmd: "delete_model_cache" },
	// The renderer's `cancelDownload()` sends NO args. `cancel_download` is Handy's
	// command (requires `model_id` → the arg-less invoke rejects on deserialize);
	// the WinSTT arg-less variant is `winstt_cancel_download` (commands/download.rs),
	// registered in lib.rs to avoid the duplicate-name clash.
	[IPC.STT_CANCEL_DOWNLOAD]: { kind: "command", cmd: "winstt_cancel_download" },
	[IPC.STT_MODEL_DOWNLOAD_START]: { kind: "event", event: "stt:model-download-start" },
	[IPC.STT_MODEL_DOWNLOAD_PROGRESS]: { kind: "event", event: "stt:model-download-progress" },
	[IPC.STT_MODEL_DOWNLOAD_COMPLETE]: { kind: "event", event: "stt:model-download-complete" },
	[IPC.STT_MODEL_CACHE_CHANGED]: { kind: "event", event: "stt:model-cache-changed" },
	[IPC.STT_MODEL_SWAP_STARTED]: { kind: "event", event: "stt:model-swap-started" },
	[IPC.STT_MODEL_SWAP_COMPLETED]: { kind: "event", event: "stt:model-swap-completed" },
	[IPC.STT_MODEL_SWAP_FAILED]: { kind: "event", event: "stt:model-swap-failed" },
	[IPC.STT_DIARIZATION_TOGGLE_STARTED]: { kind: "event", event: "stt:diarization-toggle-started" },
	[IPC.STT_DIARIZATION_TOGGLE_COMPLETED]: {
		kind: "event",
		event: "stt:diarization-toggle-completed",
	},
	[IPC.STT_DIARIZATION_TOGGLE_FAILED]: { kind: "event", event: "stt:diarization-toggle-failed" },

	// ── Settings ──
	[IPC.SETTINGS_LOAD]: { kind: "command", cmd: "winstt_get_settings" },
	[IPC.SETTINGS_SAVE]: { kind: "command", cmd: "winstt_set_settings" },
	[IPC.SETTINGS_CHANGED]: { kind: "event", event: "settings:changed" },
	[IPC.SETTINGS_SAVE_ERROR]: { kind: "event", event: "settings:save-error" },

	// ── Hotkey ──
	[IPC.HOTKEY_REGISTER]: { kind: "command", cmd: "hotkey_register" },
	[IPC.HOTKEY_UNREGISTER]: { kind: "command", cmd: "hotkey_unregister" },
	[IPC.HOTKEY_START_RECORDING]: { kind: "command", cmd: "hotkey_start_recording" },
	[IPC.HOTKEY_STOP_RECORDING]: { kind: "command", cmd: "hotkey_stop_recording" },
	[IPC.HOTKEY_PRESSED]: { kind: "event", event: "hotkey:pressed" },
	[IPC.HOTKEY_RELEASED]: { kind: "event", event: "hotkey:released" },
	[IPC.HOTKEY_RECORDING_UPDATE]: { kind: "event", event: "hotkey:recording-update" },
	[IPC.HOTKEY_RECORDING_DONE]: { kind: "event", event: "hotkey:recording-done" },

	// ── System ──
	[IPC.AUTOSTART_SET]: { kind: "plugin", plugin: "autostart:set" },
	[IPC.AUTOSTART_GET]: { kind: "plugin", plugin: "autostart:get" },
	[IPC.AUDIO_GET_DEVICES]: { kind: "command", cmd: "get_audio_devices" },
	[IPC.GPU_GET_INFO]: { kind: "command", cmd: "gpu_get_info" },
	[IPC.APP_GET_SYSTEM_LOCALE]: { kind: "plugin", plugin: "os:locale" },

	// ── Window controls / navigation ──
	[IPC.WINDOW_MINIMIZE]: { kind: "window", op: "minimize" },
	[IPC.WINDOW_MAXIMIZE]: { kind: "window", op: "maximize" },
	[IPC.WINDOW_CLOSE]: { kind: "window", op: "hide" },
	// Self-closing secondary windows (settings / onboarding) route through the
	// `close_self_window` command (not a bare webview hide) so the Settings modal
	// can re-enable the main pill as it closes — a renderer-side `.hide()` never
	// reaches Rust, leaving the pill input-disabled. Resolves its own label from
	// the calling webview; non-settings callers get a plain hide.
	[IPC.WINDOW_CLOSE_SELF]: { kind: "command", cmd: "close_self_window" },
	// WINDOW_SHOW means "show the MAIN window" (the reference handled it in the main
	// process). The only caller is the tray menu's "Show Window" item — routing it
	// to the generic `getCurrentWindow().show()` would re-show the *tray-menu*
	// window (the caller), never the pill. Target the main window explicitly via
	// the command, which also force-raises it above other apps.
	[IPC.WINDOW_SHOW]: { kind: "command", cmd: "show_main_window_command" },
	[IPC.WINDOW_QUIT]: { kind: "window", op: "quit" },
	[IPC.WINDOW_OPEN_SETTINGS]: { kind: "command", cmd: "open_window", inject: { name: "settings" } },
	[IPC.MODEL_PICKER_OPEN]: { kind: "command", cmd: "open_window", inject: { name: "model-picker" } },
	[IPC.MODEL_PICKER_CLOSE]: {
		kind: "command",
		cmd: "close_window",
		inject: { name: "model-picker" },
	},
	[IPC.MODEL_PICKER_RESIZE]: {
		kind: "command",
		cmd: "resize_window",
		inject: { name: "model-picker" },
	},
	[IPC.MODEL_PICKER_ANCHOR]: { kind: "event", event: "model-picker:anchor" },
	[IPC.MODEL_PICKER_CLOSING]: { kind: "event", event: "model-picker:closing" },
	[IPC.DEVICE_PICKER_OPEN]: {
		kind: "command",
		cmd: "open_window",
		inject: { name: "device-picker" },
	},
	[IPC.DEVICE_PICKER_CLOSE]: {
		kind: "command",
		cmd: "close_window",
		inject: { name: "device-picker" },
	},
	[IPC.DEVICE_PICKER_RESIZE]: {
		kind: "command",
		cmd: "resize_window",
		inject: { name: "device-picker" },
	},
	[IPC.TRAY_MENU_CLOSE]: { kind: "command", cmd: "close_window", inject: { name: "tray-menu" } },
	[IPC.TRAY_MENU_RESIZE]: { kind: "command", cmd: "resize_window", inject: { name: "tray-menu" } },
	[IPC.ONBOARDING_FINISH]: { kind: "command", cmd: "onboarding_finish" },

	// ── Context-awareness playground (debug-only) ──
	[IPC.CONTEXT_PLAYGROUND_OPEN]: {
		kind: "command",
		cmd: "open_window",
		inject: { name: "context-playground" },
	},
	[IPC.CONTEXT_PLAYGROUND_SET_LIVE]: { kind: "command", cmd: "context_playground_set_live" },
	[IPC.CONTEXT_PLAYGROUND_ARM_DEEP]: { kind: "command", cmd: "context_playground_arm_deep" },
	[IPC.CONTEXT_PLAYGROUND_CLOSE]: {
		kind: "command",
		cmd: "close_window",
		inject: { name: "context-playground" },
	},
	[IPC.CONTEXT_PLAYGROUND_REPORT]: { kind: "event", event: "context-playground:report" },

	// ── Dialog / clipboard / menus ──
	[IPC.DIALOG_OPEN_FILE]: { kind: "plugin", plugin: "dialog:open" },
	[IPC.CLIPBOARD_OPERATE]: { kind: "plugin", plugin: "clipboard:operate" },
	[IPC.APP_MENU_SET_TEMPLATE]: { kind: "noop" },
	[IPC.APP_MENU_RESET]: { kind: "noop" },
	[IPC.CONTEXT_MENU_SHOW]: { kind: "noop" },

	// ── TTS (slice 06) ──
	[IPC.TTS_SPEAK]: { kind: "command", cmd: "tts_speak" },
	[IPC.TTS_SPEAK_SELECTION]: { kind: "command", cmd: "tts_speak_selection" },
	[IPC.TTS_CANCEL]: { kind: "command", cmd: "tts_cancel" },
	[IPC.TTS_SET_SPEED]: { kind: "command", cmd: "tts_set_speed" },
	[IPC.TTS_INIT]: { kind: "command", cmd: "tts_init" },
	[IPC.TTS_LIST_VOICES]: { kind: "command", cmd: "tts_list_voices" },
	[IPC.TTS_CLOUD_LIST_VOICES]: { kind: "command", cmd: "tts_list_cloud_voices" },
	[IPC.TTS_CLOUD_PREVIEW]: { kind: "command", cmd: "tts_preview_cloud" },
	[IPC.TTS_CLOUD_SUBSCRIPTION]: { kind: "command", cmd: "tts_cloud_subscription" },
	[IPC.TTS_DOWNLOAD_ESTIMATE]: { kind: "command", cmd: "tts_download_estimate" },
	[IPC.TTS_INSTALL_PAUSE]: { kind: "command", cmd: "tts_install_pause" },
	[IPC.TTS_INSTALL_RESUME]: { kind: "command", cmd: "tts_install_resume" },
	[IPC.TTS_INSTALL_CANCEL]: { kind: "command", cmd: "tts_install_cancel" },
	[IPC.TTS_REPORT_PLAYBACK_STARTED]: { kind: "command", cmd: "tts_report_playback_started" },
	[IPC.TTS_REPORT_PLAYBACK_ENDED]: { kind: "command", cmd: "tts_report_playback_ended" },
	[IPC.TTS_STARTED]: { kind: "event", event: "tts:started" },
	[IPC.TTS_CHUNK]: { kind: "event", event: "tts://chunk" },
	[IPC.TTS_COMPLETED]: { kind: "event", event: "tts:completed" },
	[IPC.TTS_FAILED]: { kind: "event", event: "tts:failed" },
	[IPC.TTS_PLAYBACK_STARTED]: { kind: "event", event: "tts:playback-started" },
	[IPC.TTS_PLAYBACK_ENDED]: { kind: "event", event: "tts:playback-ended" },
	[IPC.TTS_MODEL_DOWNLOAD_START]: { kind: "event", event: "tts:model-download-start" },
	[IPC.TTS_MODEL_DOWNLOAD_PROGRESS]: { kind: "event", event: "tts:model-download-progress" },
	[IPC.TTS_MODEL_DOWNLOAD_COMPLETE]: { kind: "event", event: "tts:model-download-complete" },
	[IPC.TTS_INSTALL_STATUS]: { kind: "event", event: "tts:install-status" },
	[IPC.TTS_INSTALL_FAILED]: { kind: "event", event: "tts:install-failed" },
	[IPC.TTS_INSTALL_PAUSED]: { kind: "event", event: "tts:install-paused" },
	[IPC.TTS_INSTALL_RESUMED]: { kind: "event", event: "tts:install-resumed" },
	// ── Multi-provider TTS catalog (model-aware picker) ──
	[IPC.TTS_LIST_MODELS]: { kind: "command", cmd: "tts_list_models" },
	[IPC.TTS_LIST_MODELS_WITH_STATE]: { kind: "command", cmd: "tts_list_models_with_state" },
	[IPC.TTS_PREDOWNLOAD]: { kind: "command", cmd: "tts_predownload_model" },
	[IPC.TTS_DOWNLOAD_PAUSE]: { kind: "command", cmd: "tts_download_pause" },
	[IPC.TTS_DOWNLOAD_RESUME]: { kind: "command", cmd: "tts_download_resume" },
	[IPC.TTS_DOWNLOAD_CANCEL]: { kind: "command", cmd: "tts_download_cancel" },
	[IPC.TTS_DELETE_MODEL]: { kind: "command", cmd: "tts_delete_model" },
	[IPC.TTS_CATALOG_MODEL_DOWNLOAD_PROGRESS]: {
		kind: "event",
		event: "tts:catalog-model-download-progress",
	},
	[IPC.TTS_CATALOG_MODEL_DOWNLOAD_COMPLETE]: {
		kind: "event",
		event: "tts:catalog-model-download-complete",
	},
	[IPC.TTS_CATALOG_MODEL_CACHE_CHANGED]: { kind: "event", event: "tts:model-cache-changed" },

	// ── LLM / Ollama / OpenRouter (slice 07) ──
	[IPC.LLM_PROCESS_TEXT]: { kind: "command", cmd: "process_text" },
	[IPC.LLM_PROCESS_TEXT_CUSTOM]: { kind: "command", cmd: "process_text" },
	[IPC.LLM_SCAN_MODELS]: { kind: "command", cmd: "scan_ollama_models" },
	[IPC.LLM_SCAN_OPENROUTER_MODELS]: { kind: "command", cmd: "scan_openrouter_models" },
	[IPC.LLM_DETECT_OLLAMA]: { kind: "command", cmd: "ollama_detect" },
	[IPC.LLM_START_OLLAMA]: { kind: "command", cmd: "ollama_start" },
	[IPC.LLM_PULL_MODEL]: { kind: "command", cmd: "ollama_pull" },
	[IPC.LLM_CANCEL_PULL_MODEL]: { kind: "command", cmd: "ollama_cancel_pull" },
	[IPC.LLM_DELETE_MODEL]: { kind: "command", cmd: "ollama_delete" },
	[IPC.LLM_FETCH_OLLAMA_LIBRARY]: { kind: "command", cmd: "ollama_fetch_library" },
	[IPC.LLM_FETCH_OLLAMA_TAGS]: { kind: "command", cmd: "ollama_fetch_tags" },
	[IPC.LLM_SEARCH_OLLAMA_LIBRARY]: { kind: "command", cmd: "ollama_search_library" },
	[IPC.LLM_GET_WARMUP_STATUS]: { kind: "command", cmd: "llm_get_warmup_status" },
	[IPC.INTEGRATIONS_VERIFY]: { kind: "command", cmd: "verify_credential" },
	[IPC.LLM_CATALOG]: { kind: "event", event: "llm:catalog" },
	[IPC.LLM_PULL_PROGRESS]: { kind: "event", event: "llm:pull-progress" },
	[IPC.LLM_PROCESSING_START]: { kind: "event", event: "llm:processing-start" },
	[IPC.LLM_PROCESSING_END]: { kind: "event", event: "llm:processing-end" },
	[IPC.LLM_REASONING_DELTA]: { kind: "event", event: "llm-reasoning-delta" },
	[IPC.LLM_LEARNED_PROPER_NOUNS]: { kind: "event", event: "llm-learned-proper-nouns" },
	[IPC.LLM_WARMUP_STATUS]: { kind: "event", event: "llm:warmup-status" },

	// ── Transforms (slice 13) ──
	// applyTransform() sends no args → `apply_transform` captures the selection,
	// runs the composed presets+modifiers prompt, pastes back, and emits
	// transforms:applied/failed. runLlmPreview sends { text, feature, config }
	// → `apply_transform_preview` (no selection/paste). WU-13 owns both commands.
	[IPC.TRANSFORMS_APPLY]: { kind: "command", cmd: "apply_transform" },
	[IPC.TRANSFORMS_PREVIEW]: { kind: "command", cmd: "apply_transform_preview" },
	[IPC.TRANSFORMS_APPLIED]: { kind: "event", event: "transforms:applied" },
	[IPC.TRANSFORMS_FAILED]: { kind: "event", event: "transforms:failed" },

	// ── Cloud STT (slice 07) — the 5 error channels fan out from one event ──
	[IPC.STT_CLOUD_AUTH_FAILED]: { kind: "event", event: "stt-cloud-error" },
	[IPC.STT_CLOUD_NETWORK_ERROR]: { kind: "event", event: "stt-cloud-error" },
	[IPC.STT_CLOUD_KEY_MISSING]: { kind: "event", event: "stt-cloud-error" },
	[IPC.STT_CLOUD_RATE_LIMITED]: { kind: "event", event: "stt-cloud-error" },
	[IPC.STT_CLOUD_PROVIDER_ERROR]: { kind: "event", event: "stt-cloud-error" },

	// ── File transcription (slice 07/08) ──
	[IPC.FILE_TRANSCRIBE]: { kind: "command", cmd: "file_transcribe_enqueue" },
	[IPC.FILE_QUEUE_ENQUEUE]: { kind: "command", cmd: "file_transcribe_enqueue" },
	[IPC.FILE_QUEUE_CANCEL]: { kind: "command", cmd: "file_transcribe_cancel" },
	[IPC.FILE_QUEUE_RETRY]: { kind: "command", cmd: "file_transcribe_retry" },
	[IPC.FILE_QUEUE_COPY]: { kind: "command", cmd: "file_transcribe_copy" },
	[IPC.FILE_QUEUE_CLEAR]: { kind: "command", cmd: "file_transcribe_clear" },
	[IPC.FILE_QUEUE_PAUSE]: { kind: "command", cmd: "file_transcribe_pause" },
	[IPC.FILE_QUEUE_RESUME]: { kind: "command", cmd: "file_transcribe_resume" },
	[IPC.FILE_QUEUE_DISCARD_ALL]: { kind: "command", cmd: "file_transcribe_discard_all" },
	[IPC.FILE_QUEUE_GET_ACTIVE]: { kind: "command", cmd: "file_transcribe_get_active" },
	[IPC.FILE_TRANSCRIPTION_PROGRESS]: { kind: "event", event: "file:transcription-progress" },
	[IPC.FILE_TRANSCRIPTION_COMPLETE]: { kind: "event", event: "file:transcription-complete" },
	[IPC.FILE_TRANSCRIPTION_ERROR]: { kind: "event", event: "file:transcription-error" },
	[IPC.FILE_QUEUE_UPDATE]: { kind: "event", event: "file:queue-update" },
	[IPC.FILE_QUEUE_PROGRESS]: { kind: "event", event: "file:queue-progress" },
	[IPC.FILE_QUEUE_ACTIVE]: { kind: "event", event: "file:queue-active" },

	// ── Loopback / listen / diarization (slice 09) ──
	[IPC.LOOPBACK_LIST_DEVICES]: { kind: "command", cmd: "loopback_list_devices" },
	[IPC.LOOPBACK_START]: { kind: "command", cmd: "start_listen" },
	[IPC.LOOPBACK_STOP]: { kind: "command", cmd: "stop_listen" },
	[IPC.STT_LOOPBACK_STARTED]: { kind: "event", event: "stt:loopback-started" },
	[IPC.STT_LOOPBACK_STOPPED]: { kind: "event", event: "stt:loopback-stopped" },
	[IPC.STT_DEVICE_SWITCH_FAILED]: { kind: "event", event: "stt:device-switch-failed" },
	[IPC.LID_CLOSED]: { kind: "event", event: "lid:closed" },
	[IPC.LID_OPENED]: { kind: "event", event: "lid:opened" },

	// ── Sound (slice 05/11) ──
	[IPC.SOUND_GET_DATA]: { kind: "command", cmd: "sound_get_data" },
	[IPC.SOUND_LIBRARY_ADD]: { kind: "command", cmd: "sound_library_add" },
	[IPC.SOUND_LIBRARY_REMOVE]: { kind: "command", cmd: "sound_library_remove" },
	[IPC.SOUND_LIBRARY_READ_FILE]: { kind: "command", cmd: "sound_library_read_file" },
	[IPC.SOUND_PLAY]: { kind: "event", event: "sound:play" },

	// ── History (slice 10) ──
	[IPC.HISTORY_GET_ALL]: { kind: "command", cmd: "history_get_all" },
	[IPC.HISTORY_CLEAR]: { kind: "command", cmd: "history_clear" },
	[IPC.HISTORY_DELETE]: { kind: "command", cmd: "history_delete" },
	[IPC.HISTORY_LOAD_AUDIO]: { kind: "command", cmd: "history_load_audio" },
	[IPC.HISTORY_ALIGN_AUDIO]: { kind: "command", cmd: "align_words" },
	[IPC.HISTORY_LIST]: { kind: "command", cmd: "history_list" },
	[IPC.HISTORY_ADD]: { kind: "command", cmd: "history_add" },
	[IPC.HISTORY_DELETE_ROW]: { kind: "command", cmd: "history_delete_row" },
	[IPC.HISTORY_TOGGLE]: { kind: "command", cmd: "history_toggle" },
	[IPC.HISTORY_RECENT]: { kind: "command", cmd: "history_recent" },
	[IPC.HISTORY_LOAD_AUDIO_BY_ROW]: { kind: "command", cmd: "history_load_audio_by_row" },
	[IPC.HISTORY_ADDED]: { kind: "event", event: "history:added" },
	[IPC.HISTORY_DELETED]: { kind: "event", event: "history:deleted" },
	[IPC.HISTORY_ROW_ADDED]: { kind: "event", event: "history:row-added" },
	[IPC.HISTORY_ROW_DELETED]: { kind: "event", event: "history:row-deleted" },
	[IPC.HISTORY_ROW_TOGGLED]: { kind: "event", event: "history:row-toggled" },

	// ── Transcript quick-actions ──
	[IPC.TRANSCRIPT_COPY_LAST]: { kind: "command", cmd: "copy_last_transcript" },

	// ── Diagnostics / custom models / about (slice 11) ──
	[IPC.DIAG_OPEN_LOGS_FOLDER]: { kind: "plugin", plugin: "opener:logs" },
	[IPC.DIAG_SAVE_BUNDLE]: { kind: "command", cmd: "diag_save_bundle" },
	[IPC.CUSTOM_MODELS_OPEN_FOLDER]: { kind: "plugin", plugin: "opener:custom-models" },
	[IPC.ABOUT_GET_LICENSE]: { kind: "command", cmd: "about_get_license" },
	[IPC.ABOUT_GET_NOTICES]: { kind: "command", cmd: "about_get_notices" },
	[IPC.ABOUT_GET_APP_INFO]: { kind: "command", cmd: "about_get_app_info" },

	// ── Updater (secure → plugin) ──
	[IPC.UPDATER_GET_STATUS_HISTORY]: { kind: "plugin", plugin: "updater:status-history" },
	[IPC.UPDATER_CLEAR_STATUS_HISTORY]: { kind: "plugin", plugin: "updater:clear-status-history" },
	[IPC.UPDATER_CHECK_NOW]: { kind: "plugin", plugin: "updater:check-now" },
	[IPC.UPDATER_QUIT_AND_INSTALL]: { kind: "plugin", plugin: "updater:quit-and-install" },
	[IPC.UPDATER_STATUS]: { kind: "event", event: "updater:status" },

	// ── Window telemetry — noop in Tauri (no analogue needed by views v1) ──
	[IPC.WINDOW_TELEMETRY]: { kind: "noop" },
};

// ── Arg-shape normalization ────────────────────────────────────────────────────
// WinSTT wrappers pass either a single object (`{ parameter, value }`) or a bare
// positional value. Tauri `invoke` needs a single object keyed by the Rust fn's
// parameter names. The three positional-string channels are wrapped here.
const POSITIONAL_STRING_PARAM: Partial<Record<string, string>> = {
	[IPC.STT_DELETE_MODEL_CACHE]: "modelId",
	[IPC.HISTORY_LOAD_AUDIO]: "id",
	[IPC.HISTORY_ALIGN_AUDIO]: "entryId",
	[IPC.HISTORY_DELETE]: "id",
	[IPC.HISTORY_DELETE_ROW]: "id",
	[IPC.HISTORY_TOGGLE]: "id",
	[IPC.HISTORY_LOAD_AUDIO_BY_ROW]: "id",
};

function normalizeArgs(channel: string, args: unknown[]): Record<string, unknown> {
	const positionalKey = POSITIONAL_STRING_PARAM[channel];
	if (positionalKey !== undefined && args.length > 0 && typeof args[0] !== "object") {
		return { [positionalKey]: args[0] };
	}
	const first = args[0];
	if (first !== null && typeof first === "object" && !Array.isArray(first)) {
		return first as Record<string, unknown>;
	}
	// Array payload (e.g. appMenuSetTemplate) or no args → wrap under `value`
	// so the Rust side can deserialize a single named param if it ever needs to.
	if (first !== undefined) {
		return { value: first };
	}
	return {};
}

// ── Event payload reshape ──────────────────────────────────────────────────────
// Most §4b plain events are byte-identical to WinSTT's IPC shape (identity).
// The exceptions: wake-word (Tauri `WakeWordDetectedPayload` → `{}`/word),
// realtime-update (`{text}` already), and the cloud-error fan-out (one event,
// 5 channels, code-discriminated).
const CLOUD_ERROR_CODE_FOR_CHANNEL: Partial<Record<string, string>> = {
	[IPC.STT_CLOUD_AUTH_FAILED]: "auth_failed",
	[IPC.STT_CLOUD_NETWORK_ERROR]: "network_error",
	[IPC.STT_CLOUD_KEY_MISSING]: "key_missing",
	[IPC.STT_CLOUD_RATE_LIMITED]: "rate_limited",
	[IPC.STT_CLOUD_PROVIDER_ERROR]: "provider_error",
};

/**
 * Returns `true` if the event should be delivered to the channel's callback,
 * after any payload reshape. For the cloud-error fan-out, only the channel whose
 * code matches the event payload's `code` field fires (so each WinSTT channel
 * still sees exactly its own error class).
 */
function shouldDeliver(channel: string, payload: unknown): boolean {
	const expectedCode = CLOUD_ERROR_CODE_FOR_CHANNEL[channel];
	if (expectedCode === undefined) {
		return true;
	}
	const code =
		payload !== null && typeof payload === "object"
			? (payload as { code?: unknown }).code
			: undefined;
	return code === expectedCode;
}

function reshape(channel: string, payload: unknown): unknown {
	// Wake-word: WinSTT `onWakeWordDetected` reshaping expects `{ word }`. The
	// Tauri `WakeWordDetectedPayload` carries the detected word under `word`/`keyword`.
	if (channel === IPC.STT_WAKEWORD_DETECTED && payload !== null && typeof payload === "object") {
		const p = payload as { word?: string; keyword?: string };
		return { word: p.word ?? p.keyword ?? "" };
	}
	// TTS chunk: the backend emits `pcm` as a serde `Vec<u8>`, which Tauri's JSON
	// event bridge delivers as a plain `number[]` of byte values — NOT the binary
	// `ArrayBuffer` that Electron's structured-clone IPC produced (and that the
	// renderer's `TtsChunkPayload.pcm: ArrayBuffer` type + playback-queue assume).
	// The playback path does `new Float32Array(pcm)` (f32le) / `decodeAudioData(pcm)`
	// (mp3); both REQUIRE a real ArrayBuffer. Handed a raw `number[]`, `Float32Array`
	// reads each *byte* as a float (0–255) → 4× the samples, all far outside [-1,1],
	// which `copyToChannel` hard-clips to ±1 = full-scale high-frequency NOISE (and
	// `decodeAudioData` would reject it outright). Normalize to an ArrayBuffer here at
	// the port boundary so the rest of the renderer stays Electron-shaped.
	if (channel === IPC.TTS_CHUNK && payload !== null && typeof payload === "object") {
		const pcm = (payload as { pcm?: unknown }).pcm;
		if (Array.isArray(pcm)) {
			return { ...payload, pcm: new Uint8Array(pcm).buffer };
		}
		if (ArrayBuffer.isView(pcm)) {
			const v = pcm as ArrayBufferView;
			return {
				...payload,
				pcm: v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength),
			};
		}
	}
	return payload;
}

// ── Plugin dispatch ─────────────────────────────────────────────────────────────
async function callPlugin(target: PluginTarget, args: unknown): Promise<unknown> {
	switch (target) {
		case "dialog:open": {
			const { open } = await import("@tauri-apps/plugin-dialog");
			const a = (args ?? {}) as {
				filters?: Array<{ name: string; extensions: string[] }>;
				title?: string;
			};
			return open({
				multiple: false,
				...(a.filters ? { filters: a.filters } : {}),
				...(a.title ? { title: a.title } : {}),
			});
		}
		case "clipboard:operate": {
			const cm = await import("@tauri-apps/plugin-clipboard-manager");
			const op = (args ?? {}) as { operation: string; text?: string };
			if (op.operation === "readText") {
				return { operation: "readText", text: await cm.readText() };
			}
			if (op.operation === "writeText") {
				await cm.writeText(op.text ?? "");
				return { operation: "writeText" };
			}
			// "clear" — Tauri has no clear(); writing an empty string is equivalent.
			await cm.writeText("");
			return { operation: "clear" };
		}
		case "os:locale": {
			const os = await import("@tauri-apps/plugin-os");
			return (await os.locale()) ?? "";
		}
		case "opener:logs":
		case "opener:custom-models": {
			const opener = await import("@tauri-apps/plugin-opener");
			// The backend owns the real folder path; for the polyfill we route to a
			// command if present, else fall back to a best-effort no-op success.
			try {
				const cmd =
					target === "opener:logs" ? "diag_open_logs_folder" : "open_custom_models_folder";
				const path = await core.invoke<string>(cmd);
				if (typeof path === "string" && path.length > 0) {
					await opener.openPath(path);
				}
				return { ok: true, path };
			} catch (e) {
				return { ok: false, error: String(e) };
			}
		}
		case "updater:status-history":
			return [];
		case "updater:clear-status-history":
			return { cleared: true };
		case "updater:check-now": {
			try {
				const { check } = await import("@tauri-apps/plugin-updater");
				const update = await check();
				return { triggered: update !== null };
			} catch (e) {
				return { triggered: false, reason: String(e) };
			}
		}
		case "updater:quit-and-install": {
			try {
				const { check } = await import("@tauri-apps/plugin-updater");
				const update = await check();
				if (update) {
					await update.downloadAndInstall();
					const proc = await import("@tauri-apps/plugin-process");
					await proc.relaunch();
				}
				return { triggered: update !== null };
			} catch (e) {
				return { triggered: false, reason: String(e) };
			}
		}
		case "autostart:set": {
			const as = await import("@tauri-apps/plugin-autostart");
			const enabled = (args as { enabled?: boolean })?.enabled ?? false;
			if (enabled) {
				await as.enable();
			} else {
				await as.disable();
			}
			return;
		}
		case "autostart:get": {
			const as = await import("@tauri-apps/plugin-autostart");
			return as.isEnabled();
		}
		default:
			return assertNever(target);
	}
}

// ── Window ops ───────────────────────────────────────────────────────────────
async function windowOp(op: WindowOp, args: unknown[]): Promise<void> {
	const { getCurrentWindow } = await import("@tauri-apps/api/window");
	const win = getCurrentWindow();
	switch (op) {
		case "minimize":
			await win.minimize();
			return;
		case "maximize":
			await win.toggleMaximize();
			return;
		case "hide":
			await win.hide();
			return;
		case "show":
			await win.show();
			return;
		case "close":
			await win.close();
			return;
		case "quit": {
			const proc = await import("@tauri-apps/plugin-process");
			await proc.exit(0);
			return;
		}
		case "ignore-mouse": {
			const ignore = (args[0] as { ignore?: boolean })?.ignore ?? false;
			await win.setIgnoreCursorEvents(ignore);
			return;
		}
		default:
			assertNever(op);
	}
}

// ── getPathForFile drag-drop bridge (WU-8: file-transcription owns this) ─────────
// Tauri's webview does NOT expose native paths on the DOM `File` (security). The
// renderer's `getFilePath(file)` (used by the file-transcription drag-drop in
// `widgets/audio-display`) is SYNCHRONOUS — it must return the absolute path the
// instant the DOM `drop` handler runs `collectDroppedFiles`. So we cannot resolve
// the path inside an `await`; we have to have it ready *before* the DOM drop fires.
//
// Tauri v2's `onDragDropEvent` emits phases `enter → over… → drop → leave`, and
// BOTH `enter` and `drop` carry the absolute `paths`. The native `enter` fires
// before the DOM `drop` (the OS announces the dragged payload as it crosses the
// window before it's released), so populating `lastDropPaths` on `enter` makes
// `getPathForFile` resolve synchronously by the time `drop` is handled. We keep
// `drop` as a backstop (covers webviews/platforms where `enter` lacks paths) and
// keep the map keyed by name (+size when available) for collision safety.
const lastDropPaths = new Map<string, string>();

function dropKey(name: string, size?: number): string {
	return size === undefined ? name : `${name}:${size}`;
}

function rememberDropPaths(paths: readonly string[]): void {
	for (const path of paths) {
		const name = path.split(/[\\/]/).pop();
		if (name) {
			// Key by bare name (the DOM File exposes name+size, never the path).
			lastDropPaths.set(name, path);
		}
	}
}

function fileToTauriPath(file: File): string {
	return lastDropPaths.get(dropKey(file.name, file.size)) ?? lastDropPaths.get(file.name) ?? "";
}

async function wireDragDrop(): Promise<void> {
	try {
		const { getCurrentWindow } = await import("@tauri-apps/api/window");
		await getCurrentWindow().onDragDropEvent((event) => {
			const payload = event.payload;
			// `enter` AND `drop` carry `paths` in Tauri v2. Stash on BOTH: `enter`
			// (before the DOM drop) makes the synchronous `getFilePath` resolve;
			// `drop` is the backstop. `over`/`leave` carry no paths — ignore.
			if (payload.type === "enter" || payload.type === "drop") {
				rememberDropPaths(payload.paths);
			}
		});
	} catch {
		// Not in a Tauri window context — drag-drop bridge unavailable.
	}
}

// ── Critical-channel surfacing ──────────────────────────────────────────────
// Backend failures on these flows used to vanish: a `command` invoke that
// rejected was swallowed (the `send` arm `void`s the promise; the `invoke` arm's
// rejection was eaten by ipc-client's `invokeOrDefault` catch). A rejected
// download / model-state / settings-save then looked identical to "no value" —
// exactly how the "download stuck at 0% / RAM unknown" bugs shipped unreported.
//
// For a `send` (fire-and-forget) on a critical channel we cannot return a
// rejected promise to the caller, so we at least log the rejection LOUDLY here.
// For an `invoke` the rejection propagates to ipc-client, which re-surfaces it
// for critical channels (see CRITICAL_REJECT_CHANNELS / CRITICAL_LOG_ONLY_CHANNELS
// there).
const CRITICAL_SEND_CHANNELS: ReadonlySet<string> = new Set([
	IPC.STT_RELOAD_MODEL, // model swap (sent, not invoked) — a failed swap must not be silent
	IPC.SETTINGS_SAVE, // persisting settings (sent) — a write failure must surface
]);

// ── Install ──────────────────────────────────────────────────────────────────
let installed = false;

/**
 * Install the `window.nativeBridge` polyfill. SYNCHRONOUS + idempotent so it
 * runs before React's first render fires the IPC hooks. No-ops outside a
 * browser context.
 */
export function installNativeBridge(): void {
	if (installed || typeof window === "undefined") {
		return;
	}
	installed = true;

	void wireDragDrop();

	const api: Window["nativeBridge"] = {
		getPathForFile: (file: File) => fileToTauriPath(file),

		send(channel: string, ...args: unknown[]): void {
			const route = ROUTE[channel];
			if (!route) {
				// An unmapped send is a renamed/deleted command (a real wiring bug),
				// not a benign no-op — surface it as an ERROR. (See the invoke arm.)
				console.error(`[ipc-adapter] unmapped send channel "${channel}" — dropped`);
				return;
			}
			if (route.kind === "command") {
				const call = core.invoke(route.cmd, { ...normalizeArgs(channel, args), ...route.inject });
				if (CRITICAL_SEND_CHANNELS.has(channel)) {
					// Fire-and-forget, but a rejected critical write must not vanish —
					// log it loudly so the failed swap / save is diagnosable instead of
					// looking like a no-op. (Non-critical sends stay quiet/tolerant.)
					void call.catch((err) => {
						console.error(
							`[ipc-adapter] critical send "${channel}" → command "${route.cmd}" failed:`,
							err
						);
					});
				} else {
					void call;
				}
			} else if (route.kind === "window") {
				void windowOp(route.op, args);
			} else if (route.kind === "plugin") {
				void callPlugin(route.plugin, args[0]);
			}
			// event/noop: nothing to do for a send.
		},

		invoke(channel: string, ...args: unknown[]): Promise<unknown> {
			const route = ROUTE[channel];
			if (!route) {
				// An unmapped invoke channel is NOT "no value" — it's a renamed or
				// deleted backend command (a real wiring bug, the class behind the
				// "download 0% / RAM unknown" silent failures). Log it as an ERROR so
				// it can't hide in warn noise. We still resolve undefined (the caller's
				// `invokeOrDefault` then supplies its fallback) so a single dead channel
				// can't crash the renderer; the route-coverage test is the real guard.
				console.error(`[ipc-adapter] unmapped invoke channel "${channel}" — resolving undefined`);
				return Promise.resolve(undefined);
			}
			if (route.kind === "command") {
				return core.invoke(route.cmd, { ...normalizeArgs(channel, args), ...route.inject });
			}
			if (route.kind === "window") {
				return windowOp(route.op, args);
			}
			if (route.kind === "plugin") {
				return callPlugin(route.plugin, args[0]);
			}
			// STT_IS_CONNECTED / server-ready / server-status shims (WU-13 connect-server):
			// the STT engine is in-proc in Tauri (no external server process), so the
			// connection is permanently "connected" and the recorder is "ready". This
			// flips ConnectionIndicator straight to the green GPU/CPU chip on boot.
			if (channel === IPC.STT_IS_CONNECTED || channel === IPC.STT_GET_SERVER_READY) {
				return Promise.resolve(true);
			}
			if (channel === IPC.STT_SERVER_GET_STATUS) {
				return Promise.resolve("running");
			}
			return Promise.resolve(undefined);
		},

		secureInvoke(channel: string, payload?: unknown): Promise<unknown> {
			// Encryption dropped — Tauri IPC is process-isolated. Route exactly like invoke.
			const route = ROUTE[channel];
			if (!route) {
				return Promise.resolve(undefined);
			}
			if (route.kind === "plugin") {
				return callPlugin(route.plugin, payload);
			}
			if (route.kind === "command") {
				return core.invoke(route.cmd, (payload ?? {}) as Record<string, unknown>);
			}
			return Promise.resolve(undefined);
		},

		on(channel: string, callback: (...args: unknown[]) => void): () => void {
			const route = ROUTE[channel];
			if (!route || route.kind !== "event") {
				return () => {
					/* no event source for this channel */
				};
			}
			const unlistenPromise = evt.listen(route.event, (e) => {
				if (shouldDeliver(channel, e.payload)) {
					callback(reshape(channel, e.payload));
				}
			});
			// ipc-client.ts expects a SYNCHRONOUS unsubscribe.
			return () => {
				void unlistenPromise.then((un) => un());
			};
		},
	};

	window.nativeBridge = api;
}
