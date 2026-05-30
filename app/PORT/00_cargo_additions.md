# PORT/00 — Cargo.toml dependency additions (the full blueprint)

> **Status:** SPEC. This file is the authoritative list of every crate the WinSTT → Rust/Tauri
> port adds on top of the Handy foundation already in `app/src-tauri/Cargo.toml`. Nothing here
> is compiled yet (Rust is not installed). Versions verified against crates.io / docs.rs in
> **2026-05** — re-confirm with `cargo update` / `cargo tree` once the toolchain lands.
>
> **HARD RULE:** do NOT edit Handy's existing `Cargo.toml` deps in a way that conflicts with the
> upstream-merge story. The additions below are *additive*; the one mandatory **reconciliation** is
> the `transcribe-rs` version pin (it owns `ort`, see §0). Everything else slots in cleanly.

---

## 0. The load-bearing reconciliation: `ort` ↔ `transcribe-rs` (READ FIRST)

The single biggest version-conflict risk in the whole port. We need `ort` directly (the unified
ONNX engine in `03_stt_engine.md` runs all ~40 models through `ort::Session` — not through
`transcribe-rs`'s pre-baked engine enums), AND `transcribe-rs` already depends on `ort`. **If the two
resolve to different `ort` major/pre-release versions, Cargo links TWO copies of `ort` → two copies of
the bundled `onnxruntime.dll` → `Ort: API version mismatch` / duplicate-symbol / double-init crashes
at session create.** ORT is a C library wrapped by a global; you cannot have two of it in one process.

### Verified facts (2026-05)

| Fact | Value | Source |
|---|---|---|
| Current Cargo.toml `transcribe-rs` base pin | `0.3.8` (+ `0.3.3` in per-OS target blocks) | `app/src-tauri/Cargo.toml` L74, L93/105/110 |
| `ort` that `transcribe-rs` **0.3.8** depends on | **`=2.0.0-rc.12`** (exact pin) | docs.rs `transcribe-rs/0.3.8/features` |
| `ort` that `transcribe-rs` **0.3.11** (latest) depends on | `=2.0.0-rc.12` | docs.rs `transcribe-rs/latest` |
| Latest `ort` on crates.io | `2.0.0-rc.12` (ORT 1.24, MSRV 1.88) | crates.io/crates/ort |
| `transcribe-rs` `ort-directml` feature | turns on `ort`'s `directml` feature (requires base `onnx`) | docs.rs features page |

**Lucky alignment:** `transcribe-rs` 0.3.8 *exactly pins* `ort = =2.0.0-rc.12`, and that is also the
latest `ort`. So our direct `ort` dep MUST be the same exact pin. **Do NOT write `ort = "2"`** — Cargo
would be free to pick a newer rc (rc.13+) the day it ships and silently diverge from `transcribe-rs`'s
`=rc.12`, re-creating the two-copies bug. Pin exactly.

### What to add (and the per-OS target reconciliation)

```toml
# --- shared base (all platforms) ---
[dependencies]
ort = { version = "=2.0.0-rc.12", default-features = false, features = ["ndarray", "copy-dylib"] }
# NOTE: NO "directml"/"cuda" here — EP features are added per-target below so we don't
# force DirectML symbols into the CPU/macOS/Linux builds.
```

```toml
# --- Windows: DirectML EP, reconciled with transcribe-rs's Windows pin ---
[target.'cfg(windows)'.dependencies]
ort = { version = "=2.0.0-rc.12", default-features = false, features = ["ndarray", "copy-dylib", "directml"] }
# Bump Handy's Windows transcribe-rs pin from 0.3.3 → 0.3.8 (or 0.3.11) so it carries the
# SAME =2.0.0-rc.12 ort. (0.3.3 predates the rc.12 pin and would drag a different ort = the bug.)
# This is the ONE Handy-Cargo.toml edit the port REQUIRES; flagged in lib_wiring.md.
transcribe-rs = { version = "0.3.8", features = ["whisper-cpp", "onnx", "whisper-vulkan", "ort-directml"] }
```

> ⚠️ **RISK / OPEN ITEM 1:** the current Handy `Cargo.toml` pins `transcribe-rs = "0.3.3"` inside the
> three per-OS target blocks but `"0.3.8"` in the shared `[dependencies]`. Cargo unifies to one
> version per crate; with `^` semantics `0.3.3` and `0.3.8` unify to `0.3.8`, so today they probably
> already resolve to 0.3.8 → rc.12. **But verify with `cargo tree -i ort` on first build** that exactly
> ONE `ort 2.0.0-rc.12` node exists. If `cargo tree` shows two `ort`s, force them with a
> `[patch.crates-io] ort = ...` or a workspace `[dependencies] ort = "=2.0.0-rc.12"` shim.
>
> ⚠️ **RISK / OPEN ITEM 2 — `ort` ABI vs `sherpa-onnx`:** `sherpa-onnx` (see §3) statically links its
> OWN onnxruntime build (it does not use the `ort` crate). Two independent onnxruntime C runtimes in
> one process is usually tolerated because each keeps its own `OrtApi` table and global env, BUT they
> must not both try to register the same EP DLL by the same name. On Windows, `ort`'s `copy-dylib`
> drops `onnxruntime.dll` next to the exe; sherpa links its runtime statically (no loose DLL) → no
> filename clash. Keep it that way: do NOT enable a `load-dynamic`/shared-onnxruntime feature on
> sherpa-onnx. If a symbol clash appears at link time, fall back to running sherpa KWS/diarization in a
> **sidecar process** (mirrors how WinSTT already ships `winstt-context.exe`; see §11).
>
> ⚠️ **RISK / OPEN ITEM 3 — EP features are additive-global in `ort`.** `ort`'s `directml`/`cuda`
> features are unified across the whole dep graph. If `transcribe-rs`'s `ort-directml` already turns on
> `ort/directml`, our direct `ort` dep need not also request it — but requesting it is idempotent and
> documents intent. Never request `cuda` on Windows (CUDA is retired on Windows per project CLAUDE.md).

### `ort` features rationale

| Feature | Why |
|---|---|
| `ndarray` | the engine passes `ndarray::Array` mel tensors into `ort::Value::from_array` (§1). |
| `copy-dylib` | copies `onnxruntime.dll` next to the exe at build so the portable NSIS bundle is self-contained (matches Handy's shipping model). |
| `directml` (Windows only) | the DirectX-12 EP — the unmarked default GPU per CLAUDE.md. Vendor-agnostic. |
| (omit `download-binaries`) | we want the build-vendored DLL deterministic, not a build-time download; `transcribe-rs`/`copy-dylib` already provide the runtime. Confirm on first build which crate "wins" the DLL — only ONE may copy it. |

---

## 1. `ndarray` — tensor plumbing for the ort engine

```toml
[dependencies]
ndarray = "0.17.2"
```

- **Verified latest:** `0.17.2` (2026-01-10, docs.rs).
- **Why:** the unified ONNX STT engine (`03_stt_engine.md`) builds mel-spectrogram / feature tensors
  (Whisper `(B,128,T)`, Cohere time-first `(B,T,128)`, NeMo log-mel, SenseVoice FBANK+LFR+CMVN) as
  `ndarray::Array` and feeds them to `ort::Value::from_array`. Also used for argmax/greedy decode loops,
  KV-cache slicing, and the cross-attention DTW in word-timestamps (`05_*`).
- **Reconcile with `ort`:** `ort`'s `ndarray` feature must target the same `ndarray` major. `ort
  2.0.0-rc.12` is built against `ndarray 0.16/0.17`-compatible API; **verify `cargo tree -i ndarray`
  yields ONE node**. If `ort` pins `ndarray 0.16`, pin ours to `0.16.x` to match (don't fight it — a
  duplicate `ndarray` is harmless for compilation but means two `Array` types that won't interop at the
  `ort` boundary). OPEN ITEM: confirm rc.12's ndarray range on first build.

---

## 2. `tokenizers` — HF tokenizer for DistilBERT end-of-turn + (fallback) BPE

```toml
[dependencies]
tokenizers = { version = "0.22.1", default-features = false, features = ["onig", "http"] }
# If build-time network for vocab pulls is undesirable, drop "http" and load tokenizer.json from disk:
# tokenizers = { version = "0.22.1", default-features = false, features = ["onig"] }
```

- **Verified latest:** `0.22.1` (docs.rs).
- **Why (DistilBERT smart-endpoint):** `04_*` §5 — the end-of-turn classifier loads
  `KoljaB/SentenceFinishedClassification`. Its `tokenizer.json` is a standard HF WordPiece file; the
  cleanest Rust path is `tokenizers::Tokenizer::from_file("tokenizer.json")` →
  `encode(text, true)` → feed `input_ids`/`attention_mask` to a DistilBERT ONNX session via `ort`
  (truncation `max_length=128`). This replaces the Python `DistilBertTokenizerFast`.
- **Why NOT strictly needed for Cohere/Moonshine:** ⚠️ correction to the slice brief — the onnx-asr
  fork **deliberately hand-rolls** the Cohere and Moonshine tokenizers in pure Python with **no
  `tokenizers`/`sentencepiece` dependency** (`onnx-asr/src/onnx_asr/models/cohere_asr.py` docstring:
  *"SentencePiece-BPE with byte_fallback decoded in pure Python (no tokenizers/sentencepiece
  dependency)"*; Moonshine likewise). So Cohere's `▁`→space + `<0xXX>` byte-fuse and Moonshine's
  vocab map should be **ported as pure-Rust data tables** (deterministic, unit-testable — exactly the
  kind of port HARD RULE 2 wants done for real), NOT delegated to `tokenizers`. **Keep `tokenizers`
  scoped to the DistilBERT classifier** (and any *custom* user model that ships a real `tokenizer.json`,
  which onnx-asr loads via its resolver). Listing `tokenizers` here is justified by DistilBERT + custom
  models alone; do not expand its blast radius.
- **Features:** `default-features = false` drops the heavy `esaxx_fast`/training paths we never use;
  `onig` gives the regex pre-tokenizer DistilBERT/WordPiece needs. `http` only if you let it fetch
  vocab from HF — prefer disk-loading the bundled `tokenizer.json` and dropping `http` to keep the
  build offline-deterministic.

---

## 3. `sherpa-onnx` — wake-word KWS + speaker diarization

```toml
[target.'cfg(windows)'.dependencies]
sherpa-onnx = { version = "1.13.2", default-features = false, features = ["download-binaries"] }
```

- **Verified latest:** `1.13.2` (2026-05-14, crates.io — the OFFICIAL k2-fsa binding). The crate name
  is exactly **`sherpa-onnx`** (NOT `sherpa-rs`).
- **`sherpa-rs` IS DEPRECATED / superseded.** `sherpa-rs` (thewh1teagle) is the older 3rd-party binding
  (last at `0.6.8`); the upstream k2-fsa project now publishes the first-party `sherpa-onnx` crate with
  the same C-API surface and active 1.13.x releases. Use `sherpa-onnx`. Do not add `sherpa-rs`.
- **Why:** two WinSTT subsystems map onto it 1:1:
  - **Wake word (KWS):** locked decision = "sherpa-onnx KWS (open-vocabulary, offline)". Replaces
    Porcupine + openWakeWord + CompositeWakeWord (`04_*` §3). sherpa-onnx ships
    `KeywordSpotter`/`OnlineKeywordSpotter` (see its `rust-api-examples/keyword_spotter.rs`).
  - **Diarization:** replaces `OnnxAsrDiarizer` (pyannote-segmentation-3.0 + wespeaker-resnet34-LM,
    online clustering). sherpa-onnx ships `OfflineSpeakerDiarization` (segmentation + embedding +
    clustering) — exactly the same model family WinSTT uses (`04_*` §4). Its
    `offline_speaker_diarization.rs` example is the template.
- **`download-binaries`:** sherpa-onnx links a prebuilt native lib. The `download-binaries` feature
  pulls the matching `sherpa-onnx-vX.Y.Z` prebuilt for the target at build time (the crate references
  `sherpa-onnx-v1.12.40` Windows-x64 prebuilts). ALTERNATIVE: `static` (vendored static link, bigger
  build, no network) — prefer `static` for reproducible CI once a local copy is cached. OPEN ITEM:
  confirm the exact feature names on `crate/sherpa-onnx/latest/features` on first build (the binding
  exposes `tts`, `cuda`, `directml` toggles we should leave OFF for KWS/diar — CPU is fine and dodges
  the two-onnxruntime EP-clash risk in §0 OPEN ITEM 2).
- ⚠️ **RISK:** see §0 OPEN ITEM 2 (two onnxruntime runtimes). Keep sherpa on CPU + statically linked;
  if any link/symbol clash with `ort` appears, demote sherpa to a **sidecar exe** (it has a clean
  C-API and stdio mode). Wake-word/diar are not latency-critical enough to forbid a sidecar.

---

## 4. Kokoro TTS in-process — `kokoroxide` (⚠️ espeak-ng GPL-v3)

```toml
[dependencies]
kokoroxide = "0.1.5"
```

- **Verified:** `kokoroxide = 0.1.5` on crates.io, license **`MIT OR Apache-2.0`**, desc *"A Rust
  implementation of Kokoro TTS synthesis"*. It uses **espeak-ng** for grapheme→phoneme (→ Misaki
  notation) and **ONNX Runtime** for the Kokoro-82M model.
- **Candidates compared (per slice brief — kokoros / kokorox / kokoroxide):**
  | Crate | On crates.io? | License | Phonemizer | Verdict |
  |---|---|---|---|---|
  | **`kokoroxide`** | ✅ `0.1.5` | MIT/Apache-2.0 (crate) | espeak-ng | **CHOSEN** — published, cargo-linkable, matches "in-process Kokoro" decision. |
  | `kokorox` (byteowlz) | ❌ not published (build-from-source / prebuilt bins only) | **GPL-3.0** | espeak-ng via `espeak-rs-sys` (static) | not a cargo dep; GPL stated explicitly. Reference impl only. |
  | `kokoros` | ❌ not a current crates.io dep we could confirm | — | espeak-ng | skip — unconfirmed on crates.io. |
  | `kokoro-tts` / `kokoro-tiny` | ✅ exist | varies | varies | fallbacks if kokoroxide stalls; re-verify. |
- ⚠️ **LICENSING — THE BLUEPRINT'S ACCEPTED COST.** The README/PORT decision says *"espeak-ng GPL-v3
  accepted → the whole binary inherits GPL-v3."* This holds **regardless of `kokoroxide`'s own
  MIT/Apache crate license**: at runtime/link time it pulls in **espeak-ng (GPL-v3)**. Whether espeak
  is statically linked (definitely GPL-viral) or `kokoroxide` shells out to a separate espeak-ng
  process/loads a DLL (weaker/arguable) **MUST be confirmed before shipping** — it decides whether the
  WinSTT binary is GPL-v3 or can stay permissive.
  - **OPEN ITEM 4:** inspect `kokoroxide`'s build — does it (a) `espeak-rs-sys` static-link (→ GPL-v3
    viral, like kokorox), (b) bundle an espeak-ng DLL it loads at runtime, or (c) require a system
    espeak-ng? This determines redistribution terms. The Python WinSTT sidesteps this by shipping TTS
    as an **on-demand `sys.path`-injected support pack** (`05_tts.md` §7) — the exe ships ZERO TTS
    code, espeak only lands if the user opts in. **`06_tts.md` MUST decide:** in-process cargo-link
    (GPL-v3 binary, simplest) **vs** a **downloaded Kokoro sidecar** (keeps the main binary permissive
    — the escape hatch the README explicitly names). If permissive licensing matters, the sidecar wins
    and `kokoroxide` does NOT go in `[dependencies]` — it goes in a separately-built `winstt-tts.exe`.
- **`ort` reconciliation:** if `kokoroxide` uses the `ort` crate internally, it MUST also resolve to
  `=2.0.0-rc.12` (§0). If it vendors its own onnxruntime (like sherpa), see §0 OPEN ITEM 2. **OPEN
  ITEM 5:** confirm kokoroxide's onnxruntime path (`cargo tree -i ort` / `-i onnxruntime-sys`).

---

## 5. LLM — all-in-Rust (Ollama + OpenAI-compatible cloud)

The blueprint says LLM = all in Rust, extending Handy's `llm_client.rs` (which is already an
OpenAI-compatible `reqwest` client doing chat-completions + structured-output + model listing).

```toml
[dependencies]
ollama-rs = { version = "0.3.4", features = ["stream"] }
```

- **Verified latest:** `ollama-rs = 0.3.4` (2026-02-12).
- **Why `ollama-rs` (and NOT reqwest-only) for Ollama:** WinSTT has a dedicated Ollama IPC surface
  (`electron/ipc/ollama.ts`): local model listing, pull-with-progress, `/api/generate` + `/api/chat`,
  health probe. `ollama-rs` gives typed `generate`/`chat`/`list_local_models`/`pull_model` (streaming)
  against Ollama's **native** API (`/api/*`), which is NOT byte-identical to OpenAI's `/v1/*` — model
  pull-progress especially is Ollama-proprietary. Hand-rolling it on `reqwest` is exactly the kind of
  re-implementation `ollama-rs` already did. `stream` feature for token + pull-progress streaming.
- **For OpenAI / OpenRouter / cloud chat post-processing: REUSE Handy's `reqwest`-based
  `llm_client.rs` — do NOT add `async-openai`.** Justification:
  - Handy's `llm_client.rs` already speaks OpenAI-compatible chat-completions + JSON-schema structured
    output + per-provider auth (anthropic `x-api-key`) + model listing over `reqwest 0.12` (already a
    dep). WinSTT's compose/modifier/translate/context-clean LLM features (`07_*`) are all
    "single prompt → text/JSON" — they need nothing `async-openai` adds.
  - Adding `async-openai 0.40.2` (verified latest) would duplicate that surface, pull a large typed
    model of the *entire* OpenAI API (responses/assistants/files/etc. we never call), and risk a
    `reqwest`/`tokio` feature-unification headache for ~zero benefit.
  - **DECISION: reqwest-only for cloud LLM (extend `llm_client.rs`); `ollama-rs` only for the native
    Ollama API.** `async-openai` is listed here solely to record that it was evaluated and rejected:
    ```toml
    # async-openai = "0.40.2"   # EVALUATED, NOT ADDED — Handy's reqwest llm_client.rs already covers
    #                            # OpenAI-compatible chat+schema+models; async-openai is redundant bloat.
    ```
- **Cloud STT note:** OpenAI/ElevenLabs *transcription* (the `RemoteTranscriber` path, `03_*` §4) is
  also just multipart-`reqwest` (POST WAV → text). Reuse `reqwest`; no extra crate. ElevenLabs has no
  first-class Rust SDK worth adding.

---

## 6. `wasapi` — WASAPI loopback (Listen mode / system-audio capture)

```toml
[target.'cfg(windows)'.dependencies]
wasapi = "0.23.0"
```

- **Verified latest:** `wasapi = 0.23.0` (crates.io).
- **Why:** Listen-mode loopback (`04_*` §1d) needs to capture **render-endpoint** (speaker) audio.
  Handy's `cpal` covers mic capture only; cpal does not expose WASAPI **loopback** on the stable path
  (the loopback PR #894 is unmerged). WinSTT's Python uses `pyaudiowpatch` for exactly this. `wasapi`
  gives `AudioClient` in **loopback capture** mode on a render device — the direct Rust analog. Feeds
  the same 16 kHz mono pipeline (with the slow-tracking AGC ported as pure-Rust arithmetic) into the
  recorder, matching `loopback.py`.
- **Alternative considered:** raw `windows` crate `Win32_Media_Audio` COM (already partially enabled).
  Possible, but `wasapi` is a thin safe wrapper that saves ~300 lines of `IAudioClient`/`IMMDevice` COM
  boilerplate and event-driven buffer plumbing. Keep `wasapi` for loopback; keep raw `windows` for the
  per-app mute (`ISimpleAudioVolume`, §10) since that needs session enumeration `wasapi` doesn't wrap.

---

## 7. Context-awareness (UIA caret reader) — **ship the C sidecar, do NOT add `uiautomation`**

```toml
# NO crate added. Ship the existing native helper as a Tauri sidecar binary:
#   frontend/electron/native/bin/winstt-context.exe  →  app/src-tauri/binaries/winstt-context-<triple>.exe
# (registered under tauri.conf.json `bundle.externalBin`; spawned via std::process::Command / tauri-plugin-shell)
#
# If a pure-Rust in-process reader is preferred LATER:
# [target.'cfg(windows)'.dependencies]
# uiautomation = "0.24.1"
```

- **Verified (if used):** `uiautomation = 0.24.1` (leexgone/uiautomation-rs, docs.rs).
- **RECOMMENDATION: ship `winstt-context.exe` as a sidecar, not a crate.** Reasons (the existing C
  helper's own header documents these, and the WinSTT memory `project_context_capture_extraction_strategy`
  backs it):
  - The helper is **1121 lines of battle-tested C** doing `TextPattern`/`ValuePattern`/`--split`
    caret-aware read + `--tree` axHTML walk + deny-list + password-field skipping. Re-deriving that in
    `uiautomation` is high-effort, high-risk, low-reward — and the WinSTT field survey already records
    that the a11y-tree approach is fiddly ("AX inconsistent").
  - **Process isolation is a feature, not overhead:** the C helper's whole point is that a hung
    accessibility-tree COM call **cannot wedge the parent** — it's a short-lived process with a hard
    watchdog (exit code 3 on timeout). UIA from in-process FFI needs a free-threaded apartment + heavy
    marshalling that risks deadlocking the Tauri main thread. Tauri's sidecar model
    (`externalBin` + `tauri-plugin-shell`) is purpose-built for this and mirrors how WinSTT already
    shells out to it.
  - It fires only ~twice per dictation — sidecar spawn cost is irrelevant.
- **So:** the port adds **zero context crates**; it adds a **build step** that compiles the two C
  helpers (`winstt-context.exe`, `winstt-paste.exe`) and stages them as `externalBin`. `uiautomation
  0.24.1` is recorded only as the in-process fallback if the sidecar ever proves unworkable.
- **Paste:** Handy already has `enigo` (in deps) + `clipboard.rs` clipboard-sandwich Ctrl+V, which
  matches WinSTT's flipped paste priority. So `winstt-paste.exe` is likely **redundant** — prefer
  Handy's `enigo` path and only fall back to the C sidecar if KEYEVENTF_UNICODE edge cases surface.

---

## 8. `zip` — diagnostic bundle export

```toml
[dependencies]
zip = { version = "8.6.0", default-features = false, features = ["deflate"] }
```

- **Verified latest stable:** `zip = 8.6.0` (newest is `9.0.0-pre2`, a pre-release — do NOT use the
  pre-release; pin stable `8.6.0`).
- **Why:** WinSTT's "export diagnostic bundle" (electron `diag` IPC) zips logs + settings + system
  info for support. Handy has `tar` + `flate2` (for `.tar.gz` *model* extraction) but a user-facing
  diag bundle should be a `.zip` (Windows Explorer opens it natively). `default-features = false` +
  `deflate` keeps it lean (no bzip2/zstd/aes we don't need).
- **Note:** Handy's existing `flate2`/`tar` stay for model archives; `zip` is purely the diag-bundle
  writer. No conflict.

---

## 9. `keyring` — encrypted API-key storage (DPAPI-backed on Windows)

```toml
[dependencies]
keyring = { version = "4.0.1", features = ["windows-native"] }
```

- **Verified latest:** `keyring = 4.0.1` (crates.io).
- **Why:** WinSTT stores cloud-provider API keys (OpenAI / ElevenLabs / OpenRouter / Ollama-remote).
  These must NOT sit in plaintext in `settings_store.json`. `keyring 4.x` on Windows uses the
  **Windows Credential Manager**, which is **DPAPI-encrypted per-user** — exactly the "encrypted API
  keys" requirement. The `windows-native` feature selects the WinCred backend (avoids dragging the
  Linux `secret-service`/`dbus` stack into the Windows build).
- **Alternative (lower-level):** call DPAPI directly via the `windows` crate
  (`Win32_Security_Cryptography::CryptProtectData`). `keyring` is the better abstraction (handles the
  credential blob, naming, and cross-platform story if Linux/mac ship later) and is the de-facto
  standard. Prefer `keyring`; only drop to raw DPAPI if `keyring` proves flaky.
- **Handy parity:** Handy redacts keys in `Debug` (`SecretMap` in `settings.rs`) but stores them in
  the plaintext store. WinSTT's port **upgrades** this: keys live in `keyring`, `settings_store.json`
  holds only a *reference*/presence flag. (Migration: on first run, move any plaintext keys → keyring.)

---

## 10. `symphonia` — file decode for drag-and-drop file transcription

```toml
[dependencies]
symphonia = { version = "0.6.0", default-features = false, features = [
  "wav", "mp3", "isomp4", "aac", "flac", "ogg", "vorbis",
] }
```

- **Verified latest:** `symphonia = 0.6.0` (crates.io).
- **Why:** file-transcribe (`07_*` / WinSTT's multi-file queue) accepts arbitrary audio/video the user
  drops (`.mp3 .m4a .mp4 .flac .ogg .wav .aac ...`). Handy only has `hound` (WAV-only). `symphonia` is
  the pure-Rust, **no-system-ffmpeg**, multi-codec decoder — decode → f32 → resample to 16 kHz via the
  existing `rubato` → feed the pipeline. Pure-Rust keeps the portable installer self-contained (no
  ffmpeg.exe to bundle/license).
- **vs system ffmpeg:** rejected — bundling ffmpeg.exe bloats the installer, complicates licensing, and
  `symphonia` covers every container WinSTT's drop-zone accepts. Enable only the codecs we actually
  ingest (`default-features = false` + explicit list) to keep compile time/binary size down. Add `mkv`
  if `.webm`/`.mkv` audio extraction is in scope (it's gated behind the `isomp4`/`mkv` features).
  ⚠️ **MP3 patents** expired (2017) so the `mp3` feature is fine to ship.

---

## 11. `base85` + `flate2` — Whisper word-timestamp alignment-heads table

```toml
[dependencies]
base85 = "2.0.0"
# flate2 is ALREADY in Cargo.toml (L72) — reused, NOT re-added.
```

- **Verified latest:** `base85 = 2.0.0` (crates.io, *"Base85 encoding as described in RFC1924"*).
- **Why:** word-level timestamps (the karaoke-highlight feature, `05_*`) use openai-whisper's
  cross-attention DTW. The per-model **alignment-heads** masks are stored exactly as in
  openai-whisper: a `base85`-encoded `gzip` of a flat bool array
  (`onnx-asr/src/onnx_asr/word_timestamps.py`: `raw = gzip.decompress(base64.b85decode(dump))`). The
  Rust port embeds the same table as a `const` and decodes it: `flate2::read::GzDecoder` over the
  `base85`-decoded bytes → `(num_layers, num_heads)` bool mask.
- ⚠️ **VARIANT GOTCHA:** Python's `base64.b85decode` is **RFC1924 base85** (the `0-9A-Za-z!#$%&()*+-;<=>?@^_\`{|}~`
  alphabet) — NOT Ascii85/`btoa`. The `base85 = 2.0.0` crate's headline is literally "RFC1924", so it
  matches. **Verify with one round-trip unit test** against a known `_ALIGNMENT_HEADS` entry before
  trusting it (a wrong base85 variant silently yields garbage masks → wrong word times). This is a
  prime candidate for a deterministic `#[cfg(test)]` port per HARD RULE 2.
- `flate2` (already present for `.tar.gz` models) provides the gzip half — no new crate.

---

## 12. `windows` crate — FEATURE additions (extend, do NOT replace Handy's list)

Handy's current `[target.'cfg(windows)'.dependencies] windows = { version = "0.61.3", features = [...] }`
has: `Win32_Media_Audio_Endpoints`, `Win32_System_Com_StructuredStorage`, `Win32_System_Variant`,
`Win32_Foundation`, `Win32_UI_WindowsAndMessaging`. The port **adds** (same `0.61.3` version — do NOT
bump, keep it unified with Handy):

```toml
[target.'cfg(windows)'.dependencies]
windows = { version = "0.61.3", features = [
  # --- Handy's existing (keep) ---
  "Win32_Media_Audio_Endpoints",
  "Win32_System_Com_StructuredStorage",
  "Win32_System_Variant",
  "Win32_Foundation",
  "Win32_UI_WindowsAndMessaging",
  # --- WinSTT port ADDITIONS ---
  "Win32_Media_Audio",            # IMMDeviceEnumerator / IAudioSessionManager2 / ISimpleAudioVolume (per-app mute, §10)
  "Win32_System_Com",             # CoInitializeEx/CoCreateInstance for the audio-session + UIA COM paths
  "Win32_System_ProcessStatus",   # K32GetModuleFileNameEx / process-name resolution (focused-app → dictation mode, deny-list)
  "Win32_System_Threading",       # OpenProcess (needed alongside ProcessStatus to resolve the foreground PID's exe)
  "Win32_UI_Accessibility",       # IUIAutomation* — ONLY if the in-process UIA fallback (§7) is ever taken; omit while using the C sidecar
  "Win32_Security_Cryptography",  # CryptProtectData/CryptUnprotectData — ONLY if raw DPAPI is used instead of `keyring` (§9); omit while using keyring
] }
```

- **`Win32_Media_Audio`** (NOT just `_Endpoints`): the per-application **mute/volume** feature (WinSTT
  ducks/mutes a target app while dictating) needs `IAudioSessionManager2::GetSessionEnumerator` →
  `ISimpleAudioVolume`, which live in `Win32_Media_Audio`. Handy's `set_mute` uses the simpler
  `IAudioEndpointVolume` (endpoint-wide) — WinSTT's per-session control needs the broader namespace.
- **`Win32_System_Com`**: explicit COM init for the audio-session enumeration (and the UIA fallback).
  `Win32_System_Com_StructuredStorage` (already present) does not pull the base `Com` apartment APIs.
- **`Win32_System_ProcessStatus` + `Win32_System_Threading`**: resolve the foreground window's process
  → exe name, for "focused app ⇒ dictation mode" and context deny-list (the C sidecar already does this
  for context, but the *mode-routing* logic lives in Rust and needs the PID→exe lookup).
- **`Win32_UI_Accessibility`** and **`Win32_Security_Cryptography`** are listed as **conditional** —
  include them ONLY if the corresponding "raw" path is chosen over the recommended abstraction (C
  sidecar for UIA §7; `keyring` for secrets §9). With the recommended choices, **omit both** to keep
  the build lean.
- ⚠️ **Do NOT change the `windows` version** (`0.61.3`). The `windows`/`windows-sys`/`windows-core`
  graph is notoriously version-fragmented; bumping it risks duplicate `windows-core` and is unrelated
  to the port. Add features at the pinned version only.

---

## 13. Summary table — everything the port ADDS

| Crate | Version (verified 2026-05) | Target | Features | Purpose |
|---|---|---|---|---|
| `ort` | `=2.0.0-rc.12` | all (+ `directml` on win) | `ndarray`, `copy-dylib`, (`directml` win) | unified ONNX STT engine for all ~40 models. **Must match `transcribe-rs`'s exact pin.** |
| `transcribe-rs` (win) | bump `0.3.3`→`0.3.8` | win | `+ ort-directml` | reconcile its `ort` to `=rc.12`. (Edit to Handy block — the one required.) |
| `ndarray` | `0.17.2` | all | (default) | tensor plumbing for `ort`. Match `ort`'s ndarray major. |
| `tokenizers` | `0.22.1` | all | `onig` (no `default`, opt `http`) | DistilBERT smart-endpoint + custom-model `tokenizer.json`. NOT Cohere/Moonshine (hand-rolled). |
| `sherpa-onnx` | `1.13.2` | win | `download-binaries` (or `static`) | wake-word KWS + speaker diarization. (sherpa-rs is DEPRECATED.) |
| `kokoroxide` | `0.1.5` | all (or sidecar) | (default) | in-process Kokoro TTS. ⚠️ espeak-ng GPL-v3 → binary GPL unless sidecar'd (§4 OPEN ITEM 4). |
| `ollama-rs` | `0.3.4` | all | `stream` | native Ollama `/api/*` (list/pull-progress/chat/generate). |
| `wasapi` | `0.23.0` | win | (default) | WASAPI loopback capture (Listen mode). |
| `zip` | `8.6.0` | all | `deflate` (no default) | diagnostic-bundle export. |
| `keyring` | `4.0.1` | all | `windows-native` | DPAPI-backed encrypted API-key storage. |
| `symphonia` | `0.6.0` | all | `wav mp3 isomp4 aac flac ogg vorbis` (no default) | multi-codec file decode for file-transcribe. |
| `base85` | `2.0.0` | all | (default) | decode Whisper alignment-heads table (with existing `flate2`). |
| `windows` (features) | `0.61.3` (unchanged) | win | +`Win32_Media_Audio`, `Win32_System_Com`, `_ProcessStatus`, `_Threading` (+ conditional `_UI_Accessibility`, `_Security_Cryptography`) | per-app mute, COM, focused-app→mode, (UIA/DPAPI fallbacks). |
| `async-openai` | `0.40.2` | — | — | **EVALUATED, NOT ADDED** — Handy's reqwest `llm_client.rs` already covers it. |
| `uiautomation` | `0.24.1` | — | — | **NOT ADDED** — ship the C `winstt-context.exe` sidecar instead (§7). |

**Reused-from-Handy (no add):** `reqwest` (cloud STT + cloud LLM), `flate2`+`tar`+`sha2` (model
archives + checksums), `rubato` (resample), `cpal` (mic), `enigo` (paste), `rusqlite` (history),
`rodio` (feedback sounds), `vad-rs` (Silero VAD — keep CPU-only per invariant), `hound` (WAV I/O).

---

## 14. Cross-cutting risk register (the version-conflict landmines)

1. **`ort` duplication (CRITICAL).** Our direct `ort = "=2.0.0-rc.12"` MUST unify with
   `transcribe-rs`'s `=2.0.0-rc.12`. Verify `cargo tree -i ort` shows ONE node. The Windows
   `transcribe-rs` pin (`0.3.3`) predates rc.12 → bump to `0.3.8`. (§0)
2. **`ndarray` duplication.** `ort`'s `ndarray` feature vs our direct `ndarray 0.17.2` must be the same
   major. Verify `cargo tree -i ndarray`. (§1)
3. **Two onnxruntime C runtimes.** `ort` (our engine) + `sherpa-onnx` (KWS/diar) + possibly
   `kokoroxide` (TTS) each may carry an onnxruntime. Keep sherpa/kokoroxide on **CPU + static link**;
   only `ort` ships the loose `onnxruntime.dll`. Sidecar sherpa if it clashes. (§0 OPEN ITEM 2, §3, §4)
4. **espeak-ng GPL-v3.** `kokoroxide`'s espeak dependency makes the **binary** GPL-v3 if linked
   in-process. The README's escape hatch (downloaded TTS sidecar) keeps the main binary permissive.
   `06_tts.md` must decide. (§4 OPEN ITEM 4)
5. **`zip` pre-release trap.** Pin stable `8.6.0`; do NOT let `cargo add zip` grab `9.0.0-preN`. (§8)
6. **`base85` variant.** Must be RFC1924 (matches Python `b85decode`); one round-trip test guards it. (§11)
7. **`windows` version drift.** Keep `0.61.3` everywhere; add features only, never bump. (§12)
8. **`tauri-specta`/`specta` rc pins** (`=2.0.0-rc.21`/`=rc.22`) are exact in Handy — none of the new
   crates touch specta, so no conflict, but every new manager's command/event types must derive
   `specta::Type` (see `lib_wiring.md`). Not a *dependency* risk, a *wiring* requirement.

---

## 15. Acceptance / verification (post-toolchain, do these on first build)

```
cargo tree -i ort           # MUST show exactly one  ort v2.0.0-rc.12
cargo tree -i ndarray       # MUST show exactly one  ndarray (matching ort's major)
cargo tree -i onnxruntime-sys  # audit how many native onnxruntimes link (ort vs sherpa vs kokoroxide)
cargo tree -d               # list ALL duplicate crates; investigate any in {ort, ndarray, windows-core, tokio, reqwest}
cargo build --target x86_64-pc-windows-msvc 2>&1 | tee build.log   # watch for duplicate-symbol / Ort API-mismatch
```

If `cargo tree -i ort` shows two nodes → add a `[patch.crates-io]`/workspace `ort = "=2.0.0-rc.12"`
unification shim, or bump the lagging `transcribe-rs` pin, before doing anything else.
