# 10_frontend_port_plan.md — porting WinSTT's Electron+React renderer into the Tauri app

> **Status:** plan, not yet applied. The Tauri Rust backend compiles (commands in
> `app/src-tauri/src/winstt/commands/*.rs`; registration map in `app/PORT/lib_wiring.md`). This
> document plans the **renderer** port: lift the WinSTT React renderer (`frontend/src/`, the 8 HTML
> entries, the `packages/model-picker` workspace) into `app/` and drive it from the Tauri backend
> instead of Electron IPC.
>
> **The single biggest finding:** the WinSTT renderer never calls `window.electronAPI` directly
> except in **one file** — `frontend/src/shared/api/ipc-client.ts`. Every feature/widget/view/entity
> imports typed wrappers (`sttSetParameter`, `onFullSentence`, `listTtsVoices`, …) from that file.
> So the entire `electronAPI` → Tauri translation collapses into **one of two interchangeable
> moves**: (A) ship a `window.electronAPI` polyfill backed by `@tauri-apps/api`, OR (B) rewrite the
> 5 transport primitives at the top of `ipc-client.ts`. Either makes ~99% of the 392-file renderer
> run unchanged. We choose **(A) the polyfill** (zero renderer edits, smaller diff vs. the Handy
> upstream, lets `ipc-client.ts` itself port verbatim) with (B) as the fallback if the secure-IPC
> path proves awkward.

---

## 0. Source-of-truth inventory (what we are moving)

### 0a. Renderer size (real counts, `frontend/src/`)

| FSD layer | Non-test files | Notes |
|---|---|---|
| `app/` | 6 | providers (Intl, ErrorBoundary, **IpcProvider**), layouts (TitleBar, HtmlLang, RootLayout), styles (globals.css, fonts.css) |
| `views/` | 25 | 9 slices = 9 windows: `main`, `settings`, `overlay`, `tray-menu`, `model-picker`, `device-picker`, `onboarding`, `history`, `context-playground` |
| `widgets/` | 82 | 18 widget slices (settings panels: about/audio/dictionary/general/integrations/llm/model/quality/snippets/tts/history; status-bar; tray-menu; pickers; onboarding-wizard; ollama-model-manager) |
| `features/` | 100 | 24 feature slices (push-to-talk, swap-model, model-download, live-transcription, listen-mode, file-transcription, llm-processing, vad-calibration, verify-credentials, recording-sound, transforms, …) |
| `entities/` | 48 | 10 entity slices (setting, model-catalog, transcription, transcription-history, audio-device, connection, llm-catalog, system-resources, cloud-stt-credential, cloud-stt-provider) |
| `shared/` | 131 | `api/` (ipc-channels.ts, **ipc-client.ts**, models.ts, schemas, codecs), `ui/` (Base UI primitives), `config/` (settings-schema.ts, debug-flags.ts), `lib/`, `i18n/` |
| `entries/` | 9 | one `.tsx` per HTML window — `createRoot().render(<View/>)` |
| **Total** | **~401** | + `packages/model-picker/` (detached workspace, ~40 files) |

### 0b. The 9 windows (HTML entry → entry tsx → view slice)

`frontend/index.html` + `frontend/windows/*.html` (8 secondary). Each `windows/<x>.html` has a
`<div id="root">` and `<script type="module" src="/src/entries/<x>.tsx">`. The entry tsx mounts the
view under `IntlProvider` + `Tooltip.Provider` (+ `HtmlLang`). Window properties below are from
`frontend/electron/main.ts` + the `electron/ipc/*-window.ts` creators:

| Window | HTML entry | Entry tsx | View slice | Size / chrome (from Electron) |
|---|---|---|---|---|
| **main** | `index.html` | `entries/main.tsx` | `views/main` | 420×150, `frame:false`, not resizable |
| **settings** | `windows/settings.html` | `entries/settings.tsx` | `views/settings` | 700×560, `frame:false`, not resizable |
| **overlay** | `windows/overlay.html` | `entries/overlay.tsx` | `views/overlay` | 720×240, `transparent`, `frame:false`, `alwaysOnTop`, `skipTaskbar`, `hasShadow:false`, click-through |
| **tray-menu** | `windows/tray-menu.html` | `entries/tray-menu.tsx` | `views/tray-menu` | dynamic resize, `frame:false`, `transparent`, `alwaysOnTop`, `skipTaskbar` |
| **model-picker** | `windows/model-picker.html` | `entries/model-picker.tsx` | `views/model-picker` | full-screen transparent backdrop + anchored panel, `transparent`, `frame:false`, `alwaysOnTop` |
| **device-picker** | `windows/device-picker.html` | `entries/device-picker.tsx` | `views/device-picker` | 320×360, `transparent`, `frame:false`, `alwaysOnTop`, `skipTaskbar` |
| **onboarding** | `windows/onboarding.html` | `entries/onboarding.tsx` | `views/onboarding` | wizard window, `frame:false` |
| **history** | `windows/history.html` | `entries/history.tsx` | `views/history` | history table window |
| **context-playground** | `windows/context-playground.html` | `entries/context-playground.tsx` | `views/context-playground` | DEBUG-ONLY (`CONTEXT_PLAYGROUND_ENABLED`); ship HTML, never open in prod |

Handy's Tauri app today has **2 windows**: `main` (created programmatically in `lib.rs setup`,
680×570) + `recording_overlay` (created on demand in `overlay.rs`, `src/overlay/index.html`). The
port replaces Handy's 2-window topology with WinSTT's 9-window topology (§4).

### 0c. The model-picker workspace (`frontend/packages/model-picker/`)

`@winstt/model-picker` — a self-contained, publishable workspace (peerDeps: react≥19, @base-ui/react,
@hugeicons/*, virtua, fuse.js; NO `@/shared/*` coupling — consumer supplies `t(key)` + model shapes
via props). `src/` segments: `core/` (ModelPicker, GroupRail), `stt/` (ui + lib: SttModelSelector,
SttModelCard, SttModelList, family-helpers), `ollama/` (OllamaModelSelector), `lib/` (provider-icons,
filters), `ui/` (ModelFiltersMenu, OpenRouterModelSelector, ModelListContentVirtualized), `model/`,
`config/`, `vendor/` (vendored Badge/Tooltip/cn so it has no `@/shared` import). Consumed by
`views/model-picker` + `widgets/model-picker-window` + `features/llm-model-picker`. Ports verbatim as
a workspace; only its `package.json` peerDep host changes.

### 0d. Renderer runtime deps (`frontend/package.json` → must land in `app/package.json`)

`@ai-sdk/elevenlabs`, `@ai-sdk/openai`, `@openrouter/ai-sdk-provider`, `ai` (Vercel AI SDK v6) —
**these are USED IN ELECTRON-MAIN, not the renderer.** The renderer holds no API keys and makes no
AI-SDK calls (CLAUDE.md §10). In the Tauri port these become **Rust** (`llm_client.rs` + `07_*`
slice). So they do NOT move to the renderer. Renderer-only runtime deps that DO move:

`@base-ui/react`, `@hugeicons/react`, `@hugeicons/core-free-icons`, `react`/`react-dom` (**19**),
`use-intl`, `zustand`, `virtua`, `zod` (**4**), `motion`, `class-variance-authority`, `clsx`,
`tailwind-merge`, `double-metaphone`, `fuse.js` (transitively, via model-picker — present in
optimizeDeps), and dev: `@tailwindcss/vite`, `@vitejs/plugin-react`, `babel-plugin-react-compiler`,
`@rolldown/plugin-babel`, `tailwindcss`. See §5 for the reconciliation table.

---

## 1. The IPC contract (every `electronAPI.*` call) — and its Tauri mapping

### 1a. The transport surface is 5 primitives (the whole adapter)

`frontend/electron/preload.ts` exposes exactly six methods on `window.electronAPI`:

| Method | Signature | Used by | Tauri equivalent |
|---|---|---|---|
| `send(channel, ...args)` | fire-and-forget renderer→main | `ipc-client.ts` `send()` | `invoke(cmd, args)` (ignore result) |
| `invoke(channel, ...args)` | request/response → `Promise` | `ipc-client.ts` `invoke()` | `invoke(cmd, args)` |
| `secureInvoke(channel, payload)` | encrypted request/response | `ipc-client.ts` `invokeSecure()` | `invoke(cmd, args)` — **encryption is an Electron-only concern; drop the crypto, keep the call** |
| `on(channel, cb)` → unsubscribe | main→renderer push | `ipc-client.ts` `on()` | `listen(event, e => cb(e.payload))` → returns an unlisten promise |
| `getPathForFile(file)` | File→native path | `ipc-client.ts` `getFilePath()` | Tauri drag-drop event gives the path directly; or `webkitGetAsEntry`. **Shim** |

The `channelsByDirection`/`IPC_DIRECTIONS` allowlist machinery in `preload.ts` is an Electron
sandbox concern — the polyfill ignores it (Tauri capabilities are the equivalent gate). So the
adapter is: **map each `IPC.*` string constant to a Tauri command/event name**, route `send`/`invoke`
to `invoke()`, and `on` to `listen()`.

### 1b. Channel → Tauri command/event mapping

`ipc-channels.ts` defines **~170 channels**; `IPC_DIRECTIONS` classifies each as
`send`/`invoke`/`on`/`secure`. Below maps every channel the renderer actually uses (via an
`ipc-client.ts` wrapper) to its Tauri target. **Strategy:** the adapter keeps the WinSTT channel
strings as the routing keys. For each, either (i) the channel string IS the Tauri command/event name
(rename in the backend or alias in the adapter), or (ii) it maps to a `lib_wiring.md` §3/§4 command.

Legend: **C** = mapped to a collected Tauri command (`lib_wiring.md §3`); **E** = mapped to a Tauri
event (§4); **EXIST** = Handy already has an equivalent command/event; **MISSING** = needs a new
command/event (file under `winstt/commands/` or a Handy-owned channel); **POLYFILL** = handled
entirely in the adapter/webview, no backend.

#### STT dictation core (renderer→main commands)

| WinSTT channel | Dir | Tauri target | Status |
|---|---|---|---|
| `STT_SET_PARAMETER` (`stt:set-parameter`) | send | `winstt_set_settings` (per-key set-parameter path, §02) | C (settings.rs) |
| `STT_GET_PARAMETER` | invoke | `winstt_get_settings` field read | C |
| `STT_CALL_METHOD` | send | dispatch by method name → manager call (e.g. `request_diarization_toggle`→`DiarizationManager`) | C — **MISSING generic dispatcher**; enumerate the ~5 real methods used and route each |
| `STT_IS_CONNECTED` | invoke | always-true shim (no separate STT server process in Tauri — engine is in-proc) | POLYFILL → `true` |
| `STT_ABORT_OPERATION` | send | Handy `cancel` action / `cancel_current_operation` | EXIST (`utils::cancel_current_operation`) |
| `STT_SERVER_SPAWN`/`_KILL`/`_GET_STATUS` | invoke | no external server; status shim = `"running"`/`"idle"` from engine-loaded flag | POLYFILL |
| `STT_RELOAD_MODEL` | send | `initiate_model_load` on `TranscriptionManager` (kind=main/realtime) | EXIST (engine swap §7) |

#### STT events (main→renderer)

| WinSTT channel | Tauri event | Status |
|---|---|---|
| `STT_REALTIME_TEXT` (`stt:realtime-text`) | `realtime-update` plain event → adapter remaps to `{text}` | E (§4b) |
| (realtime stabilized) | `realtime-stabilized` (`RealtimeStabilizedPayload`) | E (§4a) |
| `STT_FULL_SENTENCE` | new plain event `stt:full-sentence` `{text}` | MISSING — emit from transcription coordinator |
| `STT_NO_AUDIO_DETECTED` / `STT_TRANSCRIPTION_FAILED` | plain events | MISSING — emit from coordinator |
| `STT_RECORDING_START`/`_STOP`, `STT_VAD_START`/`_STOP`, `STT_TRANSCRIPTION_START` | plain events; some overlap Handy's recording-state events | partial EXIST / MISSING |
| `STT_CONNECTION_CHANGE` / `STT_SERVER_STATUS` | shim → always-connected/running | POLYFILL (emit once on boot) |
| `STT_AUDIO_LEVEL` | plain `stt:audio-level` `{level}` from audio consumer | MISSING — tap `audio_toolkit` level |
| `STT_WAKEWORD_DETECTED` (+ detection-start/end) | `wake_word_detected` (`WakeWordDetectedPayload`) | E (§4a) — adapter reshapes to `{word}` |
| `STT_VAD_SENSITIVITY_ADAPTED` | `vad-sensitivity-adapted` (`VadSensitivityAdaptedPayload`) | E (§4a) |
| `STT_SPEAKER_SEGMENTS` | `speaker-segments` (`SpeakerSegmentsPayload`) | E (§4a) |

#### Model catalog / picker / download (slices 01/03)

| WinSTT channel | Tauri command | Status |
|---|---|---|
| `STT_GET_MODEL_CATALOG` / `STT_MODEL_CATALOG` | `list_models` | C (stt.rs) |
| `STT_LIST_MODELS_WITH_STATE` | `list_models` (returns states+system_info; reshape) | C |
| `STT_GET_RUNTIME_INFO` / `STT_RUNTIME_INFO` | new `get_runtime_info` (active ORT providers) | MISSING — read EP from engine |
| `STT_GET_LIVE_RESOURCES` | `get_live_resources` | C (stt.rs) |
| `STT_ASSESS_DICTATION_FIT` / `STT_ASSESS_OLLAMA_FIT` | new fit-assessment commands (sysinfo + footprint) | MISSING (or fold into `get_live_resources`) |
| `STT_PREDOWNLOAD_QUANT`, `STT_DOWNLOAD_PAUSE/RESUME/CANCEL_QUANT`, `STT_DELETE_MODEL_QUANTIZATION`, `STT_DELETE_MODEL_CACHE`, `STT_CANCEL_DOWNLOAD` | per-quant download manager commands | MISSING — `01_*`/`03_*` download manager + `hf-hub`; emit `STT_MODEL_DOWNLOAD_*` + `STT_MODEL_CACHE_CHANGED` |
| `STT_MODEL_DOWNLOAD_START/PROGRESS/COMPLETE`, `STT_MODEL_CACHE_CHANGED` | plain events from download manager | MISSING |
| `STT_MODEL_SWAP_STARTED/COMPLETED/FAILED` | plain events from engine-swap path | MISSING (engine swap §7) |
| `STT_PICKER_*` (`picker_quantizations_for`, `set_custom_model`) | C (stt.rs) | C |
| `STT_DIARIZATION_TOGGLE_*` | events from `DiarizationManager` | partial — `start_listen`/`stop_listen` C; toggle events MISSING |
| `STT_RESTART_REQUIRED` | shim — no external server, so usually never fires | POLYFILL (emit on startup-only setting change without restart) |

#### Settings (renderer↔main)

| WinSTT channel | Tauri command/event | Status |
|---|---|---|
| `SETTINGS_LOAD` | `winstt_get_settings` | C (settings.rs) |
| `SETTINGS_SAVE` | `winstt_set_settings` (re-validate refines, diff restart-need, encrypt SECRET_KEYS) | C |
| `SETTINGS_CHANGED` | new `settings:changed` event (broadcast on set) | MISSING — emit after `winstt_set_settings` |
| `SETTINGS_SAVE_ERROR` | error branch of `winstt_set_settings` → event | MISSING |

#### Hotkey (renderer↔main)

| WinSTT channel | Tauri target | Status |
|---|---|---|
| `HOTKEY_REGISTER`/`_UNREGISTER` | Handy `change_binding` + `tauri-plugin-global-shortcut` | EXIST (settings bindings) |
| `HOTKEY_START_RECORDING`/`_STOP_RECORDING` | Handy transcribe action start/stop | EXIST |
| `HOTKEY_PRESSED`/`_RELEASED`/`_RECORDING_UPDATE`/`_RECORDING_DONE` | the hotkey-capture UI events (record-hotkey feature) | MISSING — emit from a binding-capture command |

#### System (renderer→main)

| WinSTT channel | Tauri target | Status |
|---|---|---|
| `AUTOSTART_SET`/`_GET` | `tauri-plugin-autostart` (already a plugin) | EXIST (plugin) |
| `AUDIO_GET_DEVICES` | Handy audio-device list command (`audio_toolkit`) | EXIST |
| `GPU_GET_INFO` | new `gpu_get_info` or fold into `get_live_resources` | MISSING |
| `APP_GET_SYSTEM_LOCALE` | `@tauri-apps/plugin-os` locale | POLYFILL (plugin-os) |

#### Window controls / navigation (renderer→main)

| WinSTT channel | Tauri target | Status |
|---|---|---|
| `WINDOW_MINIMIZE`/`_MAXIMIZE`/`_CLOSE`/`_SHOW`/`_QUIT`/`_CLOSE_SELF` | `@tauri-apps/api/window` `getCurrentWindow().minimize()/close()/hide()` | POLYFILL (window API) |
| `WINDOW_OPEN_SETTINGS`, `MODEL_PICKER_OPEN/CLOSE/RESIZE/ANCHOR`, `DEVICE_PICKER_OPEN/CLOSE/RESIZE`, `TRAY_MENU_CLOSE/RESIZE`, `ONBOARDING_FINISH`, `CONTEXT_PLAYGROUND_*` | new window-management commands (`open_window`, `close_window`, `resize_window`, `anchor_window`) | MISSING — `winstt/commands/windows.rs` (§4) |

#### Dialog / clipboard / menus

| WinSTT channel | Tauri target | Status |
|---|---|---|
| `DIALOG_OPEN_FILE` | `@tauri-apps/plugin-dialog` `open()` | POLYFILL (plugin-dialog) |
| `CLIPBOARD_OPERATE` (secure) | `@tauri-apps/plugin-clipboard-manager` | POLYFILL (drop encryption) |
| `APP_MENU_SET_TEMPLATE`/`_RESET`, `CONTEXT_MENU_SHOW` | Tauri menu API / new commands | MISSING (low priority — native menus) |

#### TTS (slice 06) — all map to `tts.rs` commands + events

| WinSTT channel | Tauri command | Status |
|---|---|---|
| `TTS_SPEAK`/`SPEAK_SELECTION`/`CANCEL`/`SET_SPEED`/`INIT` | `tts_speak`/`tts_speak_selection`/`tts_cancel`/`tts_cancel_all`/`tts_init` | C (tts.rs) — **`SET_SPEED` MISSING** as named command (add or route via cancel/restart) |
| `TTS_LIST_VOICES`/`CLOUD_LIST_VOICES`/`CLOUD_PREVIEW`/`CLOUD_SUBSCRIPTION`/`DOWNLOAD_ESTIMATE` | `tts_list_voices`/`tts_list_cloud_voices`/`tts_preview_cloud`/`tts_cloud_subscription`/`tts_download_estimate` | C (tts.rs) |
| `TTS_INSTALL_PAUSE/RESUME/CANCEL` | `tts_install_pause/resume/cancel` | C (tts.rs) |
| `TTS_REPORT_PLAYBACK_STARTED/ENDED` | new no-op/relay commands (renderer owns Web Audio) | MISSING (small) |
| `TTS_STARTED/CHUNK/COMPLETED/FAILED/PLAYBACK_*`, `TTS_INSTALL_*`, `TTS_MODEL_DOWNLOAD_*` | `tts://chunk` (`TtsChunkPayload`) + `TtsLifecyclePayload` plain events | E (§4) — adapter splits lifecycle phase → the right channel |

#### LLM / Ollama / OpenRouter (slice 07)

| WinSTT channel | Tauri command | Status |
|---|---|---|
| `LLM_PROCESS_TEXT` / `LLM_PROCESS_TEXT_CUSTOM` | `process_text` | C (llm.rs) |
| `TRANSFORMS_APPLY` / `TRANSFORMS_PREVIEW` | `process_transform` | C (llm.rs) |
| `LLM_SCAN_MODELS` / `LLM_DETECT_OLLAMA` / `LLM_START_OLLAMA` | `scan_ollama_models`/`ollama_detect`/`ollama_start` | C (llm.rs) |
| `LLM_SCAN_OPENROUTER_MODELS` | `scan_openrouter_models` | C |
| `LLM_PULL_MODEL`/`CANCEL_PULL_MODEL`/`DELETE_MODEL` | `ollama_pull`/`ollama_delete` (+ cancel) | C (llm.rs) — **cancel MISSING** |
| `LLM_FETCH_OLLAMA_LIBRARY`/`_TAGS`/`SEARCH_OLLAMA_LIBRARY` | new ollama-library commands | MISSING |
| `INTEGRATIONS_VERIFY` | `verify_credential` | C (llm.rs) |
| `LLM_CATALOG`/`PULL_PROGRESS`/`PROCESSING_START`/`_END`/`REASONING_DELTA`/`LEARNED_PROPER_NOUNS`/`WARMUP_STATUS` | plain events from `LlmManager` (`llm-reasoning-delta`, `llm-learned-proper-nouns`) | E (§4b) + some MISSING |
| `TRANSFORMS_APPLIED`/`FAILED` | events from `process_transform` | MISSING |

#### Cloud STT (slice 07)

| WinSTT channel | Tauri command/event | Status |
|---|---|---|
| (verify) `INTEGRATIONS_VERIFY` reused | `verify_cloud_stt_credential` | C (cloud_stt.rs) |
| `STT_CLOUD_AUTH_FAILED`/`NETWORK_ERROR`/`KEY_MISSING`/`RATE_LIMITED`/`PROVIDER_ERROR` | single `stt-cloud-error` `{code,message}` plain event → adapter fans out by `code` | E (§4b) |
| (cancel) | `cloud_stt_cancel` | C |

#### File transcription (slice 07)

| WinSTT channel | Tauri command | Status |
|---|---|---|
| `FILE_TRANSCRIBE`, `FILE_QUEUE_ENQUEUE/CANCEL/RETRY/COPY/CLEAR/PAUSE/RESUME/DISCARD_ALL/GET_ACTIVE` | `file_transcribe_enqueue`/`_pause`/`_resume`/`_cancel` (+ retry/copy/clear/get_active) | C (file_transcribe.rs) — several MISSING |
| `FILE_TRANSCRIPTION_PROGRESS/COMPLETE/ERROR`, `FILE_QUEUE_UPDATE/PROGRESS/ACTIVE` | `FileTranscribeProgressPayload` (§4) + queue events | E + some MISSING |

#### Loopback / listen (slice 05)

| WinSTT channel | Tauri command | Status |
|---|---|---|
| `LOOPBACK_LIST_DEVICES`/`START`/`STOP` | fold into `start_listen`/`stop_listen` + a device-list command | C (listen.rs) + MISSING device list |
| `STT_LOOPBACK_STARTED`/`STOPPED`, `STT_DEVICE_SWITCH_FAILED`, `LID_CLOSED`/`OPENED` | events from `LoopbackManager` | MISSING |

#### History (electron-store + SQLite)

| WinSTT channel | Tauri target | Status |
|---|---|---|
| `HISTORY_GET_ALL`/`CLEAR`/`DELETE`/`LOAD_AUDIO`/`ALIGN_AUDIO` | Handy `managers::history` + `align_words` (C) + new audio-load commands | partial EXIST + MISSING |
| `HISTORY_LIST`/`ADD`/`DELETE_ROW`/`TOGGLE`/`RECENT`/`LOAD_AUDIO_BY_ROW` | Handy history manager (it already uses a DB) OR `@tauri-apps/plugin-sql` | EXIST/MISSING — **prefer Handy's history manager + `HistoryUpdatePayload`** |
| `HISTORY_ADDED`/`DELETED`/`ROW_*` | `HistoryUpdatePayload` (Handy's one collected event) reshaped | EXIST (§4) |

#### Misc (diag / about / sound / updater / custom-models / telemetry)

| WinSTT channel | Tauri target | Status |
|---|---|---|
| `DIAG_OPEN_LOGS_FOLDER`/`SAVE_BUNDLE` | `tauri-plugin-opener` + new bundle command | partial POLYFILL + MISSING |
| `ABOUT_GET_LICENSE`/`NOTICES`/`APP_INFO` | read bundled resources + `app.package_info()` | MISSING (small) |
| `SOUND_GET_DATA`/`PLAY`/`LIBRARY_ADD`/`REMOVE`/`READ_FILE` | Handy `audio_feedback.rs` + fs reads | partial EXIST + MISSING |
| `UPDATER_*` (secure) | `tauri-plugin-updater` (already a plugin) | POLYFILL (plugin-updater) |
| `CUSTOM_MODELS_OPEN_FOLDER` | `tauri-plugin-opener` | POLYFILL |
| `WINDOW_TELEMETRY` | Tauri window events | POLYFILL (window events) or drop |
| `getPathForFile` | Tauri drag-drop event path | POLYFILL |

### 1c. Summary of the gap

Of the ~170 channels: roughly **40% are already collected commands** (`lib_wiring.md §3` / events
§4); **~25% are POLYFILL** (window controls, dialog, clipboard, updater, autostart, opener, os —
all covered by Tauri plugins Handy already has); **~35% are MISSING** and need new
`winstt/commands/*.rs` functions or plain `app.emit` calls. The MISSING set clusters into:
**download-manager commands+events**, **the STT lifecycle/level events**, **window-management
commands**, **hotkey-capture events**, **ollama-library commands**, **file-queue extras**,
**about/diag/sound extras**, and **settings-changed/save-error events**. These are tracked per-slice
in §6 and rolled into `lib_wiring.md §3/§4` as they land.

---

## 2. Adapter strategy — the `window.electronAPI` polyfill

### 2a. Shape

Add **one file** in the ported renderer (it is the only NEW renderer code the port introduces):
`app/src/shared/api/electron-tauri-adapter.ts`, imported once from every entry tsx (before any view
mounts), e.g. via the `app/providers/IpcProvider`. It installs `window.electronAPI` with the six
methods, backed by `@tauri-apps/api/core` `invoke` and `@tauri-apps/api/event` `listen`:

```ts
// shape — not final code
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

// channel(string) -> { kind: "command", cmd } | { kind: "event", event } | { kind: "window", op } | { kind: "noop" }
const ROUTE: Record<string, Route> = { /* the §1b table, encoded */ };

window.electronAPI = {
  getPathForFile: (file) => fileToTauriPath(file),     // drag-drop bridge
  send(channel, ...args) {
    const r = ROUTE[channel];
    if (r.kind === "command") void invoke(r.cmd, normalizeArgs(channel, args));
    else if (r.kind === "window") windowOp(r.op, args);
  },
  invoke(channel, ...args) {
    const r = ROUTE[channel];
    if (r.kind === "command") return invoke(r.cmd, normalizeArgs(channel, args));
    if (r.kind === "window")  return windowOp(r.op, args);
    return Promise.resolve(undefined);                 // POLYFILL/noop
  },
  secureInvoke(channel, payload) {                     // crypto dropped; same as invoke
    return invoke(ROUTE[channel].cmd, payload);
  },
  on(channel, cb) {
    const ev = ROUTE[channel].event;
    const un = listen(ev, (e) => cb(reshape(channel, e.payload)));   // returns Promise<UnlistenFn>
    return () => { void un.then((f) => f()); };        // ipc-client.ts expects a sync unsubscribe
  },
};
```

Two adapters needed inside the polyfill:

1. **arg-shape normalization** — WinSTT wrappers pass payloads as positional args or `{value}`
   envelopes (`STT_SET_PARAMETER` sends `{parameter,value}`; `predownloadModelQuant` sends
   `(modelId, quantization)` positionally). Tauri `invoke` takes a single `{args}` object keyed by
   the Rust fn's param names. A per-channel `normalizeArgs(channel, args)` maps WinSTT's call shape
   to the Tauri command's parameter object. This table is co-located with `ROUTE`.
2. **event payload reshape** — WinSTT `on*` wrappers expect specific shapes (`onFullSentence` reads
   `d.text`; `onWakeWordDetected` reshaping; the cloud-error fan-out). `reshape(channel, payload)`
   massages the Tauri event payload into the WinSTT shape so `ipc-client.ts`'s `onTyped`/`onCast`
   extractors work unchanged. Where the backend already emits the WinSTT shape (the §4b plain events
   are byte-identical by design), reshape is identity.

### 2b. Why polyfill over rewriting ipc-client.ts

- **Zero renderer edits.** `ipc-client.ts` and all 392 consumers port verbatim. The adapter is the
  single seam. (Fallback B = rewrite the 5 primitives in `ipc-client.ts` directly; identical routing
  table, but edits a WinSTT file — choose only if the secure path or the `getPathForFile`
  drag-bridge forces it.)
- **The `isElectron()` guard** in `ipc-client.ts` is `window.electronAPI != null` — installing the
  polyfill makes that true, so the "not in electron → noop/fallback" branches stay dormant. No need
  to touch them.
- **Secure-IPC collapses to plain invoke.** The Electron secure channel exists only because the
  Electron renderer is a remote web context; Tauri's IPC is already process-isolated, so
  `secureInvoke` → `invoke` with no crypto. The two secure channels in use are `CLIPBOARD_OPERATE`
  (→ clipboard plugin) and `UPDATER_GET/CLEAR_STATUS_HISTORY` (→ updater plugin).

### 2c. The drag-drop / `getPathForFile` bridge

`getFilePath(file)` is used by file-transcription drag-drop. Tauri's webview does NOT expose native
paths via the DOM `File` object (security). The fix: subscribe to Tauri's
`getCurrentWindow().onDragDropEvent()` (or the `tauri://drag-drop` event), which carries absolute
paths, and have the adapter resolve `getPathForFile` from a small last-drop path map keyed by file
name/size. Document this as a known seam (the file-transcription slice owns testing it).

---

## 3. The full `electronAPI` method → Tauri command table (the ROUTE map)

This is the routing table the adapter encodes. It is the §1b mapping condensed to the
`ipc-client.ts` wrapper level (what a renderer dev actually calls). Columns: wrapper fn →
WinSTT channel → adapter route. (Abbreviated to the representative set; the full ~170 rows are
generated 1:1 from `IPC_DIRECTIONS` + §1b.)

| `ipc-client.ts` wrapper | WinSTT channel | Adapter route |
|---|---|---|
| `sttSetParameter` | `STT_SET_PARAMETER` | `invoke("winstt_set_settings", {patch})` |
| `sttGetParameter` | `STT_GET_PARAMETER` | `invoke("winstt_get_settings")` → field |
| `sttCallMethod` | `STT_CALL_METHOD` | dispatch: method→command |
| `sttReloadModel` | `STT_RELOAD_MODEL` | `invoke("set_model", {kind,name})` |
| `settingsLoad` | `SETTINGS_LOAD` | `invoke("winstt_get_settings")` |
| `settingsSave` | `SETTINGS_SAVE` | `invoke("winstt_set_settings", {settings})` |
| `fetchModelsWithState` | `STT_LIST_MODELS_WITH_STATE` | `invoke("list_models")` → reshape |
| `fetchModelCatalog` | `STT_GET_MODEL_CATALOG` | `invoke("list_models")` |
| `fetchLiveResources` | `STT_GET_LIVE_RESOURCES` | `invoke("get_live_resources", {forceRefresh})` |
| `predownloadModelQuant` | `STT_PREDOWNLOAD_QUANT` | `invoke("predownload_quant", {modelId,quantization})` ⚠MISSING |
| `pauseModelDownload`/`resume`/`cancelQuant`/`deleteQuant` | `STT_DOWNLOAD_*` | download-manager commands ⚠MISSING |
| `audioGetDevices` | `AUDIO_GET_DEVICES` | Handy audio-device command |
| `autostartGet`/`Set` | `AUTOSTART_*` | autostart plugin |
| `gpuGetInfo` | `GPU_GET_INFO` | `invoke("get_live_resources")` gpus ⚠ |
| `getSystemLocale` | `APP_GET_SYSTEM_LOCALE` | plugin-os `locale()` |
| `windowMinimize`/`Close`/`Maximize` | `WINDOW_*` | `getCurrentWindow().minimize()/close()` |
| `windowOpenSettings` | `WINDOW_OPEN_SETTINGS` | `invoke("open_window", {name:"settings"})` ⚠MISSING |
| `dialogOpenFile` | `DIALOG_OPEN_FILE` | plugin-dialog `open()` |
| `clipboardReadText`/`Write`/`Clear` | `CLIPBOARD_OPERATE` (secure) | plugin-clipboard-manager |
| `ttsSpeak`/`Cancel`/`Init`/`SetSpeed` | `TTS_*` | `tts_speak`/`tts_cancel`/`tts_init`/`tts_set_speed` |
| `listTtsVoices`/`ttsCloudListVoices`/`ttsCloudSubscription`/`ttsDownloadEstimate` | `TTS_*` | `tts_list_voices`/… |
| `processWithLlm` | `LLM_PROCESS_TEXT` | `process_text` |
| `applyTransform`/`runLlmPreview` | `TRANSFORMS_*` | `process_transform` |
| `fetchOllamaModels`/`detectOllama`/`startOllama` | `LLM_*` | `scan_ollama_models`/… |
| `fetchOpenRouterModels` | `LLM_SCAN_OPENROUTER_MODELS` | `scan_openrouter_models` |
| `pullOllamaModel`/`delete` | `LLM_PULL_MODEL`/`DELETE_MODEL` | `ollama_pull`/`ollama_delete` |
| `fetchOllamaLibrary*` | `LLM_FETCH_OLLAMA_*` | ⚠MISSING ollama-library commands |
| `fileTranscribe`/`fileQueue*` | `FILE_*` | `file_transcribe_*` (+ ⚠MISSING extras) |
| `loopbackListDevices`/`Start`/`Stop` | `LOOPBACK_*` | `start_listen`/`stop_listen` (+ ⚠device list) |
| `fetchTranscriptionHistory`/`HISTORY_*` | `HISTORY_*` | Handy history manager |
| `alignTranscriptionHistoryAudio` | `HISTORY_ALIGN_AUDIO` | `align_words` |
| `updaterGetStatusHistory`/`checkNow`/`quitAndInstall` | `UPDATER_*` | plugin-updater |
| `aboutGetLicense`/`Notices`/`AppInfo` | `ABOUT_*` | ⚠MISSING (read resources) |
| `diagOpenLogsFolder`/`SaveBundle` | `DIAG_*` | plugin-opener + ⚠bundle command |
| `openCustomModelsFolder` | `CUSTOM_MODELS_OPEN_FOLDER` | plugin-opener |

**Events** (`on*` wrappers) route through `listen()`; the byte-identical §4b plain events
(`realtime-update`, `realtime-stabilized`, `llm-reasoning-delta`, `llm-learned-proper-nouns`,
`stt-cloud-error`, `tts://chunk`, `wake_word_detected`, `vad-sensitivity-adapted`) are emitted by
the backend already in WinSTT's shapes — the reason `lib_wiring.md §4b` chose plain emits.

---

## 4. Build integration — Vite multi-page + Tauri multi-window

### 4a. Vite multi-page in `app/`

Replace Handy's 2-entry `app/vite.config.ts` with WinSTT's multi-page config. Concretely:

1. **Copy the entry HTML files.** `app/index.html` (main) + new `app/windows/*.html` (8 secondary),
   each with `<div id="root">` + `<script src="/src/entries/<x>.tsx">`. (WinSTT keeps `main` at root,
   the rest under `windows/` — mirror exactly so `renderer-url` logic ports too.)
2. **`app/vite.config.ts`** — port `frontend/vite.config.ts` nearly verbatim, with three Tauri
   deltas: keep `clearScreen:false`, the fixed dev port (Tauri expects one — **1420**, not WinSTT's
   3000), and `watch.ignored: ["**/src-tauri/**"]`. Bring over: `base:"./"`, `resolve.tsconfigPaths`,
   the `react()` + dev-gated `babel(reactCompilerPreset())` + `tailwindcss()` plugins, the
   `optimizeDeps.include` list, the `rollupOptions.input` 9-entry map, the `manualChunks` splitter
   (**React + react-dom + @base-ui must share one chunk** — the circular-ESM crash invariant), and
   `target:"esnext"`. `build.outDir` → `"dist"` (Tauri's `frontendDist: "../dist"`).
3. **`tauri.conf.json`** — `frontendDist` stays `../dist`; `build.devUrl` stays
   `http://localhost:1420`; `beforeDevCommand`/`beforeBuildCommand` stay `bun run dev`/`bun run
   build`. Tauri serves the multi-page dev output from 1420 and loads each window's HTML via
   `WebviewUrl::App("windows/<x>.html")` in prod.

### 4b. Tauri opens the 9 windows (`WebviewWindowBuilder` vs Handy's 1+overlay)

Handy creates `main` in `lib.rs setup` and `recording_overlay` on demand in `overlay.rs`. The port
adds a **window-management module** `app/src-tauri/src/winstt/commands/windows.rs` (HARD-RULE-safe)
plus a `WindowManager` that knows the 9 windows' geometry/chrome (from §0b). Each window is a
`WebviewWindowBuilder::new(app, "<label>", WebviewUrl::App("windows/<x>.html".into()))` with the
WinSTT chrome translated to Tauri builder calls:

| Window | Tauri builder (key calls) |
|---|---|
| `main` | `.inner_size(420,150).resizable(false).decorations(false)` (replace Handy's 680×570) |
| `settings` | `.inner_size(700,560).resizable(false).decorations(false)` |
| `overlay` | `.inner_size(720,240).transparent(true).decorations(false).always_on_top(true).skip_taskbar(true).shadow(false)` + click-through via `set_ignore_cursor_events(true)` (the `OVERLAY_SET_IGNORE_MOUSE` channel toggles it) — **replaces Handy's `recording_overlay`** |
| `tray-menu` | transparent, decorations off, always-on-top, skip-taskbar, dynamic resize via `resize_window` command |
| `model-picker` | full-screen transparent backdrop + anchored panel (`MODEL_PICKER_ANCHOR` event places the panel); transparent/decorations-off/always-on-top |
| `device-picker` | `.inner_size(320,360)` transparent/decorations-off/always-on-top/skip-taskbar |
| `onboarding` | wizard, decorations off |
| `history` | history table window |
| `context-playground` | **created only when `CONTEXT_PLAYGROUND_ENABLED`** (debug) |

**Creation policy:** create `main` eagerly in `setup` (like Handy). Create `settings`/`history`/
`onboarding`/pickers/overlay/tray-menu **lazily on first open** (the `*_OPEN`/`open_window`
commands) and `.hide()` instead of destroying on close (matches Electron's keep-alive — WinSTT
windows hide, not destroy). Wire each `*_OPEN`/`*_CLOSE`/`*_RESIZE`/`*_ANCHOR` channel from §1b to a
`windows.rs` command. **Capabilities:** extend `capabilities/default.json` `windows: [...]` to list
all 9 labels (currently `["main","recording_overlay"]`) so each webview gets `core:default` +
plugin permissions.

### 4c. Per-window identity

Electron gives each window a separate HTML/tsx, so window identity is **implicit by entry** — no
runtime detection needed; ported verbatim. The Tauri side names each window the same as the entry
key so `getCurrentWindow().label` (if ever needed) lines up. No router, no SPA — exactly WinSTT's
model.

---

## 5. Dependency reconciliation (`app/package.json`)

### 5a. The headline conflict: React 18 (Handy) vs React 19 (WinSTT)

Handy's `app/package.json` pins **react 18.3.1**; WinSTT's renderer requires **react 19** (peer of
`@base-ui/react`, the model-picker workspace, and `babel-plugin-react-compiler` target `19`).
**Resolution: bump `app/` to React 19.** Handy's renderer (App.tsx, overlay) is being **replaced**
by WinSTT's, so there is no React-18 renderer code left to keep compatible. The only React in the
Tauri app after the port is WinSTT's. Bump `react`, `react-dom`, `@types/react`, `@types/react-dom`
to ^19, and `@vitejs/plugin-react` to ^6 (the v6 OXC path WinSTT's vite.config assumes).

### 5b. Deps to ADD to `app/package.json` (renderer runtime)

From `frontend/package.json`, the renderer-side runtime deps:

```
@base-ui/react            @hugeicons/react        @hugeicons/core-free-icons
use-intl                  virtua                  motion
class-variance-authority  clsx                    tailwind-merge
double-metaphone          fuse.js (via model-picker)
```

Dev deps to ADD: `babel-plugin-react-compiler`, `@rolldown/plugin-babel`. (Handy already has
`@tailwindcss/vite`, `tailwindcss`, `vite` — bump vite to **8** to match WinSTT's config; verify the
Tauri CLI tolerates vite 8, else stay on the vite version WinSTT's config still runs on.)

### 5c. Deps to REMOVE / NOT carry over

- **AI SDK** (`ai`, `@ai-sdk/*`, `@openrouter/ai-sdk-provider`) — these were **electron-main** deps;
  in Tauri the LLM/cloud-STT/TTS-cloud calls are **Rust** (`llm_client.rs`, `cloud_stt.rs`, `07_*`).
  Do NOT add them to the renderer.
- **Electron-only** (`electron`, `electron-*`, `uiohook-napi`, `@sentry/electron`, `adm-zip`, `tar`,
  `pngjs`) — gone; their jobs move to Rust + Tauri plugins.
- Handy's renderer deps that the WinSTT renderer does **not** use (`react-i18next`, `i18next`,
  `react-select`, `sonner`, `lucide-react`, `immer`) — keep only if some non-ported Handy view still
  needs them; otherwise drop. WinSTT uses `use-intl` (not react-i18next), Base UI primitives (not
  react-select), `motion` toasts/its own UI (not sonner), `@hugeicons` (not lucide).
- **zod**: Handy pins **3.25**, WinSTT requires **4**. Bump to ^4 (the renderer's settings schemas
  + generated Zod assume v4). Tauri's frontend doesn't otherwise constrain zod.
- **zustand 5**: identical major on both — no conflict.

### 5d. Tauri-side deps stay

Keep all `@tauri-apps/api` + `@tauri-apps/plugin-*` (autostart, clipboard-manager, dialog, fs,
global-shortcut, opener, os, process, sql, store, updater). The adapter (§2) imports
`@tauri-apps/api/core`, `/event`, `/window` and the relevant plugins.

---

## 6. Concrete slice plan — 14 independent, parallelizable work units

Each unit is owned by one agent, touches a disjoint file set, and depends only on **WU-0** (the
shared adapter scaffold). After WU-0 lands, WU-1…WU-13 proceed in parallel. Backend MISSING commands
(§1c) are filed under the owning slice's WU and appended to `lib_wiring.md §3/§4`.

> **Shared rule:** renderer code is **copied verbatim** from `frontend/src/<layer>/<slice>/` to
> `app/src/<layer>/<slice>/`. The ONLY new renderer file in the whole port is WU-0's adapter. All
> per-unit "backend work" is new `winstt/commands/*.rs` (HARD-RULE-safe) + `lib_wiring` appends.

### WU-0 — Adapter scaffold + build integration (BLOCKING; do first)
- **Frontend:** `app/src/shared/api/electron-tauri-adapter.ts` (the polyfill + ROUTE + normalizeArgs
  + reshape — §2/§3); copy `frontend/src/shared/api/ipc-channels.ts` + `ipc-client.ts` +
  `models.ts` + codecs verbatim; copy `app/src/app/providers/IpcProvider.tsx` (install adapter on
  mount); copy `shared/config/`, `shared/i18n/`, `shared/lib/`, `app/styles/`.
- **Build:** `app/vite.config.ts` (multi-page, §4a); `app/index.html` + `app/windows/*.html` (9
  entries); `app/src/entries/*.tsx` (9, copied); `app/tsconfig.json` path aliases (`@/*`, `@spec/*`).
- **Backend:** `app/src-tauri/src/winstt/commands/windows.rs` (`open_window`/`close_window`/
  `resize_window`/`anchor_window`) + the 9-window `WindowManager`; extend
  `capabilities/default.json` windows list; register in `lib.rs` (§4b).
- **package.json:** the §5 reconciliation (React 19, add renderer deps, remove Electron/AI-SDK).
- **Deliverable:** `bun run dev` boots the `main` window rendering WinSTT's `views/main` against
  real `winstt_get_settings`/`list_models`. Gate for everything else.

### WU-1 — `shared/ui` primitives + `app/` providers/layouts
- `app/src/shared/ui/**` (Base UI wrappers: button, dialog, menu-highlight, form-control, table,
  badge, …), `app/src/app/providers/**` (IntlProvider, ErrorBoundary), `app/src/app/layouts/**`
  (TitleBar → window controls via adapter, HtmlLang, RootLayout). No backend.

### WU-2 — `entities/setting` + settings store + `views/settings` shell
- `entities/setting/**`, `widgets/*-settings` shells, `views/settings/**`. Backend: confirm
  `winstt_get_settings`/`winstt_set_settings` round-trip; add `settings:changed`/`settings:save-error`
  events (MISSING). Owns the settings save/load path end-to-end.

### WU-3 — Main window: dictation overlay + PTT + live transcription
- `views/main/**`, `views/overlay/**`, `features/push-to-talk`, `features/live-transcription`,
  `features/record-hotkey`, `features/audio-visualizer`, `widgets/audio-display`,
  `widgets/status-bar`, `entities/connection`, `entities/transcription`. Backend: STT lifecycle/level
  events (`stt:full-sentence`, `stt:no-audio-detected`, `stt:audio-level`, recording/vad events —
  MISSING); hotkey-capture events; `STT_IS_CONNECTED`/server-status shims. Owns the overlay
  click-through (`set_ignore_cursor_events`) + the realtime accumulator.

### WU-4 — Model catalog + picker workspace + swap/download
- `packages/model-picker/**` (copy workspace; repoint peerDep host to `app/`),
  `views/model-picker/**`, `widgets/model-picker-window`, `widgets/model-settings`,
  `features/swap-model`, `features/swap-notifications`, `features/model-download`,
  `features/sync-active-model`, `entities/model-catalog`, `entities/system-resources`. Backend:
  download-manager commands+events (`predownload_quant`, pause/resume/cancel/delete,
  `STT_MODEL_DOWNLOAD_*`, `STT_MODEL_CACHE_CHANGED` — MISSING); `get_runtime_info`,
  fit-assessment, model-swap events (MISSING); engine-swap (`lib_wiring §7`) is the gate.

### WU-5 — TTS (read-aloud dynamic island + settings)
- `widgets/tts-settings`, the TTS playback island in `views/overlay`,
  `features/recording-sound` (shares audio plumbing). Backend: `tts.rs` commands exist; add
  `tts_set_speed`, `tts_report_playback_*` (MISSING); wire `tts://chunk` + `TtsLifecyclePayload`
  fan-out in the adapter. Owns the Web Audio queue + per-sentence speed.

### WU-6 — LLM processing + Ollama manager + OpenRouter
- `widgets/llm-settings`, `widgets/ollama-model-manager`, `features/llm-processing`,
  `features/llm-model-picker` (+ model-picker ollama/openrouter UI), `entities/llm-catalog`.
  Backend: `process_text`/`process_transform`/scan/pull/detect exist; add ollama-library commands +
  pull-cancel (MISSING); `llm-reasoning-delta`/`llm-learned-proper-nouns` plain events.

### WU-7 — Cloud STT + credential verification
- `features/verify-credentials`, `features/select-cloud-stt-model`,
  `features/show-cloud-stt-errors`, `features/revert-cloud-on-key-removal`,
  `widgets/integrations-settings`, `entities/cloud-stt-credential`, `entities/cloud-stt-provider`.
  Backend: `verify_cloud_stt_credential`/`verify_credential`/`cloud_stt_cancel` exist; adapter fans
  `stt-cloud-error{code}` → the 5 WinSTT cloud-error channels.

### WU-8 — File transcription queue
- `features/file-transcription`, the file-drop UI in `views/main`. Backend: `file_transcribe_*`
  exist; add queue extras (retry/copy/clear/get_active + queue events — MISSING); the
  `getPathForFile` drag-drop bridge (§2c) is owned here.

### WU-9 — Listen mode + loopback + diarization
- `features/listen-mode`, `features/vad-calibration`, `features/audio-device-feedback`,
  `widgets/device-picker-window`, `views/device-picker`, `entities/audio-device`. Backend:
  `start_listen`/`stop_listen` + `align_words` exist; add loopback device-list, loopback/lid/device-
  switch events, diarization-toggle events, `vad-sensitivity-adapted` (some MISSING).

### WU-10 — History window + word-timestamp playback
- `views/history/**`, `widgets/transcription-history-settings`, `entities/transcription-history`.
  Backend: prefer Handy's `managers::history` + `HistoryUpdatePayload` (reshape to WinSTT
  `HISTORY_*` events); add audio-load + `align_words` wiring (MISSING audio-load by id).

### WU-11 — Settings panels: general / audio / quality / dictionary / snippets / about
- `widgets/general-settings`, `widgets/audio-settings`, `widgets/quality-settings`,
  `widgets/dictionary-settings`, `widgets/snippets-settings`, `widgets/about-settings`,
  `features/update-settings`, `features/restart-notice`. Backend: autostart/audio-devices/gpu-info
  (mostly EXIST/plugin); about-info/license/notices + diag bundle (MISSING, small); updater via
  plugin. Owns the per-setting reset buttons + the deny-list/dictionary TagInputs.

### WU-12 — Tray menu window + onboarding wizard
- `views/tray-menu/**`, `widgets/tray-menu`, `views/onboarding/**`, `widgets/onboarding-wizard`.
  Backend: tray-menu open/resize/close + `onboarding:finish` window commands (MISSING — in
  `windows.rs`); reuse Handy's tray icon plumbing (`tray.rs`) for the system tray itself.

### WU-13 — Transforms + notifications + context-playground (debug)
- `features/transform-notifications`, `features/connect-server` (shim — no server), the transforms
  apply/preview UI (shared with WU-6's LLM), `views/context-playground/**` (debug-only, gated).
  Backend: `process_transform` exists; add `transforms:applied`/`failed` events; `debug_read_context`
  (feature-gated) exists. Lowest priority.

### Cross-cutting: i18n + checks
- The 20 `frontend/messages/*.json` locale files copy verbatim to `app/src/i18n/` (or wherever the
  ported `shared/i18n` loader points). `bun check:i18n` parity carries over. **No** `@spec/generated`
  in the Tauri app — types come from `app/src/bindings.ts` (tauri-specta) for backend payloads;
  WinSTT's `models.ts`/codecs stay for the renderer-internal shapes. Reconcile the two type sources
  as a small task inside WU-0.

---

## 7. Risks / known seams (carry forward)

1. **`getPathForFile` drag-drop** (§2c) — no DOM native path in Tauri; the drag-drop-event bridge is
   the one place the polyfill can't be a pure passthrough. WU-8 owns it.
2. **Secure-IPC** collapses to plain `invoke` — safe (Tauri is process-isolated), but verify the
   clipboard + updater wrappers behave (they fall back gracefully via `invokeSecureOrDefault`).
3. **`manualChunks` React+@base-ui single chunk** — must port exactly, or packaged builds crash with
   `Cannot read properties of undefined (reading 'useLayoutEffect')` (WinSTT memory). WU-0 gate.
4. **React-compiler dev-gating** — keep `command === "build"` gate; otherwise dev first-paint
   regresses ~8s. WU-0.
5. **Window keep-alive** — Tauri must `.hide()` not destroy on close (Electron semantics); destroying
   loses state and breaks re-open. WU-0 `WindowManager`.
6. **Event ordering** — `realtime-stabilized` THEN `realtime-update` (noise-break depends on it,
   `04_*`); the adapter must not reorder. WU-3.
7. **The ~35% MISSING backend commands** are real work, not adapter work — they're filed per-WU and
   roll into `lib_wiring.md §3/§4`. The adapter only routes; it can't conjure a command.
8. **`bindings.ts` vs WinSTT `models.ts`** — two type sources; keep tauri-specta `bindings.ts` for
   backend payload types, WinSTT `models.ts`/codecs for renderer-internal shapes; don't try to unify
   them in v1.

---

## 8. Verification checklist (per WU)

- [ ] Renderer slice copied verbatim (diff vs `frontend/src/<slice>` is empty except imports).
- [ ] Every `electronAPI.*` call the slice makes has a ROUTE entry (command/event/polyfill).
- [ ] MISSING backend commands for the slice are added under `winstt/commands/` + appended to
      `lib_wiring.md §3` (commands) / §4 (events) + collected in `lib.rs`.
- [ ] The window(s) the slice owns open via `windows.rs` with correct chrome (§4b) and appear in
      `capabilities/default.json`.
- [ ] `bun run dev` (Tauri) renders the slice; `tauri dev` regenerates `bindings.ts` without error.
- [ ] No `@/shared/*` import leaked into `packages/model-picker` (WU-4); no AI-SDK import leaked into
      the renderer (§5c).
- [ ] `bun check:i18n` parity holds; locale keys present for the slice's strings.
