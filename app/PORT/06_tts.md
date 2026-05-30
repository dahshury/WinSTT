# 06 — TTS (local Kokoro + cloud ElevenLabs)

> Slice output: `src-tauri/src/winstt/tts/mod.rs` (DRAFT stub + tested deterministic logic) and this doc.
> Behavioral reference: `server/src/synthesizer/` (Python Kokoro hexagonal subsystem) and
> `frontend/electron/ipc/{tts.ts, tts-cloud.ts, tts-reader.ts, tts-hotkey.ts}` (Electron orchestration).
> Authoritative settings: `frontend/src/shared/config/settings-schema.ts` → `ttsSettingsSchema`.

TTS is an **opt-in** feature: `tts.enabled` defaults `false`; nothing downloads or loads until the user
turns it on and the first synthesis request fires. It has two sources, selected by `tts.source`:

- **`local`** — in-process Kokoro-82M ONNX on `ort` (the blueprint choice). 54 voices / 9 languages, offline.
- **`cloud`** — ElevenLabs via `reqwest`. Selectable only when the ElevenLabs key is present **and** verified.

Both sources emit chunks on the **same wire contract** so the renderer's Web-Audio playback queue is
source-agnostic. The dynamic-island playback UI and the read-selection hotkey are shared across both.

---

## ⚠️ LICENSING — espeak-ng (GPL-v3) makes the whole binary GPL-v3

**This is the single most important decision in the TTS slice. Read it before linking anything.**

Kokoro needs a **grapheme→phoneme (G2P) phonemizer**. The de-facto phonemizer for the entire Kokoro
ecosystem — Python (`kokoro-onnx` → `phonemizer-fork` → `espeakng-loader`) and every mainstream Rust crate —
is **espeak-ng**, which is **GPL-v3**.

Verified (2026-05) crate landscape:

| Crate | License | Phonemizer | ORT | Notes |
|---|---|---|---|---|
| **`kokorox`** (byteowlz / WismutHansen fork) | **GPL-3.0** | espeak-ng via `espeak-rs-sys` (**static link**) | `ort` | Streaming, voice-mix, 8+ langs. License is GPL-3.0 *specifically because* `espeak-rs-sys` statically links espeak-ng. |
| **`kokoros`** (lucasjinreal) | mixed | espeak-ng (and an optional in-tree phonemizer added Jan-2025) | `ort` | HTTP/streaming server; CLI streaming. |
| **`kokoroxide`** | check at pin time | espeak-ng (Misaki notation) | `ort` | Espeak-ng for G2P. |
| **`any-tts`** | check at pin time | **in-tree pure-Rust phonemizer** (espeak-rs-compatible interface) — *no system/linked espeak-ng* | `ort` | The one crate that advertises an espeak-ng-free path. **Verify its actual license + phoneme quality before relying on it.** |

> **Cargo-linking ANY espeak-ng-backed crate statically into the Tauri binary makes the entire WinSTT
> binary GPL-v3.** Dynamic linking of a GPL library into a non-GPL aggregate is still a derivative work
> under the GPL — the only thing that cleanly preserves a non-GPL app is **process separation** (a separate
> GPL executable invoked over IPC = "mere aggregation", per the FSF's own guidance).

### What "GPL-v3 binary" means for WinSTT, concretely

- The whole `WinSTT.exe` (Rust + bundled webview) becomes a GPL-v3 work. You must offer **complete
  corresponding source** to anyone you ship a binary to, and you cannot add proprietary distribution terms.
- The blueprint (`PORT/README.md`) **explicitly accepts this** for the in-process default: *"TTS = Local
  Kokoro in-process (cargo-link) ⚠️ espeak-ng is GPL-v3 → app inherits GPL-v3."* So the **default build is
  GPL-v3 and that is an accepted, deliberate choice.**

### The three escape hatches (in priority order)

1. **Pure-Rust phonemizer (preferred if it holds up).** If `any-tts` (or an equivalent in-tree
   espeak-rs-compatible phonemizer) ships under a permissive license **and** its phoneme output matches
   espeak-ng closely enough for Kokoro to sound right, link *that* and the GPL problem disappears entirely —
   in-process, no sidecar. **Action: A/B the pure-Rust phonemizer vs espeak-ng on the 9 languages during the
   build loop; if quality is acceptable, this is the answer.** Risk: Kokoro was trained on Misaki/espeak-ng
   phonemes; a different G2P can degrade pronunciation, worst on `ja`/`cmn`/`hi`.

2. **Sidecar (the documented fallback if the app must stay proprietary).** Build a **separate GPL-v3
   executable** — `winstt-kokoro-sidecar.exe` — that statically links `kokorox`/espeak-ng and does ONLY
   Kokoro synthesis. The proprietary `WinSTT.exe` spawns it and talks over **stdio or a local IPC channel**
   (line-framed JSON control + raw f32 PCM on stdout). Because the GPL code lives in a distinct program that
   communicates only at arm's length, this is **mere aggregation** and the main app stays under its own
   license. This is conceptually close to WinSTT-Python's current shape (the Electron app talks to a
   separate Python process that holds Kokoro). Cost: ~one extra process + a tiny framing protocol. The
   `TtsEngine` trait in `mod.rs` is engine-agnostic precisely so a `SidecarKokoroEngine` slots in with **zero
   call-site changes** — only `TtsManager::new` picks a different engine.

3. **Cloud-only / drop local TTS.** If neither (1) nor (2) is acceptable, ship cloud ElevenLabs as the only
   TTS source and gate local Kokoro out of the build. Loses offline TTS — not recommended (offline is a
   WinSTT differentiator).

**Recommendation:** default build = in-process Kokoro under GPL-v3 (blueprint-sanctioned). Keep the sidecar
design ready in the same module. Spike the pure-Rust phonemizer early — if it works, adopt it and the whole
licensing question evaporates.

---

## 1. End-to-end data flow (Rust/Tauri)

This is **simpler than WinSTT-Python** because there is no Python process and no WebSocket: the engine is a
Rust dependency in the same process as the Tauri backend.

```
renderer (read-selection hotkey OR "Speak selection" button)
  → Tauri command  tts_speak_selection  / tts_speak { text }
    → host: captureSelection() (rdev/UIA), pick engine by tts.source
      → TtsManager.read_aloud(request_id, text, voice, lang, get_speed, sink)
        → split into sentences (split_sentences — REAL, tested)
          → per sentence: engine.synthesize_stream(...) pushes SynthesisChunk via ChunkSink
            → host emits a Tauri event  tts://chunk  { request_id, sample_rate, seq, is_final, format, channels, pcm }
              → renderer Web-Audio playback queue schedules it gap-free
```

There is **no binary WebSocket frame** to pack/unpack (WinSTT's `[uint32 len][json][f32 PCM]` wire format
is gone). Tauri's event channel carries the metadata + a `Vec<u8>`/`ArrayBuffer` payload directly. The
renderer-side contract (the JSON field shape) is preserved verbatim so the existing `features/tts-playback`
queue needs no changes.

### Wire contract (host → renderer, unchanged from WinSTT)

```jsonc
// tts://chunk
{
  "request_id": "…",
  "sample_rate": 24000,   // local Kokoro; 0 for an encoded cloud chunk (the container carries it)
  "seq": 0,
  "is_final": false,
  "format": "f32le",      // local Kokoro raw mono float | "mp3" for cloud (renderer decodeAudioData's)
  "channels": 1,
  "pcm": <bytes>          // f32le samples, or the encoded mp3 bytes
}
```

Companion events (verbatim names from WinSTT, re-homed onto Tauri's event bus):
`tts://started`, `tts://completed { cancelled, elapsed_ms }`, `tts://failed { reason, category }`,
`tts://model-download-{start,progress,complete}`, `tts://playback-{started,ended}`.

---

## 2. The `TtsEngine` trait + two engines

`mod.rs` defines an engine-agnostic port so the local/cloud/sidecar engines are interchangeable:

```rust
pub trait TtsEngine: Send + Sync {
    fn synthesize_stream(&self, text: &str, voice: &str, lang: &str, speed: f32, sink: &dyn ChunkSink) -> TtsResult<()>;
    fn list_voices(&self) -> Vec<VoiceInfo>;
    fn is_ready(&self) -> bool;
    fn warm_up(&self) -> TtsResult<()>;   // blocking; host runs off the UI thread
    fn shutdown(&self);
}
```

- **`KokoroEngine`** (local) — STUB body; deterministic guards (empty-text no-op, 8000-char cap) are real.
- **`ElevenLabsEngine`** (cloud) — STUB network body; the **request builder + status classifier are real and
  tested** (`build_cloud_url`, `build_cloud_body`, `classify_cloud_status`).
- **`SidecarKokoroEngine`** (fallback, not yet written) — same trait, spawns the GPL sidecar.

`synthesize_stream` is **blocking** and pushes chunks via `ChunkSink` rather than returning an async
iterator. This honors the WinSTT invariant *"never run model load / inference on the async pump"* — the host
runs the engine on a dedicated thread (`tauri::async_runtime::spawn_blocking` or `std::thread`) so the UI
event loop never stalls on the ~190 MB first-run download or session create. The `ChunkSink::is_cancelled`
poll is the cooperative cancel point (checked between sentences, like the Python `should_cancel`).

---

## 3. Local Kokoro engine (`ort` 2.0.0-rc.12)

### On-demand model download — SIMPLER than WinSTT's sys.path pack

WinSTT-Python ships **zero TTS code** in the frozen exe and downloads a **sys.path-injected support pack**
(`winstt-tts-pack-cp312-win_amd64.zip`, ~30 MB) containing `kokoro_onnx` + its dep closure, then *also*
downloads the model weights. That whole engine-pack mechanism (`support_pack.py`: `ensure_support_pack`,
`activate`, `sys.path.insert`, sentinel, double-nest corruption guard, `repair_and_reinstall`) **does NOT
exist in the Rust port** — the Kokoro engine is a compiled-in `cargo` dependency, so the engine is already
present. We only download the **two model files**:

| File | Size | Source (upstream, pinned) |
|---|---|---|
| `kokoro-v1.0.fp16.onnx` | ~163 MB | `github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.fp16.onnx` |
| `voices-v1.0.bin` | ~27 MB | `github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin` |

fp16 is chosen for ~fp32 quality at 163 MB. Cache dir: `%LOCALAPPDATA%/winstt/tts/kokoro` (resolved by the
host; sibling of the STT cache). Reuse the STT slice's resumable downloader (`.partial` → atomic rename,
HTTP `Range:` resume, pause/cancel) — the download UX (confirm dialog, pause/resume/cancel, progress bar) is
identical to STT model downloads. Estimated install size for the confirm dialog ≈ **190 MB** (163 + 27),
**not** WinSTT's ~220 MB (no 30 MB engine pack).

> Note on the host mismatch flagged in inventory 05_tts.md §"Gaps": WinSTT's support-pack constant points at
> `dahshury/WinSTT` but memory `project_private_repo_breaks_pack_distribution` says the verified-working host
> is the public `dahshury/winstt-assets`. **The Rust port sidesteps this entirely for the engine** (compiled
> in), and the two MODEL files come from the **upstream public** `thewh1teagle/kokoro-onnx` release — no
> private-repo tokenless-404 risk. Keep both URLs overridable via env for CI/self-host.

### ORT session + device policy (device follows the model device)

There is **no standalone TTS device setting** — TTS shares the **main STT model's device** (`model.device`),
which the host maps onto `LocalTtsConfig.device` (memory `project_tts_device_follows_model_device`: the old
`tts.device` picker was removed as redundant *and* dead). EP resolution:

| `TtsDevice` | EP | Fallback |
|---|---|---|
| `Cpu` | `CPUExecutionProvider` | — |
| `DirectMl` | `DirectMLExecutionProvider` | CPU on session-create failure |
| `Auto` | try DirectML | CPU on session-create failure (graceful demotion, like WinSTT's CUDA→CPU) |

**Kokoro is DirectML-SAFE.** It is an 82M fp16 model and is **NOT** in the int8 DML-incompatible STT families
(NeMo/Cohere/GigaAM/Kaldi/SenseVoice/Dolphin — those are forced to CPU per `03_stt_engine.md`). So Kokoro can
follow the model device onto DirectML without the CPU-pin those STT families need. Reuse the STT slice's
shared EP-resolution helper so there is **one** ort init path in the whole app.

### Streaming synthesis (gap-free, per sentence)

`read_aloud` splits text into sentences (`split_sentences`, a verbatim behavioral port of
`tts-reader.ts splitSentences` — **real, fully tested**) and synthesizes each in order under **one parent
`request_id`**. Per sentence the engine pushes one or more `SynthesisChunk { format: F32le, seq, is_final }`;
the renderer queue concatenates them gap-free. The **last** chunk of the whole read is flagged
`is_final` (delay one chunk to know which is last, mirroring the Python adapter).

Why per-sentence and not whole-passage: it lets playback **start early** AND makes the dynamic-island speed
control work at natural pitch — a mid-read speed change is sampled by `get_speed()` before each sentence and
takes effect on the **next** sentence via re-synthesis (the playing sentence finishes at its original speed).
This is re-synthesis, **not** `playbackRate`, so pitch stays natural (memory
`project_tts_dynamic_island_playback`). Local speed steps: `[1, 1.25, 1.5, 2]`, clamped `0.5..2.0`.

Concurrency: serialize all synthesis behind a `Mutex` — Kokoro sessions are not re-entrant (mirrors the
Python `_synth_lock`; without it, two fast hotkey presses corrupt the session).

Input guards (real, tested): empty/whitespace text → silent no-op; text > **8000 chars** → reject (defends a
known Kokoro phoneme-overflow `IndexError`).

---

## 4. Cloud ElevenLabs engine (`reqwest`)

WinSTT-Electron routes cloud TTS through the Vercel AI SDK (`experimental_generateSpeech`). The Rust port
calls ElevenLabs **directly via `reqwest`** (task requirement) — there is no Rust AI-SDK equivalent and the
endpoint is a single POST.

- **Endpoint:** `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=<fmt>`
  - header `xi-api-key: <key>` (key read from the encrypted store in the host, never reaches the renderer)
  - body from `build_cloud_body` (real, tested): `{ text, model_id, voice_settings: { stability,
    similarity_boost, style, use_speaker_boost, speed } }` — ElevenLabs on-wire snake_case; `speed` is folded
    into `voice_settings` and clamped to `0.7..1.2`.
- **Output format:** request **mp3** (`mp3_44100_128`), NOT raw PCM. Verified against ElevenLabs docs +
  WinSTT's `tts-cloud.ts`: raw `pcm_*` (and 44.1 kHz PCM/WAV) is **gated behind the Pro tier and 402s on
  free/starter keys**. mp3 is available on every tier; the renderer decodes it via Web Audio
  (`decodeAudioData`), so no decoder is needed host-side. Emit it as ONE chunk `format: "mp3"`,
  `is_final: true` (ElevenLabs convert is one-shot, non-streaming).
- **Voice catalog:** `GET https://api.elevenlabs.io/v2/voices?page_size=100` (a plain `reqwest` GET, includes
  the account's cloned voices). Map each entry to `{ id, name, language, category, preview_url }`. This is
  catalog discovery, not the static Kokoro catalog — `ElevenLabsEngine::list_voices()` returns empty by
  design; the host fetches the live list separately.
- **Voice preview:** the `preview_url` from `/v2/voices` is a static CDN mp3 — fetch it (no character credits)
  and play it through the same chunk pipeline. Refuse any non-`https://` URL (trust-boundary check).
- **Cancellation:** track in-flight requests by `request_id` in a `Map<String, CancellationToken>` (or an
  `AbortController` analog); a stop gesture / model swap / app exit aborts the request instead of playing
  stale audio.
- **Error classification** (`classify_cloud_status`, real + tested, mirrors `tts-cloud.ts`):
  `401/403 → invalid key`, `402 → "needs a paid plan"`, `429 → rate limited`, else generic HTTP. Prefer the
  ElevenLabs `detail.status` body field when present (`quota_exceeded`, `missing_permissions`,
  `invalid_api_key`, `voice_not_found`) — it is more specific than the bare HTTP code. A scoped key missing
  `voices_read` can still synthesize, so don't mislabel a `missing_permissions` 401 on `/v2/voices` as an
  invalid key (memory `project_elevenlabs_scoped_key_verify`).
- **Cloud gating:** the cloud source is selectable only when `integrations.elevenlabs.verified === true`. A
  `GET /v1/user/subscription` probe surfaces tier (premium-voice locking) + whether the character quota is
  exhausted (disables cloud entirely); default both to "unknown / not-exhausted" on a failed probe so we
  never wrongly block, with the 402 as the backstop.

---

## 5. Read-selection hotkey (rdev)

WinSTT-Electron uses a passive `uiohook-napi` listener; the Rust port uses **`rdev`** (Handy's input
backend) the same way the STT hotkeys do — a passive global listener, **not** an exclusive OS hotkey.

- Default combo `tts.hotkey` = **`LWin+LShift+E`** (schema default `"LMeta+LShift+E"`, always non-empty so
  the conflict checker has something to compare and the recorder UI never shows an empty chip).
- On combo **hold**: `captureSelection()` (the same selection-capture path STT context-awareness uses — UIA
  on Windows) → `TtsManager.read_aloud(...)`. **Single-shot per hold** (`fired_this_hold` latch) so OS
  auto-repeat doesn't fire dozens of syntheses.
- **Stop gesture:** combo + **Backspace** → `cancel_all()` (cooperative cancel + optimistic renderer queue
  stop).
- Respect the paste guard + "any hotkey currently recording" guards so the read doesn't fire while the user
  is rebinding a key or a paste is in flight.

---

## 6. Dynamic-island playback (renderer-side, Web Audio — UNCHANGED)

Playback stays **entirely in the renderer** (memory `project_tts_dynamic_island_playback`). The host does
**pure plumbing** — it emits `tts://chunk` events and never decodes audio. Reuse the existing
`features/tts-playback` (and its overlay-inlined dynamic-island UI) verbatim:

- **Playback queue** lives inside the overlay window (`backgroundThrottling: false` so the rAF/analyser run
  accurately even when hidden). Gap-free Web-Audio scheduler; `f32le` plays raw, `mp3` is `decodeAudioData`'d.
- **Forced dynamic-island pill** on every real read (hotkey / speak-selection) with a live visualizer +
  speed / pause / discard. Reuses the shared `useVisualizerStore` (STT and TTS never overlap in the overlay).
- **Pause/resume** = `AudioContext.suspend()/resume()` with a `paused` latch (a chunk arriving mid-pause must
  not auto-resume). **Discard** = `queue.stop()` + `tts_cancel`.
- **STT force-stops TTS:** when recording / thinking starts, the renderer discards TTS and the host belt
  triggers `cancel_all()` before showing the overlay. STT always wins the overlay.
- Speed-step VALUES live renderer-side (`[1,1.25,1.5,2]` local, `[0.9,1,1.1,1.2]` cloud); the pill computes
  the next speed and sends it; the host clamps (`clamp_speed` / `clamp_cloud_speed`) and persists it.

The only change vs WinSTT is the transport: `IPC.TTS_CHUNK` (Electron) → `tts://chunk` (Tauri event). The
JSON field shape is identical, so the queue code is untouched.

---

## 7. Settings (`ttsSettingsSchema`, authoritative)

| Key | Type | Default | Notes |
|---|---|---|---|
| `tts.enabled` | bool | `false` | Engine loads only on first synthesis. |
| `tts.voice` | string | `"af_heart"` | Kokoro voice id (local). |
| `tts.lang` | string | `"en-us"` | Kokoro lang code (local). |
| `tts.speed` | number 0.5..2.0 | `1.0` | Local multiplier. |
| `tts.hotkey` | string (min 1) | `"LMeta+LShift+E"` | Read-selection combo; always non-empty. |
| `tts.source` | enum `local`/`cloud` | `"local"` | Cloud gated on verified ElevenLabs key. |
| `tts.cloud.voice` | string | `""` | ElevenLabs `voice_id` (live `/v2/voices`). |
| `tts.cloud.model` | string | `"eleven_multilingual_v2"` | |
| `tts.cloud.stability` | number 0..1 | `0.5` | → `voice_settings.stability` |
| `tts.cloud.similarity` | number 0..1 | `0.75` | → `voice_settings.similarity_boost` |
| `tts.cloud.style` | number 0..1 | `0.0` | → `voice_settings.style` |
| `tts.cloud.speed` | number 0.7..1.2 | `1.0` | → `voice_settings.speed` |
| `tts.cloud.speakerBoost` | bool | `true` | → `voice_settings.use_speaker_boost` |

> There is **no `tts.device`** — TTS follows `model.device` (memory `project_tts_device_follows_model_device`).
> The ElevenLabs key is shared with cloud STT via `integrations.elevenlabs.apiKey` (encrypted at rest); no new
> key storage. See `02_settings.md` for the full schema and Rust mapping.

---

## 8. Voice catalog (54 voices / 9 languages) — real data

`mod.rs` ships `KOKORO_VOICE_CATALOG` (54 `VoiceInfo`) and `SUPPORTED_LANGUAGES` (9 `(code, label)`) as a
verbatim port of `voice_catalog.py`. The `id` and `language` strings are **exactly** what the Kokoro engine
accepts — do not re-case or re-map them. Per-language counts (asserted in tests):

| Language (code) | Voices |
|---|---|
| American English `en-us` | 20 (11 F + 9 M) |
| British English `en-gb` | 8 (4 F + 4 M) |
| Japanese `ja` | 5 |
| Mandarin `cmn` | 8 |
| Spanish `es` | 3 |
| French `fr` | 1 |
| Hindi `hi` | 4 |
| Italian `it` | 2 |
| Brazilian Portuguese `pt-br` | 3 |

---

## 9. `lib.rs` wiring (for `lib_wiring.md`)

- **Manager:** construct a `TtsManager` (with the engine picked from `tts.source`) and put it in Tauri
  managed state. Local engine = `KokoroEngine::new(LocalTtsConfig { device: <model.device>, .. })`; cloud =
  `ElevenLabsEngine::new(key, model, settings)`. Re-pick the engine when `tts.source` or the key changes.
- **Commands to register:** `tts_speak { text }`, `tts_speak_selection`, `tts_cancel { request_id? }`,
  `tts_init` (warm-up off-thread), `tts_list_voices` (local static catalog), `tts_list_cloud_voices`
  (`reqwest` GET `/v2/voices`), `tts_cloud_subscription`, `tts_download_estimate`,
  `tts_install_{pause,resume,cancel}`, `tts_preview_cloud { preview_url }`.
- **Events to emit:** `tts://started`, `tts://chunk`, `tts://completed`, `tts://failed`,
  `tts://model-download-{start,progress,complete}`, `tts://playback-{started,ended}`.
- **Hotkey:** register the `tts.hotkey` combo on the shared `rdev` listener (passive), single-shot per hold,
  Backspace = stop-all. Respect paste/recording guards.
- **Shutdown:** on `before-quit`, `cancel_all()` + `engine.shutdown()` (drops the ort session / aborts cloud).

---

## 10. Acceptance tests (for the build loop)

Deterministic (already in `mod.rs`, run with `cargo test`): catalog = 54 voices / 9 langs, every voice's lang
is supported, per-language counts match WinSTT, ids unique, default voice exists; `clamp_speed` 0.5..2.0 and
`clamp_cloud_speed` 0.7..1.2; `split_sentences` parity (3-sentence split, trailing un-terminated run,
trailing-quote consumption, multi-terminator collapse, over-long word-boundary cap, single over-long word
hard-split); cloud URL/body builder (snake_case mapping, speed clamp, tier-safe `output_format`); status
classifier; engine stub guards (empty-text no-op, missing-key/voice rejection).

Integration (need a live build + assets):
1. First-run download of the two Kokoro files (resumable; pause/resume/cancel) → confirm ~190 MB.
2. Local synth: hotkey → select text → read aloud, gap-free, DirectML engaged with CPU fallback.
3. Speed change mid-read applies on the next sentence at natural pitch.
4. STT start force-stops an in-progress read.
5. Cloud synth: ElevenLabs mp3 round-trip, 402 on a free-tier PCM request handled with the paid-plan message.
6. **Licensing build check:** if the in-process Kokoro crate is GPL-v3, confirm the build manifest declares
   GPL-v3; if the proprietary path is required, confirm the sidecar variant is selected and `WinSTT.exe`
   carries no statically-linked espeak-ng symbols.

---

## 11. Open questions / risks

- **Phonemizer quality vs license** is the crux. The pure-Rust phonemizer (escape hatch #1) is the only way
  to get in-process Kokoro *without* GPL-v3, but it may degrade pronunciation (Kokoro was trained on
  espeak-ng/Misaki phonemes), worst on `ja`/`cmn`/`hi`. Must be A/B'd before committing.
- **Sample rate:** Kokoro v1.0 emits 24 kHz mono — used as the chunk `sample_rate`. Confirm the chosen crate
  actually emits 24 kHz (don't hardcode blindly; read it from the engine output if exposed).
- **Crate pin:** pin the exact Kokoro crate + version once selected and re-verify its license at that pin
  (licenses change across versions). `ort = "2.0.0-rc.12"` (MIT/Apache, ONNX Runtime 1.24) is the shared
  STT/TTS runtime — keep ONE ort version across slices.
- **Voice-mix:** WinSTT does not expose Kokoro voice-blending (`af_sky.4+af_nicole.5`); `kokorox` does. Out of
  scope for parity, but the trait wouldn't block adding it later.
