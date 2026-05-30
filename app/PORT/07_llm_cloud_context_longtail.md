# 07 — LLM (all-Rust) · Cloud STT · Context-awareness · Paste/ducking · long-tail

> Slice outputs (all under `src-tauri/src/winstt/`):
> `llm/mod.rs` · `cloud_stt.rs` · `context.rs` · `paste_ext.rs` · `ducking.rs` — plus this doc.
> Behavioral reference: `frontend/electron/ipc/{llm,stt-cloud,credentials,audio-mute}.ts`,
> `frontend/electron/lib/{context-reader,context-snapshot,paste}.ts`,
> `frontend/electron/native/src/{winstt-context,winstt-paste}.c`,
> `frontend/src/shared/lib/{preset-prompts,ollama-endpoint}.ts`.
> Extends (does NOT edit): Handy's `src/llm_client.rs`, `src/clipboard.rs`, `src/input.rs`,
> `src/managers/audio.rs::set_mute`.
> Authoritative settings: `frontend/src/shared/config/settings-schema.ts` (the OpenAPI spec is STALE).
> The Rust mirror of those settings already lives in `winstt/settings_schema.rs` (sibling slice) — this
> slice CONSUMES those types, it does not redefine them.

This slice covers four user-facing features plus the cross-cutting paste/ducking layer:

| Feature | New module | Extends (unmodified) | What's net-new vs Handy |
|---|---|---|---|
| LLM post-processing | `llm/mod.rs` | `llm_client.rs` (OpenAI-compat + json_schema + reasoning_effort) | Prompt composition, Ollama NDJSON streaming + thinking, CoT-leakage/salvage extractors, OpenRouter extras |
| Cloud STT | `cloud_stt.rs` | — (Handy has no cloud STT) | OpenAI + ElevenLabs multipart transcription, error taxonomy, EL scoped-key handling |
| Context-awareness | `context.rs` | — (Handy has no UIA reader) | `winstt-context.exe` sidecar + deny-list + LLM-cleanup prompt formatter |
| Paste (terminal-aware) | `paste_ext.rs` | `clipboard.rs` / `input.rs` | Terminal auto-detect → Ctrl+Shift+V, fallback chain, circuit-breaker/pacing |
| Audio ducking | `ducking.rs` | `managers/audio.rs::set_mute` (hard-mute) | Graduated duck via `SetMasterVolumeLevelScalar`, save/restore |

**Invariant honored throughout:** context-awareness is an **LLM-cleanup** concern only. It is NEVER fed to
the transcriber as an `initial_prompt` (Canary/Cohere context slot is untrained; only Whisper benefits, and
that bias path lives in the STT slice). See `memory/project_canary_cohere_prompt_slot_untrained.md`.

---

## 1. LLM — `llm/mod.rs`

### 1.1 What Handy already gives us

Handy's `llm_client.rs` is an OpenAI-compatible chat-completions client with:
- per-provider auth headers (Anthropic uses `x-api-key`; everyone else `Authorization: Bearer`);
- structured output via `response_format: { type: "json_schema", json_schema: {…, strict: true} }`;
- top-level `reasoning_effort` (OpenAI style) **and** nested `reasoning: { effort, exclude }` (OpenRouter style);
- `fetch_models` (OpenAI `{data:[{id}]}` and bare-array shapes).

`send_chat_completion_with_schema(provider, key, model, user, system, json_schema, reasoning_effort, reasoning)`
is the single entry point. **OpenRouter rides this unchanged** — it IS OpenAI-compatible — so the OpenRouter
path needs no new transport, only the request extras in §1.4.

### 1.2 Prompt composition (fully implemented + tested)

Ported 1:1 from `preset-prompts.ts` + the `with*` builders in `llm.ts`. This is the load-bearing pure logic
and is the bulk of `llm/mod.rs`. Layering (outermost → innermost), matching `buildDictationSystemPrompt`:

```
build_dictation_system_prompt(presets, context, vocab)
  = with_vocab_prefix(                       // dictionary + replacement-pairs + snippets blocks
      with_compose_rules(                     // COMPOSE-vs-GENERATE rule (UNCONDITIONAL)
        with_context_prefix(                  // how to USE the UIA snapshot + caret-continuation clause
          build_system_prompt(presets))))     // POLISH base + tone/modifier bullets (translate LAST)
```

Faithful details that must not drift:
- **Polish base emitted exactly once** (`POLISH_PROMPT` + `SCHEMA_CLAMP`); `[]`, `[neutral]`,
  `[neutral, neutral]` all collapse to it. Tones/modifiers layer ON TOP, never replace it.
- **Bulleted, never numbered** — a numbered list invites chain-of-thought narration from reasoning models.
- **`translate` is always sorted last** (`sort_translate_last`) — every other preset operates on the
  source-language text, then translation renders the finished result. The generalization clause
  (English examples are *illustrative*, apply target-language conventions) travels with the bullet.
- **`SCHEMA_CLAMP` is the literal last sentence of every per-entry instruction** — reinforces the
  `format` JSON schema at the prompt level for reasoning models that consider ignoring the system reminder.
- **Custom modifiers**: only enabled + non-blank ones are folded in (`merge_presets_with_custom_modifiers`);
  the Low/Medium/High hint is appended only when `levels_enabled` (a custom modifier authors ONE prompt;
  the level tunes aggressiveness, it does not pick between three texts).
- **Context prefix is inert when `context == ""`** and the caret-continuation clause is inert unless a
  "text before the caret" section is present in the formatted context (the relay/`context.rs` formatter
  only emits that label in `--split`/`--tree` modes).
- **Replacement-pair safety net** (`apply_replacement_pairs`) runs on the LLM output afterwards
  (case-insensitive whole-word, preserving replacement casing) so a pair is GUARANTEED to fire regardless
  of which provider answered — mirrors the deterministic post-pass in the TS path.

The Rust `PresetEntry` / `CustomModifier` / `PresetKey` / `PresetLevel` here are the **prompt-composition
view**; the settings/persistence view lives in `winstt/settings_schema.rs::{PresetEntry, CustomModifier,
ThinkingEffort}`. During the compile loop, add a thin `From<settings_schema::PresetEntry> for
llm::PresetEntry` (and likewise for `CustomModifier` / `ThinkingEffort`) so the manager reads the persisted
shape and composes with the prompt shape. They are kept separate so the prompt logic is testable without
dragging in serde/specta.

### 1.3 Ollama streaming + chain-of-thought leakage (logic implemented, transport interface)

- `build_ollama_chat_body` mirrors `buildOllamaChatBody`: `stream:true`, `think:<effort|false>`,
  `format:<json-schema>` (native structured outputs), `keep_alive:"30m"`, `temperature:0.3`, `top_p:0.9`,
  `num_predict: max(text_len*4, 8192)` (the 8k floor keeps reasoning models from exhausting the budget on
  the thinking trace before emitting any answer).
- `thinking_flag_for(effort, supports_thinking)` → `false` when the model can't think or effort is `Off`,
  else the effort string. **Gate carefully**: sending `think:true` to a non-thinking model is an HTTP 400 in
  modern Ollama. The manager learns capability from `/api/show` (the `["thinking", …]` array; cache 5 min).
- `OllamaStreamState::apply_chunk` accumulates `content` + `thinking` and returns per-chunk deltas so the
  manager can stream the natural-prose answer to the recording pill (the structured `text` field's delta,
  **never** the raw JSON scaffolding — mirrors `broadcastContentDelta`/`resolveVisibleContent`).
- **`finalize_chat_answer`** is the priority chain, ported verbatim:
  1. structured envelope `{"text":"…"}` (strict parse → salvage for smart-quote close / dropped brace /
     truncation via `extract_structured_final_text` + `salvage_structured_text`);
  2. inline `<think>…</think>` split;
  3. OpenAI-harmony `<|channel|>final<|message|>…` extraction (gpt-oss family);
  4. `\boxed{…}` (Qwen-Math / DeepSeek-Math), one level of brace nesting;
  5. raw fallthrough → original text.
- `extract_learned_proper_nouns` salvages 0–5 proper nouns from the same envelope (≤10, ≤60 chars each) —
  the single-call dictionary-learning channel that replaces Wispr's parallel `/llm/extract_asr_words` call.

**Transport** is behind the `OllamaChat` trait with a documented reqwest sketch (`bytes_stream()` +
newline-delimited NDJSON drain). Wire it during the compile loop. Cancellation: hold a tokio
`CancellationToken`/`AbortHandle` per active chat (mirrors `activeChatControllers` +
`abortActiveOllamaChats`) so a model swap releases Ollama's per-model serializer instead of queueing behind
a slow reasoning stream. A periodic warmup loop + `keep_alive:30m` keep the model hot between dictations.

The Ollama endpoint helpers (`normalize_ollama_endpoint` / `build_ollama_api_url`) are ported from
`ollama-endpoint.ts` (strip trailing `/api`, `/v1`, slashes) and fully tested.

### 1.4 OpenRouter (rides Handy's client + extras)

- `openrouter_extra_body(provider_slug)` → `{ plugins: [{id:"response-healing"}] }`, plus
  `provider: { order:[slug], allow_fallbacks:false }` when a specific infra provider was chosen. Goes in the
  request body (Handy's `ChatCompletionRequest` will need an `#[serde(flatten)] extra: Value` or an
  `extra_body` field — that's a one-line extension to `llm_client.rs`'s request struct during the compile
  loop; do NOT rewrite the client).
- `parse_model_selection("model::slug")` → `(model_id, Some(slug))` (the renderer encodes the chosen infra
  provider as a `::`-suffixed slug).
- Structured output: pass `ollama_structured_output_schema()` (or the equivalent `{text, learned_proper_nouns}`
  JSON schema) as `json_schema` to `send_chat_completion_with_schema`; reasoning models go through
  `reasoning_effort` / `reasoning`.
- Headers: WinSTT sets `HTTP-Referer: https://github.com/dahshury/winstt` + `X-Title: WinSTT`. Handy's
  `build_headers` currently hard-codes the Handy referer/title — during rebrand, change those string
  constants in `llm_client.rs` OR (preferred, to keep the file untouched) thread the referer/title through
  the `PostProcessProvider` and set them per-request.

### 1.5 Provider catalog reconciliation

Handy's `settings.rs::default_post_process_providers()` already ships a provider list (openai, zai,
openrouter, anthropic, groq, cerebras, bedrock_mantle, custom) with `base_url` / `models_endpoint` /
`supports_structured_output`. WinSTT's two LLM providers are **ollama** (local, NOT in Handy's list — add a
`PostProcessProvider { id:"ollama", base_url:"http://localhost:11434/v1", allow_base_url_edit:true,
models_endpoint:Some("/api/tags") }`) and **openrouter** (already present). The Ollama path does NOT use the
OpenAI-compat `/v1/chat/completions` endpoint — it uses the native `/api/chat` streaming endpoint built by
`build_ollama_chat_body`, so route by `provider.id == "ollama"` to `llm::OllamaChat` before falling through
to Handy's `send_chat_completion_with_schema`.

---

## 2. Cloud STT — `cloud_stt.rs`

Handy has **no cloud STT** (only LLM cloud post-processing). In WinSTT-Electron the Python `RemoteTranscriber`
adapter ships the WAV bytes to the main process over WS, which calls the AI SDK. **In the Rust port there is
no Python and no WS** — the `TranscriptionManager` calls `cloud_stt` directly when the active model id is a
cloud model (`openai:whisper-1`, `elevenlabs:scribe_v1`), exactly the way Handy calls `transcribe-rs` for
local models. So this is a plain `async fn` returning `Result<CloudTranscription, CloudSttError>` — not a
WS request/response handler.

Faithfully ported (all tested):
- **Provider audio byte limits** — OpenAI 25 MB, ElevenLabs 1 GB. `preflight` bails BEFORE the upload
  (`KeyMissing` / `AudioTooLarge` sentinels) so the failure is fast and free.
- **HTTP-status → typed code**: 401/403 → `Auth`, 413 → `AudioTooLarge`, 429 → `RateLimit`, other → `ProviderError`,
  none → `Network`. `retry-after` parsed for rate limits.
- **Transport-error classification** — `ECONNREFUSED`/`fetch failed`/dns/timeout patterns → `Network`, else `ProviderError`.
- **ElevenLabs scoped-key 401**: `{"detail":{"status":"missing_permissions"}}` PROVES authentication (the key
  is valid for what it IS scoped to) → treated as `Ok` in both verify and the transcribe auth path.
  `invalid_api_key` → genuinely bad. (Verified live 2026-05-30; see `memory/project_elevenlabs_scoped_key_verify.md`.)
- **Per-call provider instance** so the key reflects the current store value.
- `aborted` is suppressed from renderer toasts (the user knows they cancelled).

Endpoints + body shapes (the multipart upload is the one heavy bit — sketch in the module; wire reqwest
`multipart::Form` during the compile loop):
- **OpenAI** `POST /v1/audio/transcriptions`: `file`, `model`, `response_format=verbose_json` (gives
  language + duration), optional `language`. Auth `Authorization: Bearer`.
- **ElevenLabs** `POST /v1/speech-to-text`: `file`, `model_id`, optional `language_code`. Auth `xi-api-key`.
- 90s round-trip ceiling; cancellation via a per-request token in the manager (mirrors `inFlight` +
  `abortAllCloudTranscribes`).

The **verify** path (`classify_verify`) reuses the same classifier and shares the scoped-key special-case —
it's the `GET /v1/models` (OpenAI) / `GET /v1/user` (ElevenLabs) / `GET /api/v1/auth/key` (OpenRouter) probe
from `credentials.ts`. Expose it as a Tauri command `verify_credential(provider, api_key)` (see §6).

---

## 3. Context-awareness — `context.rs`

**Zero reimplementation of the UIA reader.** `winstt-context.exe` (the existing C binary — byte-identical to
the Electron build, already at `frontend/electron/native/bin/winstt-context.exe`) ships as a Tauri **sidecar**
(`externalBin`) and is invoked per dictation. `context.rs`:

1. **Spawns the sidecar** with the mode flag (`--selection` / `--split` / `--tree`), `READ_TIMEOUT_MS = 1200`
   outer fence (the binary's own watchdog is 750ms), `MAX_BUFFER_BYTES = 1 MB`, window hidden.
2. **Parses** the single-line JSON stdout (`parse_snapshot`), attaching optional fields only when non-empty
   (so an empty capture is the cheap 3-field shape the deny-list / "nothing captured" checks rely on).
3. **Deny-list** (`is_denied_by_list` / `redact_sensitive_fields` / `apply_deny_list`) — exe-name or
   URL-host-suffix patterns (every host pattern covers subdomains; `*.` prefix normalized). A denied app
   keeps only metadata; focused text + axHtml + URL are stripped. Tolerant: a mistyped pattern is a silent
   no-op.
4. **Prompt formatter** (`format_context_for_prompt`) — the compact LLM-cleanup fragment with focused-field-
   first ordering, terminal scrollback omitted, tree/OCR only when the focused field is thin. The two caret
   label phrases are EXACT (the system-prompt continuation clause matches them literally).

The deny-list, IDE/terminal/canvas detection, host extraction, and formatter are PURE and fully tested. The
sidecar spawn is a documented sketch (two transports below). **Always resolves to a snapshot — never
propagate an error past this layer** (empty snapshot = "no extra hint", LLM degrades cleanly).

### Sidecar wiring (tauri.conf.json + dev path)

```jsonc
// tauri.conf.json
"bundle": { "externalBin": ["binaries/winstt-context"] }
```
Tauri appends the target triple → at build time place
`src-tauri/binaries/winstt-context-x86_64-pc-windows-msvc.exe`. The existing
`frontend/electron/native/bin/winstt-context.exe` is the binary — copy it into `src-tauri/binaries/` with the
triple suffix (a build-script step, like `bun native:build` produces it). In dev, fall back to the
electron-native path.

Two spawn transports (pick during compile loop):
- **(A) `tauri-plugin-shell` sidecar** — `app.shell().sidecar("winstt-context").arg(flag).output()` wrapped
  in `tokio::time::timeout(READ_TIMEOUT_MS)`. Tauri resolves the triple path for you. Needs the
  `tauri-plugin-shell` dep + `shell:allow-execute` capability scoped to `winstt-context`.
- **(B) `std::process::Command`** — matches how Handy already shells out (clamshell/audio), no extra plugin.
  Resolve the path via `app.path().resource_dir()` (packaged) / dev path; `creation_flags(CREATE_NO_WINDOW)`;
  watchdog thread kills on timeout; bounded stdout read.

The `ax-prune` denoising (`denoiseForLlm` / `stripListScrollback` / `pruneAxHtmlForLlm`) that the TS formatter
applies is a **separate slice** — `context.rs::clean_caret` is currently a minimal trim+collapse, with
`push_fallback_tree` emitting raw axHtml. Wire the ax-prune Rust port (if/when it lands) where marked so the
tree pruning matches the TS path.

The `OcrText` field exists in the snapshot for parity, but the OCR fallback binary (`winstt-ocr.exe`) is
out of scope for v1 unless the OCR slice ships it — leave `ocr_text` `None` until then.

---

## 4. Paste (terminal-aware) — `paste_ext.rs`

Handy's `clipboard.rs::paste` already does the clipboard-sandwich Ctrl+V and supports an explicit
`PasteMethod::CtrlShiftV`, but it does NOT auto-detect terminals. `winstt-paste.exe` does (and WinSTT's flip
to clipboard-first matches Handy's flow — see `memory/project_paste_priority_flip.md`). `paste_ext.rs` ports
the detection + safety machinery WITHOUT editing `clipboard.rs`:

- **Terminal tables** (`TERMINAL_CLASSES` / `TERMINAL_EXES`) verbatim from `winstt-paste.c`, matched
  case-insensitively. `keystroke_for_foreground(class, exe)` → `CtrlShiftV` for terminals, else `CtrlV`.
- **Foreground probe** (DRAFT sketch) — `GetForegroundWindow` + `GetClassNameW` +
  `GetWindowThreadProcessId` + `QueryFullProcessImageNameW` (basename). Mirror `winstt-context.c`'s dual
  resolver: OpenProcess(`PROCESS_QUERY_LIMITED_INFORMATION`) first, Toolhelp32 snapshot fallback for elevated
  windows. **Needs `Win32_System_Threading` added to the `windows` features** (see crateDeps).
- **Fallback chain** (`build_fallback_chain`) — primary clipboard+auto-keystroke, then per-char `--type`
  (`KEYEVENTF_UNICODE`) for apps that swallow Ctrl+V (Vim normal mode, some IMEs, DirectInput games). Mirrors
  `tryClipboardThenTyping`. Enigo's `text()` (Handy's `paste_text_direct`) is the Rust equivalent of `--type`.
- **Circuit breaker + pacing** (`PasteBreaker`) — pure state machine: `PASTE_TIMEOUT_MS=2500` trip →
  `PASTE_COOLDOWN_MS=30_000` silent-drop window (AV/accessibility hook stalls the OS input queue);
  `PASTE_MIN_GAP_MS=350` inter-paste pacing. The open circuit overrides pacing. Fully tested with a fake clock.
- **Sandwich timing** (`sandwich_timing`) — `SETTLE=60` / `RESTORE=120` / `GUARD_TAIL=50` constants as a
  single source of truth.

**How this plugs into Handy's paste**: the manager, before calling `clipboard::paste`, probes the foreground
and — when it's a terminal — overrides the effective `PasteMethod` to `CtrlShiftV` for this paste, and gates
the whole call through `PasteBreaker`. The `setPasteGuard` flag (so the passive hotkey listener ignores the
synthetic keystroke flood) maps to Handy's existing recording-mode/guard plumbing; held an extra
`PASTE_GUARD_TAIL_MS` after the keystroke. Auto-submit (Enter / Ctrl+Enter) is already in Handy's
`clipboard.rs::send_return_key` — no port needed.

---

## 5. Audio ducking — `ducking.rs`

Handy's `managers/audio.rs::set_mute` hard-MUTES via `IAudioEndpointVolume::SetMute(true)`. WinSTT DUCKS
(graduated) and that difference is deliberate (mute shows the Windows OSD pill on every PTT; a crash leaves
the user muted). `ducking.rs` uses the **same `windows`-crate interface Handy already enables** — no new
Cargo features (`Win32_Media_Audio_Endpoints` + `System_Com` + `StructuredStorage` + `Variant` +
`Foundation` are present).

- **Pure reduction math** (`reduction_target`, `clamp_scalar`, `parse_volume`, `restore_target`) ported from
  `audio-mute.ts`: `target = clamp(prev × (100-pct)/100)`; pct=100 ⇒ 0.0 (full mute); restore fallback 0.5.
  Fully tested.
- **Two-layer state** (`DuckState`: `desired_muted` intent vs `ducked` effect) — ensures an unmute that races
  an in-flight duck still schedules a restore (the exact race documented in `audio-mute.ts`). A failed duck
  (`on_duck_complete(None)`) leaves the effect un-ducked so a later restore is correctly skipped. Fully tested.
- **Real COM impl** (`read_master_volume` / `set_master_volume` / `perform_duck` / `perform_restore`) modeled
  on Handy's `set_mute` (same `CoInitializeEx(MULTITHREADED)` + `MMDeviceEnumerator` +
  `GetDefaultAudioEndpoint(eRender, eMultimedia)` + `Activate::<IAudioEndpointVolume>` pattern). Uses
  `GetMasterVolumeLevelScalar()` / `SetMasterVolumeLevelScalar(level, null)` (signatures verified against
  `windows` 0.61). Non-Windows stubs so cross-platform wiring compiles.

The manager serializes the COM work on a worker (mirrors `scheduleApply`'s in-flight chaining) and feeds
results into `DuckState`. Wire `perform_duck` on `recording_start`, `perform_restore` on `recording_stop` and
`before_quit` (the duck level is `audio.muteSystemAudioReduction` or equivalent — read it from settings; 100
= full mute is the historical default).

---

## 6. Frontend IPC re-wire plan (`window.electronAPI.*` → Tauri `invoke`/events)

The reused React renderer currently calls Electron IPC. In Tauri it calls `invoke(...)` (commands) and
`listen(...)` (events). Below is the mapping for THIS slice's channels. Commands live in
`src/commands/llm.rs` / `cloud_stt.rs` / `context.rs` (new files registered in `lib.rs`'s `collect_commands!`,
per the Handy command convention); events are `app.emit("…", payload)`.

### LLM

| Electron IPC | Tauri | Backed by |
|---|---|---|
| `LLM_PROCESS_TEXT` / `processText(text, ctx, feature)` | `invoke("process_text", {text, context, feature})` → `String` | `llm::build_dictation_system_prompt` + Ollama/OpenRouter dispatch + `apply_replacement_pairs` |
| `LLM_PROCESS_TEXT_CUSTOM` (transforms) | `invoke("process_transform", {text})` | `llm::transforms_user_prompt` + custom system prompt |
| `LLM_SCAN_MODELS` (Ollama `/api/tags`) | `invoke("scan_ollama_models", {endpoint})` | reqwest `/api/tags` + `/api/show` capability enrich |
| OpenRouter `/models` scan | `invoke("scan_openrouter_models", {api_key})` | reqwest `/api/v1/models` + per-model `/endpoints` enrich |
| `LLM_DETECT_OLLAMA` / `_START_OLLAMA` / `_PULL_MODEL` / `_DELETE_MODEL` | `invoke("ollama_detect"/"ollama_pull"/…)` | reqwest + process spawn |
| `LLM_REASONING_DELTA` (event) | `listen("llm-reasoning-delta", {delta})` | `ReasoningSink` → `app.emit` |
| `LLM_LEARNED_PROPER_NOUNS` (event) | `listen("llm-learned-proper-nouns", {nouns})` | `extract_learned_proper_nouns` → `app.emit` |

### Cloud STT + credentials

| Electron IPC | Tauri | Backed by |
|---|---|---|
| `stt_cloud_transcribe_request` (WS, internal) | **gone** — called inline by `TranscriptionManager` when model id is `openai:`/`elevenlabs:` | `cloud_stt::CloudTranscriber` |
| `STT_CLOUD_AUTH_FAILED`/`_NETWORK_ERROR`/`_RATE_LIMITED`/`_PROVIDER_ERROR` (events) | `listen("stt-cloud-error", {code, provider, message, retry_after})` | `CloudSttError` → `app.emit` (one channel, `code` discriminates; `aborted` suppressed) |
| `INTEGRATIONS_VERIFY` / `verify(provider, key)` | `invoke("verify_credential", {provider, api_key})` → `VerifyResult` | `cloud_stt::classify_verify` over a GET probe |

### Context-awareness

Context capture is **internal** (no renderer IPC in the normal flow) — the dictation pipeline calls
`context::capture_prompt_fragment(reader, mode, deny_list)` on `recording_start` and feeds the result into
`process_text`. The only renderer-facing surface is the **context-playground debug window**
(`memory/project_context_playground_debug.md`), gated by a debug flag:

| Electron IPC | Tauri | Backed by |
|---|---|---|
| context-playground "read now" | `invoke("debug_read_context", {mode})` → snapshot + `debug_verdicts` | `context::ContextReader` + `debug_verdicts` |

Keep the playground behind a compile-time/feature flag (flip off before release), mirroring
`CONTEXT_PLAYGROUND_ENABLED`.

### Paste / ducking

Both are internal (driven by the transcribe pipeline + `recording_start`/`_stop`), not renderer IPC. The
renderer only reads the relevant settings (`paste_method`, `append_trailing_space`, `auto_submit`,
mute-reduction pct) via the normal settings `invoke("get_app_settings")`.

---

## 7. History schema reconciliation (note for the history slice)

Handy's `HistoryManager` (`managers/history.rs`, **bundled rusqlite**) is the canonical store in the port —
the WinSTT `node:sqlite` constraint was Electron-specific and does NOT apply (`memory/project_history_uses_node_sqlite_not_better_sqlite3.md`).
This slice only TOUCHES history via the LLM post-process columns. WinSTT's legacy electron-store history
(`transcription-history.ts`) is superseded by the SQLite schema. The fields this slice produces that the
history row must carry (matching Handy's `HistoryEntry` + WinSTT's pre/post-LLM split):

- `text` (raw transcription) and `post_processed_text` (after `process_text`) — both stored;
- `post_process_prompt` (the composed system prompt, for the retry path);
- `post_process_requested` (boolean — whether the LLM ran);
- cloud entries have **no WAV** (`wav_path = NULL`) — the cloud path doesn't capture local audio.

Handy's `process_transcription_output` (in `actions.rs`) is the equivalent of WinSTT's relay
`handleFullSentence`: transcribe → (OpenCC variant) → `process_text` (this slice) → paste → `save_entry`. The
LLM call slots in where `post_process_transcription` currently is. **No history schema change is owned by this
slice** — just ensure `process_text` returns both the cleaned text and (via the broadcast events) the learned
proper nouns + reasoning trace.

---

## 8. File transcription (ffmpeg shell-out) outline

WinSTT-Electron's `file-transcribe.ts` accepts 14 audio/video extensions; the Python pipeline decoded them.
The Rust port has no Python decoder, so:

1. **Decode to 16 kHz mono PCM via an `ffmpeg` shell-out** (the universal decoder for mp3/m4a/aac/ogg/wma/
   mp4/mkv/avi/mov/wmv/flv/webm; wav/flac can go through `hound`/`symphonia` directly):
   `ffmpeg -i <input> -ac 1 -ar 16000 -f s16le -` → read raw PCM from stdout → `Vec<f32>`.
   Bundle `ffmpeg` as another `externalBin` sidecar (like `winstt-context`), or require it on PATH with a
   clear error. (A pure-Rust `symphonia` decoder covers most containers WITHOUT ffmpeg for a lighter bundle —
   evaluate at build time; ffmpeg is the safe universal default.)
2. **Chunk + VAD-segment** the decoded PCM (reuse the VAD slice's segmenter for real per-chunk progress —
   `memory/project_file_transcription_queue.md` fixed the 30%-stall by using a lazy VAD iterator), then feed
   each segment to `TranscriptionManager::transcribe` (local) or `cloud_stt` (cloud model).
3. **Sequential queue** with per-file progress events (`listen("file-transcription-progress", …)` /
   `"…-complete"` / `"…-error"`), PTT pause/resume (request-scoped cancel), and a model-swap block — all
   manager-thread concerns, mirroring the Electron queue.

This is a **separate slice's** detailed work (file-transcribe wasn't in this slice's outputs); the outline is
here so the LLM/cloud/context pieces compose with it. The cloud-STT audio limits (`provider_audio_limit_bytes`)
apply per segment for cloud file-transcription — split long files into per-utterance segments (the OpenAI
25 MB / ElevenLabs 1 GB caps).

---

## 9. lib.rs wiring (what must be registered)

Add to `src/lib.rs` (compile loop), per `app/PORT/lib_wiring.md`:

- `pub mod winstt;` (once, if not already added by another slice).
- **Managers** (`initialize_core_logic`, then `app.manage(Arc<…>)`):
  - an `LlmManager` (owns the reqwest client, Ollama capability cache, active-chat cancel tokens, warmup loop);
  - a `CloudSttManager` (owns the in-flight cloud-transcribe tokens);
  - a `ContextManager` (owns the sidecar path resolution + reader);
  - the ducking state lives on the existing `AudioRecordingManager` (extend it with a `DuckState` field) so it
    shares the recording lifecycle — do this via a new method, not by editing `set_mute`.
- **Commands** in `collect_commands!`: `process_text`, `process_transform`, `scan_ollama_models`,
  `scan_openrouter_models`, `ollama_*`, `verify_credential`, `debug_read_context` (feature-gated).
- **Events**: `llm-reasoning-delta`, `llm-learned-proper-nouns`, `stt-cloud-error`,
  `file-transcription-progress`/`-complete`/`-error` (file slice). Plain `app.emit` string events (Handy only
  uses the typed `tauri_specta::Event` for `HistoryUpdatePayload`).
- **Sidecar**: `externalBin: ["binaries/winstt-context"]` in `tauri.conf.json`; copy the built
  `winstt-context.exe` into `src-tauri/binaries/<triple>.exe`.
- **`windows` features**: add `Win32_System_Threading` (for `QueryFullProcessImageNameW` in `paste_ext`).
- **Crate deps** (compile loop): `tauri-plugin-shell` (if using sidecar transport A); `futures-util` is
  already present (Ollama stream drain); `reqwest` already present with `json`+`stream` (cloud multipart needs
  the `multipart` feature added).

---

## 10. Test status

| Module | Pure logic tested | Heavy bit (interface/sketch) |
|---|---|---|
| `llm/mod.rs` | preset composition, custom-modifier merge, prefix layering, replacement-pairs, all 4 leakage/salvage extractors, finalize priority, Ollama body/flags/stream-state, OpenRouter extras, endpoint normalization (~35 tests) | reqwest NDJSON streaming transport (`OllamaChat` trait) |
| `cloud_stt.rs` | audio limits, status taxonomy, retry-after, EL scoped-key, verify classify, preflight, JSON parse (~12 tests) | reqwest multipart upload (`CloudTranscriber` trait) |
| `context.rs` | JSON parse, deny-list (exe/host/wildcard), redaction, IDE/terminal/canvas detect, host extraction, prompt formatter (focused-first/terminal/thin), fake-reader capture (~18 tests) | sidecar `Command` spawn (`ContextReader` trait) |
| `paste_ext.rs` | terminal tables, keystroke pick, fallback chain, circuit-breaker + pacing, sandwich timing (~10 tests) | `GetForegroundWindow`/`GetClassNameW`/`QueryFullProcessImageNameW` probe |
| `ducking.rs` | reduction math, clamp, parse_volume, two-layer state machine incl. the unmute-races-duck case (~12 tests) | real COM impl present (verified against `windows` 0.61 signatures) |

None compile yet (Rust not installed). The pure logic is real and unit-tested; the heavy ML/OS bits are
traits + documented sketches per the slice's hard rule.
