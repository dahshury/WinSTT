// Renderer-to-Tauri bridge. It installs a
// `window.nativeBridge` polyfill backed by `@tauri-apps/api` so the entire
// ~401-file WinSTT renderer (and `ipc-client.ts` itself) runs VERBATIM. Every
// `nativeBridge.{send,invoke,secureInvoke,on,getPathForFile}` call routes either
// through typed `COMMAND_INVOKERS` in `ipc-transport.ts` (EVERY renderer→main
// command — each entry calls a generated `commands.*` binding) or through the
// ROUTE table below for the remaining event/plugin/window/noop cases:
//   - a Tauri event      (listen(event, cb))
//   - a window op        (getCurrentWindow().minimize() …)
//   - a Tauri plugin     (dialog / clipboard / os / opener / updater / autostart)
//   - a polyfill / noop  (no backend, shimmed locally)
//
// There is no longer a `kind:"command"` ROUTE variant — type-safe command
// routing lives entirely in `COMMAND_INVOKERS`. The plugin/window routes that DO
// reach a backend command (updater, custom-models, diag, quit) invoke it through
// the generated `commands.*` bindings (`@/bindings`); there are NO untyped
// `invoke("string")` calls left in this file (the typed-IPC invariant).
//
// Encryption (secureInvoke) collapses to plain invoke: Tauri's IPC is already
// process-isolated, so the reference secure channel has no analogue.
//
// install() is idempotent and is centralized in `app/layouts/HtmlLang`, which is
// mounted by every window entry. Channels that are NOT in ROUTE log a single
// warning and resolve to `undefined` (the renderer's `invokeOrDefault` then
// supplies its declared fallback).

import { listen as tauriListen } from "@tauri-apps/api/event";
import { hasTauriRuntime } from "@/shared/lib/tauri-runtime";
import {
	callPlugin,
	type PluginTarget,
	windowOp,
	type WindowOp,
} from "./adapter/plugins";
import { fileToTauriPath, wireDragDrop } from "./adapter/drag-drop";
import { checkAndDownloadUpdate } from "./adapter/updater";
import { IPC } from "./ipc-channels";

// `@tauri-apps/api/event` is statically imported so `install()` can run
// SYNCHRONOUSLY (before React's first render fires the IPC hooks). The heavy
// plugins (dialog/clipboard/os/updater/…) stay dynamic in callPlugin().
//
// Renderer→main commands route through generated `commands.*` (`@/bindings`)
// per the adapter's typed-IPC invariant — there is no untyped `invoke(string)`
// here. The remaining string transport is event LISTENING (`evt.listen`).
const evt = {
	listen: (event: string, handler: (e: { payload: unknown }) => void) =>
		tauriListen<unknown>(event, handler),
};

// ── Route kinds ───────────────────────────────────────────────────────────────
// `WindowOp` / `PluginTarget` are defined alongside their dispatch in
// `./adapter/plugins`; the `Route` discriminated union below references them.
//
// Every renderer→main COMMAND now routes through the typed COMMAND_INVOKERS map
// in `ipc-transport.ts` (each entry calls a generated `commands.*` binding), so
// the adapter ROUTE table carries only event / window-op / plugin / noop kinds —
// there is no longer a `kind:"command"` variant.
type Route =
	| { kind: "event"; event: string }
	| { kind: "window"; op: WindowOp }
	| { kind: "plugin"; plugin: PluginTarget }
	| { kind: "noop" };

// ── The ROUTE table: WinSTT channel → Tauri target ─────────────────────────────
// Grounded in `frontend/src/shared/api/ipc-channels.ts` (IPC + IPC_DIRECTIONS)
// and the §1b/§3 mapping. Commands marked ⚠MISSING in the plan still route to a
// command name here; the backend command is filed under the owning slice's WU.
const ROUTE: Partial<Record<string, Route>> = {
	// ── STT shims and overlay controls ──
	[IPC.STT_IS_CONNECTED]: { kind: "noop" }, // engine in-proc → always-connected shim (returns false → ipc-client default; overridden in install)
	[IPC.OVERLAY_SET_IGNORE_MOUSE]: { kind: "window", op: "ignore-mouse" },
	[IPC.STT_GET_SERVER_READY]: { kind: "noop" },

	// ── STT events (main → renderer) ──
	[IPC.STT_REALTIME_TEXT]: { kind: "event", event: "realtime:update" },
	[IPC.STT_FULL_SENTENCE]: { kind: "event", event: "stt:full-sentence" },
	[IPC.STT_NO_AUDIO_DETECTED]: {
		kind: "event",
		event: "stt:no-audio-detected",
	},
	[IPC.STT_TRANSCRIPTION_FAILED]: {
		kind: "event",
		event: "stt:transcription-failed",
	},
	[IPC.STT_RECORDING_START]: { kind: "event", event: "stt:recording-start" },
	[IPC.STT_CAPTURE_ACTIVE]: { kind: "event", event: "stt:capture-active" },
	[IPC.STT_RECORDING_STOP]: { kind: "event", event: "stt:recording-stop" },
	[IPC.STT_VAD_START]: { kind: "event", event: "stt:vad-start" },
	[IPC.STT_VAD_STOP]: { kind: "event", event: "stt:vad-stop" },
	[IPC.STT_TRANSCRIPTION_START]: {
		kind: "event",
		event: "stt:transcription-start",
	},
	[IPC.STT_CONNECTION_CHANGE]: {
		kind: "event",
		event: "stt:connection-change",
	},
	[IPC.STT_SERVER_STATUS]: { kind: "event", event: "stt:server-status" },
	[IPC.STT_SESSION_ABORTED]: { kind: "event", event: "stt:session-aborted" },
	[IPC.STT_AUDIO_LEVEL]: { kind: "event", event: "stt:audio-level" },
	[IPC.STT_WAKEWORD_DETECTED]: { kind: "event", event: "wakeword:detected" },
	[IPC.STT_WAKEWORD_DETECTION_START]: {
		kind: "event",
		event: "stt:wakeword-detection-start",
	},
	[IPC.STT_WAKEWORD_DETECTION_END]: {
		kind: "event",
		event: "stt:wakeword-detection-end",
	},
	// WAKEWORD_*_MODEL_DOWNLOAD / GET_MODEL_STATUS commands are typed in
	// COMMAND_INVOKERS (ipc-transport.ts) — the invoker wins, so the redundant
	// `command` routes were removed. The model-status EVENT route stays.
	[IPC.WAKEWORD_MODEL_STATUS]: {
		kind: "event",
		event: "wakeword:model-status",
	},

	// ── Model catalog / picker / download (slices 01/03) ──
	[IPC.STT_MODEL_CATALOG]: { kind: "event", event: "stt:model-catalog" },
	[IPC.STT_RUNTIME_INFO]: { kind: "event", event: "stt:runtime-info" },
	[IPC.STT_MODEL_DOWNLOAD_START]: {
		kind: "event",
		event: "stt:model-download-start",
	},
	[IPC.STT_MODEL_DOWNLOAD_PROGRESS]: {
		kind: "event",
		event: "stt:model-download-progress",
	},
	[IPC.STT_MODEL_DOWNLOAD_COMPLETE]: {
		kind: "event",
		event: "stt:model-download-complete",
	},
	[IPC.STT_MODEL_DOWNLOAD_PAUSED]: {
		kind: "event",
		event: "stt:model-download-paused",
	},
	[IPC.STT_MODEL_CACHE_CHANGED]: {
		kind: "event",
		event: "stt:model-cache-changed",
	},
	[IPC.STT_MODEL_SWAP_STARTED]: {
		kind: "event",
		event: "stt:model-swap-started",
	},
	[IPC.STT_MODEL_SWAP_COMPLETED]: {
		kind: "event",
		event: "stt:model-swap-completed",
	},
	[IPC.STT_MODEL_SWAP_FAILED]: {
		kind: "event",
		event: "stt:model-swap-failed",
	},
	[IPC.STT_DIARIZATION_TOGGLE_STARTED]: {
		kind: "event",
		event: "stt:diarization-toggle-started",
	},
	[IPC.STT_DIARIZATION_TOGGLE_COMPLETED]: {
		kind: "event",
		event: "stt:diarization-toggle-completed",
	},
	[IPC.STT_DIARIZATION_TOGGLE_FAILED]: {
		kind: "event",
		event: "stt:diarization-toggle-failed",
	},

	// ── Settings ──
	[IPC.SETTINGS_CHANGED]: { kind: "event", event: "settings:changed" },
	[IPC.SETTINGS_SAVE_ERROR]: { kind: "event", event: "settings:save-error" },

	// ── Hotkey ──
	[IPC.HOTKEY_PRESSED]: { kind: "event", event: "hotkey:pressed" },
	[IPC.HOTKEY_RELEASED]: { kind: "event", event: "hotkey:released" },
	[IPC.HOTKEY_RECORDING_UPDATE]: {
		kind: "event",
		event: "hotkey:recording-update",
	},
	[IPC.HOTKEY_RECORDING_DONE]: {
		kind: "event",
		event: "hotkey:recording-done",
	},

	// ── System ──
	[IPC.AUTOSTART_SET]: { kind: "plugin", plugin: "autostart:set" },
	[IPC.AUTOSTART_GET]: { kind: "plugin", plugin: "autostart:get" },
	[IPC.AUDIO_DEVICES_CHANGED]: {
		kind: "event",
		event: "audio:devices-changed",
	},
	[IPC.AUDIO_DEVICECHANGE_DETECTED]: {
		kind: "event",
		event: "audio:devicechange-detected",
	},
	[IPC.AUDIO_OUTPUT_DEVICES_CHANGED]: {
		kind: "event",
		event: "audio:output-devices-changed",
	},
	[IPC.AUDIO_MICROPHONE_LEVELS]: {
		kind: "event",
		event: "audio:microphone-levels",
	},
	[IPC.APP_GET_SYSTEM_LOCALE]: { kind: "plugin", plugin: "os:locale" },

	// ── Window controls / navigation ──
	[IPC.WINDOW_MINIMIZE]: { kind: "window", op: "minimize" },
	[IPC.WINDOW_MAXIMIZE]: { kind: "window", op: "maximize" },
	[IPC.WINDOW_CLOSE]: { kind: "window", op: "hide" },
	// WINDOW_CLOSE_SELF (`close_self_window`) and WINDOW_SHOW
	// (`show_main_window_command`) are typed in COMMAND_INVOKERS. CLOSE_SELF lets
	// the Settings modal re-enable the main pill as it closes (a renderer `.hide()`
	// never reaches Rust); WINDOW_SHOW targets the MAIN window explicitly (not the
	// tray-menu caller) and force-raises it.
	[IPC.WINDOW_QUIT]: { kind: "window", op: "quit" },
	// WINDOW_OPEN_SETTINGS / MODEL_PICKER_OPEN|CLOSE|RESIZE are typed in
	// COMMAND_INVOKERS (they call `open_window`/`close_window`/`resize_window`
	// with the window label as the first positional arg). SETTINGS_WINDOW_READY
	// is typed there too. Only the picker placement EVENTS stay on the adapter.
	[IPC.MODEL_PICKER_ANCHOR]: { kind: "event", event: "model-picker:anchor" },
	[IPC.MODEL_PICKER_CLOSING]: { kind: "event", event: "model-picker:closing" },
	// DEVICE_PICKER_* and TRAY_MENU_* command channels were RETIRED — the only
	// renderer callers go through the typed `windowCloseNamed`/`windowResizeNamed`
	// wrappers (shared/api/ipc/stt-audio.ts → `commands.closeWindow`/`resizeWindow`),
	// so the string-channel routes had zero callers and the channels are gone.
	// ONBOARDING_FINISH is typed in COMMAND_INVOKERS.

	// ── Context-awareness playground (debug-only) ──
	// CONTEXT_PLAYGROUND_OPEN/CLOSE/SET_LIVE/ARM_DEEP command channels were
	// RETIRED — the view calls `windowOpenContextPlayground`/`windowCloseNamed`/
	// `contextPlaygroundSetLive`/`contextPlaygroundArmDeep` (typed `commands.*`
	// wrappers) directly, so nothing routed through these. Only the push REPORT
	// event stays on the adapter.
	[IPC.CONTEXT_PLAYGROUND_REPORT]: {
		kind: "event",
		event: "context-playground:report",
	},

	// ── Dialog / clipboard / menus ──
	[IPC.DIALOG_OPEN_FILE]: { kind: "plugin", plugin: "dialog:open" },
	[IPC.CLIPBOARD_OPERATE]: { kind: "plugin", plugin: "clipboard:operate" },

	// ── TTS (slice 06) ──
	[IPC.TTS_STARTED]: { kind: "event", event: "tts:started" },
	[IPC.TTS_CHUNK]: { kind: "event", event: "tts:chunk" },
	[IPC.TTS_COMPLETED]: { kind: "event", event: "tts:completed" },
	[IPC.TTS_FAILED]: { kind: "event", event: "tts:failed" },
	[IPC.TTS_PLAYBACK_STARTED]: { kind: "event", event: "tts:playback-started" },
	[IPC.TTS_PLAYBACK_ENDED]: { kind: "event", event: "tts:playback-ended" },
	[IPC.TTS_PAUSE_PLAYBACK]: { kind: "event", event: "tts:pause-playback" },
	[IPC.TTS_RESUME_PLAYBACK]: { kind: "event", event: "tts:resume-playback" },
	[IPC.TTS_DISCARD_PLAYBACK]: {
		kind: "event",
		event: "tts:discard-playback",
	},
	[IPC.TTS_MODEL_DOWNLOAD_START]: {
		kind: "event",
		event: "tts:model-download-start",
	},
	[IPC.TTS_MODEL_DOWNLOAD_PROGRESS]: {
		kind: "event",
		event: "tts:model-download-progress",
	},
	[IPC.TTS_MODEL_DOWNLOAD_COMPLETE]: {
		kind: "event",
		event: "tts:model-download-complete",
	},
	[IPC.TTS_INSTALL_STATUS]: { kind: "event", event: "tts:install-status" },
	[IPC.TTS_INSTALL_FAILED]: { kind: "event", event: "tts:install-failed" },
	[IPC.TTS_INSTALL_PAUSED]: { kind: "event", event: "tts:install-paused" },
	[IPC.TTS_INSTALL_RESUMED]: { kind: "event", event: "tts:install-resumed" },
	// ── Multi-provider TTS catalog (model-aware picker) ──
	[IPC.TTS_CATALOG_MODEL_DOWNLOAD_PROGRESS]: {
		kind: "event",
		event: "tts:catalog-model-download-progress",
	},
	[IPC.TTS_CATALOG_MODEL_DOWNLOAD_COMPLETE]: {
		kind: "event",
		event: "tts:catalog-model-download-complete",
	},
	[IPC.TTS_CATALOG_MODEL_CACHE_CHANGED]: {
		kind: "event",
		event: "tts:model-cache-changed",
	},

	// ── LLM / Ollama / OpenRouter (slice 07) ──
	// INTEGRATIONS_VERIFY (`verify_credential`) is typed in COMMAND_INVOKERS.
	[IPC.LLM_CATALOG]: { kind: "event", event: "llm:catalog" },
	[IPC.LLM_PULL_PROGRESS]: { kind: "event", event: "llm:pull-progress" },
	[IPC.LLM_PROCESSING_START]: { kind: "event", event: "llm:processing-start" },
	[IPC.LLM_PROCESSING_END]: { kind: "event", event: "llm:processing-end" },
	[IPC.LLM_REASONING_DELTA]: { kind: "event", event: "llm:reasoning-delta" },
	[IPC.LLM_LEARNED_PROPER_NOUNS]: {
		kind: "event",
		event: "llm:learned-proper-nouns",
	},
	[IPC.LLM_WARMUP_STATUS]: { kind: "event", event: "llm:warmup-status" },

	// ── Transforms (slice 13) ──
	// Transform commands are typed in COMMAND_INVOKERS; the adapter keeps the
	// broadcast events for every window.
	[IPC.TRANSFORMS_APPLIED]: { kind: "event", event: "transforms:applied" },
	[IPC.TRANSFORMS_FAILED]: { kind: "event", event: "transforms:failed" },
	[IPC.TRANSFORMS_PROCESSING_START]: {
		kind: "event",
		event: "transforms:processing-start",
	},
	[IPC.TRANSFORMS_PROCESSING_END]: {
		kind: "event",
		event: "transforms:processing-end",
	},
	[IPC.TRANSFORM_HISTORY_ADDED]: {
		kind: "event",
		event: "transform-history:added",
	},
	[IPC.TRANSFORM_HISTORY_DELETED]: {
		kind: "event",
		event: "transform-history:deleted",
	},

	// Preview commands are typed in COMMAND_INVOKERS; the adapter keeps the
	// finalized transcript event.
	[IPC.STT_PREVIEW_READY]: { kind: "event", event: "stt:preview-ready" },

	// ── Cloud STT (slice 07) — the 5 error channels fan out from one event ──
	[IPC.STT_CLOUD_AUTH_FAILED]: { kind: "event", event: "stt:cloud-error" },
	[IPC.STT_CLOUD_NETWORK_ERROR]: { kind: "event", event: "stt:cloud-error" },
	[IPC.STT_CLOUD_KEY_MISSING]: { kind: "event", event: "stt:cloud-error" },
	[IPC.STT_CLOUD_RATE_LIMITED]: { kind: "event", event: "stt:cloud-error" },
	[IPC.STT_CLOUD_PROVIDER_ERROR]: { kind: "event", event: "stt:cloud-error" },
	[IPC.CLOUD_CONNECTIVITY]: { kind: "event", event: "cloud:connectivity" },

	// ── File transcription (slice 07/08) ──
	[IPC.FILE_TRANSCRIPTION_PROGRESS]: {
		kind: "event",
		event: "file:transcription-progress",
	},
	[IPC.FILE_TRANSCRIPTION_COMPLETE]: {
		kind: "event",
		event: "file:transcription-complete",
	},
	[IPC.FILE_TRANSCRIPTION_ERROR]: {
		kind: "event",
		event: "file:transcription-error",
	},
	[IPC.FILE_QUEUE_UPDATE]: { kind: "event", event: "file:queue-update" },
	[IPC.FILE_QUEUE_PROGRESS]: { kind: "event", event: "file:queue-progress" },
	[IPC.FILE_QUEUE_ACTIVE]: { kind: "event", event: "file:queue-active" },

	// ── Loopback / listen / diarization (slice 09) ──
	[IPC.STT_LOOPBACK_STARTED]: { kind: "event", event: "stt:loopback-started" },
	[IPC.STT_LOOPBACK_STOPPED]: { kind: "event", event: "stt:loopback-stopped" },
	[IPC.STT_DEVICE_SWITCH_FAILED]: {
		kind: "event",
		event: "stt:device-switch-failed",
	},
	[IPC.LID_CLOSED]: { kind: "event", event: "lid:closed" },
	[IPC.LID_OPENED]: { kind: "event", event: "lid:opened" },

	// ── Sound (slice 05/11) ──
	[IPC.SOUND_PLAY]: { kind: "event", event: "sound:play" },

	// ── History (slice 10) ──
	// Legacy string-id history commands are typed in COMMAND_INVOKERS.
	// HISTORY_LIST / DELETE_ROW / TOGGLE / LOAD_AUDIO_BY_ROW are typed there too.
	[IPC.HISTORY_ADDED]: { kind: "event", event: "history:added" },
	[IPC.HISTORY_DELETED]: { kind: "event", event: "history:deleted" },
	[IPC.HISTORY_ROW_ADDED]: { kind: "event", event: "history:row-added" },
	[IPC.HISTORY_ROW_DELETED]: { kind: "event", event: "history:row-deleted" },
	[IPC.HISTORY_ROW_TOGGLED]: { kind: "event", event: "history:row-toggled" },

	// TRANSCRIPT_COPY_LAST / DIAG_SAVE_BUNDLE / DIAG_WEBVIEW_LOG /
	// ABOUT_GET_APP_INFO are RETIRED — their wrappers call `commands.*` directly.

	// ── Diagnostics / custom models (plugin routes stay on the adapter) ──
	[IPC.DIAG_OPEN_LOGS_FOLDER]: { kind: "plugin", plugin: "opener:logs" },
	[IPC.CUSTOM_MODELS_OPEN_FOLDER]: {
		kind: "plugin",
		plugin: "opener:custom-models",
	},

	// ── Updater (secure → plugin) ──
	[IPC.UPDATER_GET_STATUS_HISTORY]: {
		kind: "plugin",
		plugin: "updater:status-history",
	},
	[IPC.UPDATER_CLEAR_STATUS_HISTORY]: {
		kind: "plugin",
		plugin: "updater:clear-status-history",
	},
	[IPC.UPDATER_CHECK_NOW]: { kind: "plugin", plugin: "updater:check-now" },
	[IPC.UPDATER_QUIT_AND_INSTALL]: {
		kind: "plugin",
		plugin: "updater:quit-and-install",
	},
	[IPC.UPDATER_STATUS]: { kind: "event", event: "updater:status" },
};

// ── Event payload reshape ──────────────────────────────────────────────────────
// Most §4b plain events are byte-identical to WinSTT's IPC shape (identity).
// The exceptions: wake-word (Tauri `WakeWordDetectedPayload` → `{}`/word),
// realtime:update (`{text}` already), and the cloud-error fan-out (one event,
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
	if (
		channel === IPC.STT_WAKEWORD_DETECTED &&
		payload !== null &&
		typeof payload === "object"
	) {
		const p = payload as { word?: string; keyword?: string };
		return { word: p.word ?? p.keyword ?? "" };
	}
	// TTS chunk: the backend emits `pcm` as a serde `Vec<u8>`, which Tauri's JSON
	// event bridge delivers as a plain `number[]` of byte values — NOT the binary
	// `ArrayBuffer` that the renderer's `TtsChunkPayload.pcm: ArrayBuffer` type +
	// playback-queue assume.
	// The playback path does `new Float32Array(pcm)` (f32le) / `decodeAudioData(pcm)`
	// (mp3); both REQUIRE a real ArrayBuffer. Handed a raw `number[]`, `Float32Array`
	// reads each *byte* as a float (0–255) → 4× the samples, all far outside [-1,1],
	// which `copyToChannel` hard-clips to ±1 = full-scale high-frequency NOISE (and
	// `decodeAudioData` would reject it outright). Normalize to an ArrayBuffer here at
	// the port boundary so the rest of the renderer stays the same shape.
	if (
		channel === IPC.TTS_CHUNK &&
		payload !== null &&
		typeof payload === "object"
	) {
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

// ── Updater check trigger ────────────────────────────────────────────────────
// The updater facade (`checkAndDownloadUpdate` / `installPendingUpdateAndRelaunch`)
// lives in `./adapter/updater`. This wiring listens for the backend's
// `updater:check` event and drives the facade. The `evt.listen("updater:check")`
// literal stays in this file so the emit-coverage guard sees the frontend listener
// for the canonical `UPDATER_CHECK` backend event.
async function wireUpdaterCheckTrigger(): Promise<void> {
	try {
		await evt.listen("updater:check", () => {
			void checkAndDownloadUpdate();
		});
	} catch {
		// Not in a Tauri window context.
	}
}

// ── Install ──────────────────────────────────────────────────────────────────
let installed = false;

/**
 * Install the `window.nativeBridge` polyfill. SYNCHRONOUS + idempotent so it
 * runs before React's first render fires the IPC hooks. No-ops outside a
 * browser context or a real Tauri webview; plain Vite/browser mode relies on
 * ipc-client fallbacks plus the dev settings bridge instead.
 */
export function installNativeBridge(): void {
	if (installed || typeof window === "undefined") {
		return;
	}
	if (!hasTauriRuntime()) {
		return;
	}
	installed = true;

	void wireDragDrop();
	void wireUpdaterCheckTrigger();

	const api: Window["nativeBridge"] = {
		getPathForFile: (file: File) => fileToTauriPath(file),

		send(channel: string, ...args: unknown[]): void {
			const route = ROUTE[channel];
			if (!route) {
				// An unmapped send is a renamed/deleted command (a real wiring bug),
				// not a benign no-op — surface it as an ERROR. (See the invoke arm.)
				// Commands no longer reach the adapter `send` (they route through the
				// typed COMMAND_INVOKERS in ipc-transport before this point); only
				// window-op / plugin sends do.
				console.error(
					`[ipc-adapter] unmapped send channel "${channel}" — dropped`,
				);
				return;
			}
			if (route.kind === "window") {
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
				console.error(
					`[ipc-adapter] unmapped invoke channel "${channel}" — resolving undefined`,
				);
				return Promise.resolve(undefined);
			}
			if (route.kind === "window") {
				return windowOp(route.op, args);
			}
			if (route.kind === "plugin") {
				return callPlugin(route.plugin, args[0]);
			}
			// STT_IS_CONNECTED / server-ready shims (WU-13 connect-server):
			// the STT engine is in-proc in Tauri (no external server process), so the
			// connection is permanently "connected" and the recorder is "ready". This
			// flips ConnectionIndicator straight to the green GPU/CPU chip on boot.
			if (
				channel === IPC.STT_IS_CONNECTED ||
				channel === IPC.STT_GET_SERVER_READY
			) {
				return Promise.resolve(true);
			}
			return Promise.resolve(undefined);
		},

		secureInvoke(channel: string, payload?: unknown): Promise<unknown> {
			// Encryption dropped — Tauri IPC is process-isolated. The only secure
			// channels left (clipboard / updater) are plugin routes; commands route
			// through the typed COMMAND_INVOKERS before reaching the adapter.
			const route = ROUTE[channel];
			if (route?.kind === "plugin") {
				return callPlugin(route.plugin, payload);
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
