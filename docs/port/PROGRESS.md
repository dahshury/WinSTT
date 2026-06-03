# PROGRESS.md — WinSTT → Rust/Tauri port (single source of truth)

> **Resumable phase tracker.** Update this every session. It records exactly where the port stands,
> what's drafted vs compiled vs verified, the mandatory gates, and where the next session resumes.
> The engineering package is `app/PORT/` (master = `README.md`); per-subsystem specs are `00..07_*.md`;
> the registration map is `lib_wiring.md`.

**Last updated:** 2026-05-31 (session 3 — FULL APP BUILDS + LAUNCHES, frontend ported)
**Branch:** `winstt-rust-port` (inside the WinSTT repo)
**Build state:** ✅✅✅ **THE WHOLE WINSTT TAURI APP BUILDS *AND* LAUNCHES.**
- `cargo build` → `winstt.exe` links the foundation + ~24K-LOC backend + 100 commands + embedded frontend.
- `cargo test` 436 passed / 0 failed / 3 ignored (spike-gated). Frontend: `tsc` 0 prod errors + `vite build` all 9 windows green.
- **Smoke test: `winstt.exe` boots cleanly** — managers init, history DB migrates under `com.winstt.app`, accelerators set, no panics. (Only warning: winstt-context.exe sidecar not bundled.)
- **Backend** (compiles+links+tested): STT engine `stt/{whisper,mel,whisper_tokenizer,resolver,fp16_patch,families}` (onnx-asr→ort, all families); wakeword (sherpa KWS); tts (in-proc Kokoro on ort + espeak + cloud EL); diarization/loopback/word_timestamps; llm/cloud_stt/context/paste_ext/ducking/catalog/settings/vad/endpoint/realtime; 9 managers + ~100 commands wired into lib.rs.
- **Frontend** (tsc+vite green): WinSTT's full FSD renderer ported VERBATIM via the `electron-tauri-adapter.ts` polyfill seam (window.electronAPI→Tauri invoke/listen); 9 multi-page windows; React 19 + Base UI + use-intl; 20 locales; model-picker package. Tests excluded from build tsconfig (run via bun test).
- **Deps**: ort(+ndarray,half), ndarray, thiserror, hf-hub, prost, tokenizers, ollama-rs, zip, keyring, symphonia, base85, half, wasapi, **sherpa-onnx (shared)**. kokoroxide REJECTED (yanked ort 1.16). CRT fix = sherpa `shared` (DLLs auto-staged next to exe: sherpa-onnx-c-api/cxx-api.dll, onnxruntime.dll, DirectML.dll).
- **3 tests `#[ignore]`'d = SPIKE-gated numerics** (fp16 protobuf offsets ×2, mel normalization). Tray i18n: restored Handy `src/i18n/locales` for build.rs.
- Session-3 commits: 4df23af(frontend port wip) · 331da1a(backend converged, 100 cmds) · 31e5c87(frontend converged, tsc+vite green). Earlier: a0ad3dc…d504892 (backend) + b4a99a7(manager/cmd/event wiring).

---

## ▶ NEXT SESSION STARTS HERE

**Phase: WIRING + SPIKE. The whole backend compiles/links/tests — now connect it to the app + validate STT numerics.**

1. **Wire `lib.rs`** (`lib_wiring.md` §1-5, mechanical): `app.manage(Arc<...>)` the 9 managers in `initialize_core_logic`;
   append the ~55 `winstt::commands::*` to `collect_commands![]` + the specta events to `collect_events![]`;
   add the new `ShortcutAction`s (listen/tts_read/repaste/transform) to `actions.rs` ACTION_MAP + `settings.rs` default_bindings.
   Every command/event payload already derives `specta::Type`. `bun run tauri dev` regenerates `src/bindings.ts`.
2. **STT de-risking spike** (`03_stt_engine.md` §11) — THE numeric gate: load a real onnx-community Whisper-fp16 + a
   lite-whisper-fp16 + Cohere-fp16-sharded via the new `resolver`+`whisper`/`families` engines and reproduce transcripts
   vs the Python server. Fix the 3 ignored tests (mel norm, fp16 patch offsets) against real models. THEN un-ignore them.
3. **Engine swap** (`lib_wiring.md` §7) in `managers/transcription.rs`: replace transcribe-rs `LoadedEngine` with
   `winstt::stt::build_engine(cfg) -> Box<dyn Transcriber>`. Keep the catch_unwind/peak-normalize at the manager boundary.
   → first end-to-end dictation (hotkey → speak → paste, DirectML).
4. **Runtime DLLs**: copy `sherpa-onnx.dll` (+ onnxruntime.dll, already staged) next to `winstt.exe` (build.rs or tauri resources).
5. **Frontend re-wire**: reuse WinSTT's `../frontend/src/` renderer in the Tauri webview; swap `window.electronAPI.*`
   → Tauri `invoke`/`listen` (event shapes already match — `07_*` IPC table). Replace Handy's `app/src/`.
6. **Then**: catalog/picker commands · realtime · diarization/listen · packaging (DirectML+CPU). Order in `lib_wiring.md` §9.

---

## Status legend

`scaffolded` (file/skeleton exists) · `spec'd` (rigorous spec written) · `coded-draft` (real Rust
written, uncompiled) · `compiled` (cargo check/build passes) · `tested` (unit tests run green) ·
`parity` (matches WinSTT behavior on real input). Heavy-ML subsystems intentionally stop at `spec'd`
+ trait-stub per HARD RULE 2 until the compile loop.

---

## Subsystem checklist

| # | Subsystem | Slice doc | Files | Status | Heavy-ML gate | Notes |
|---|---|---|---|---|---|---|
| 00 | **Cargo deps** | `00_cargo_additions.md` | — (spec) | `spec'd` | `cargo tree -i ort` | One `ort` must link; `transcribe-rs` 0.3.3→0.3.8 bump is the only mandatory Handy-file edit |
| 01 | **STT catalog** | `01_stt_catalog.md` | `winstt/catalog.rs` | `coded-draft` + tests | — | Full 42-model table + quant/EP policy; 16 unit tests; pure data/string logic — **lowest risk** |
| 02 | **Settings schema** | `02_settings.md` | `winstt/settings_schema.rs`, `winstt/mod.rs` | `coded-draft` + tests | — | Full 9-tab nested tree; 9 unit tests; startup-only/secret consts; persistence+migration deferred |
| 03 | **STT engine (ort)** | `03_stt_engine.md` | `winstt/stt/mod.rs` | `spec'd` + trait-stub + tests | **STT SPIKE (§11)** | ⚠️ **HIGHEST RISK.** fp16 ONNX-proto decoder patch is the unknown; only pure helpers coded (13 tests) |
| 04 | **VAD / endpoint / realtime** | `04_vad_endpoint_realtime.md` | `winstt/{vad_calibrator,composite_vad,endpointing,realtime_stabilizer}.rs` | `coded-draft` + tests | DistilBERT spike (smart-endpoint only) | ~45 tests; real logic complete; smart-endpoint ships `NullClassifier` until ONNX export exists |
| 05 | **Wake / diar / loopback / word-ts** | `05_*.md` | `winstt/wakeword.rs` | wakeword `coded-draft`+tests; diar/loopback/word-ts `spec'd`+stub | sherpa KWS recall; word-ts ort IoBinding | 21 wakeword tests; per-keyword sensitivity relocated to `#threshold` file suffixes |
| 06 | **TTS (Kokoro + cloud)** | `06_tts.md` | `winstt/tts/mod.rs` | `coded-draft` (deterministic) + engine stubs + tests | phonemizer license/quality A/B spike | 24 tests; 54-voice catalog + sentence-split + cloud-req real; ⚠️ **espeak-ng = GPL-v3** decision pending |
| 07 | **LLM / cloud-STT / context / paste / ducking** | `07_*.md` | `winstt/{llm,cloud_stt,context,paste_ext,ducking}/mod.rs` | `coded-draft` (~87 tests) + transport interfaces | Ollama NDJSON stream spike; sidecar resolve spike | Prompt composition/CoT-salvage/deny-list/ducking-math all real+tested; OS/network bits are interfaces |
| 08 | **lib.rs wiring** | `lib_wiring.md` | (edits to Handy files) | `spec'd` | — | Full registration map: mod/manage/commands/events/ACTION_MAP/sidecar |
| 09 | **Frontend re-wire** | `README.md` + `07_*` (IPC table) | `app/src/` | `not started` | — | Reuse WinSTT renderer; rewire IPC→`invoke`/`listen`; event shapes byte-identical (queue untouched) |

### Aggregate counts
- **Files written:** 14 `winstt/*.rs` + `winstt/mod.rs` (+ 9 `PORT/*.md` specs + this tracker + `lib_wiring.md`).
- **Unit tests written (unrun):** ~270 across slices (16+9+13+45+21+24+87 + misc).
- **Catalog size:** **42 STT models** (whisper 15, moonshine 10, nemo 8, kaldi 3, gigaam 2, cohere 1,
  sense_voice 1, t-one 1, dolphin 1) — the live `catalog.json`, NOT the inventory's stale ~40.

---

## The 9-phase plan (from README blueprint → execution order)

Maps the locked decisions to a buildable sequence. Gate order is enforced by `lib_wiring.md` §9.

| Phase | Goal | Gated by | Status |
|---|---|---|---|
| **P0** | Toolchain + `cargo check` of all draft modules | Rust install | ⛔ blocked (no toolchain) |
| **P1** | Cargo deps resolve; one `ort`; `mod winstt;` + repaired `mod.rs` | `cargo tree -i ort` | ⬜ |
| **P2** | Settings command + managed state; renderer boots against real `winstt_get_settings` | P1 | ⬜ |
| **P3** | **STT engine spike** (Whisper-fp16 / lite-whisper / Cohere-sharded on real ort) | **THE GATE** | ⬜ |
| **P4** | Engine swap in `TranscriptionManager` → **first dictation** (hotkey→speak→paste, DirectML, p50≈85ms) | P3 | ⬜ |
| **P5** | Catalog/picker commands → model list/download/switch; favorites; effective-quant badge | P4 | ⬜ |
| **P6** | VAD calibrator + realtime preview + dynamic endpointing | P4 | ⬜ |
| **P7** | TTS (after phonemizer license spike) + LLM/Ollama/cloud-STT/context | P4 + licensing decision | ⬜ |
| **P8** | Wake word + diarization + listen/loopback + word-timestamps + file-transcribe (advanced v1) | P4 | ⬜ |
| **P9** | Frontend IPC re-wire; parity pass vs Python+Electron WinSTT; package DirectML + CPU installers | P5–P8 | ⬜ |

---

## Mandatory gates (do NOT skip — each is a go/no-go)

### 🔴 GATE 1 — STT engine de-risking spike (`03_stt_engine.md` §11) — THE primary gate
Load real **Whisper-fp16** (`onnx-community/whisper-tiny@fp16`) + **lite-whisper-fp16** +
**Cohere-fp16-sharded** in `ort 2.0.0-rc.12` and reproduce transcripts matching the Python server
(whitespace-diff tolerance). Proves the five riskiest mechanisms:
1. in-file **fp16 decoder protobuf repair** (§6.1) is feasible on ort — **the biggest unknown**;
2. `ORT_ENABLE_EXTENDED` dodges SimplifiedLayerNormFusion (§6.2);
3. IoBinding KV-cache greedy loop, one-token-per-cached-step (§4.1);
4. Cohere fp16 KV-cache dtype read-off-session + logits f32-promote (§6.5);
5. sharded `.onnx_data_1` completeness + `*.onnx?data_*` refetch (§2.3, delete-a-shard test).
Smoke-test sense-voice-small int8 (fbank+LFR+CMVN), zipformer-en (uppercase→lowercase), and
nemo/cohere routing to **CPU** on a directml-feature ort build.
**Output:** p50 for whisper-tiny-fp16-DML vs target ~85ms + a go/no-go. **If the fp16 patch is
infeasible → fall back to fp32 default exports** for affected Whisper models (documented escape hatch).
**No decode-loop / engine-swap code ships until this is green.**

### 🟠 GATE 2 — `cargo tree` dependency gates (`lib_wiring.md` §8)
(a) one `ort 2.0.0-rc.12`; (b) ndarray major matches ort's `0.17.x`; (c) count native onnxruntime
runtimes across ort + sherpa-onnx + kokoroxide, confirm only ort copies the loose DLL (sidecar
sherpa on symbol clash). Reconcile `sherpa-onnx 1.13.2` vs the stray `sherpa-rs 0.6.8` naming.

### 🟡 GATE 3 — TTS phonemizer license/quality A/B (`06_tts.md`)
Spike `any-tts` (pure-Rust phonemizer, no espeak-ng) vs `kokorox`/espeak-ng on the 9 Kokoro
languages. If `any-tts` quality holds (risk: ja/cmn/hi) **and** license is permissive → in-process
Kokoro **without GPL-v3**. Else default build = **GPL-v3** in-process Kokoro (blueprint-sanctioned)
with the `SidecarKokoroEngine` (separate GPL exe over stdio = mere aggregation) ready if the app must
stay proprietary. **This is a product/licensing decision, not just engineering.**

### 🟢 GATE 4 — DistilBERT smart-endpoint asset (`04_*`)
The HF classifier ships PyTorch-only — no `model.onnx`. Needs a one-time offline
`optimum-cli export onnx` + hosting `model.onnx`+`tokenizer.json`+`config.json` as a **PUBLIC**
asset (private repo 404s tokenless — memory `project_private_repo_breaks_pack_distribution`). Until
then, smart endpoint runs `NullClassifier` (punctuation heuristic — exactly like the Python server
when `transformers` is absent). Non-blocking: ship without it.

### Secondary spikes (compile-loop, lower stakes)
- Ollama NDJSON streaming transport (reqwest `bytes_stream` + `futures-util` newline drain; per-chunk
  reasoning-delta emit) vs a live local Ollama (`07_*`).
- `winstt-context.exe` sidecar path resolution at target triple + 1200ms wedged-UIA-walk kill (`07_*`).
- ort 2.x IoBinding API ergonomics; base85 RFC1924 round-trip vs a real `_ALIGNMENT_HEADS` entry (`05_*`).
- sherpa KWS short-trigger recall (`05_*`).

---

## Crate deps to add (aggregated from all slices)

Full justification + features in `00_cargo_additions.md`; registration in `lib_wiring.md` §8.
Versions verified on crates.io in **2026-05**.

**New deps:**
```
ort = "=2.0.0-rc.12"          # features: ndarray, copy-dylib; +directml on windows (one runtime for all ~42 STT models + TTS)
ndarray = "0.17.2"            # match ort rc.12's ndarray major
tokenizers = { version = "0.22.1", default-features = false, features = ["onig"] }   # DistilBERT smart-endpoint + custom models ONLY
sherpa-onnx = "1.13.2"        # k2-fsa FIRST-PARTY (not deprecated sherpa-rs) — KWS wake word + diarization embedder
kokoroxide = "0.1.5"          # local in-process Kokoro TTS — OR kokorox(GPL)/any-tts; chosen by GATE 3
ollama-rs = "0.3.4"           # native Ollama /api/* (pull-progress is NOT OpenAI-compatible)
wasapi = "0.23.0"             # WASAPI loopback capture (windows) for listen mode
zip = { version = "8.6.0", default-features = false, features = ["deflate"] }        # STABLE (8.6, not 9.0-pre)
keyring = "4.0.1"             # windows-native secret store for API keys
symphonia = { version = "0.6.0", default-features = false, features = ["wav","mp3","isomp4","aac","flac","ogg","vorbis"] }  # file-transcribe decode
base85 = "2.0.0"              # RFC1924 = matches Python b85decode (Whisper alignment-heads table)
hf-hub = "1.0.0-rc.1"         # HF snapshot resolver for STT model files
prost                         # ONNX-proto edit for fp16 decoder patch (03_* §6.1) — pin exact in compile loop
```

**Existing deps to extend (feature/edit only — Handy already declares the crate):**
```
transcribe-rs                 # MODIFY: per-OS windows pin 0.3.3 → 0.3.8 (carries ort = =2.0.0-rc.12) — the ONE mandatory Cargo edit
reqwest                       # ADD `multipart` feature to current ["json","stream"] (cloud_stt upload)
futures-util                  # 0.3 — reuse for Ollama NDJSON bytes_stream drain
windows = "0.61.3"            # ADD features: Win32_Media_Audio, Win32_System_Com, Win32_System_ProcessStatus,
                              #   Win32_System_Threading, conditional Win32_UI_Accessibility + Win32_Security_Cryptography
flate2                        # reuse for gzip-inflate of alignment-heads blobs
rdev                          # reuse for tts_read hotkey (do NOT re-add)
tauri-plugin-shell            # ADD only if context sidecar uses transport (A); transport (B) std::process::Command needs no dep
```

**Evaluated & rejected (record so they aren't re-litigated):** `async-openai` (reqwest `llm_client.rs`
covers cloud LLM/STT), `uiautomation` in-process (ship the C `winstt-context.exe` sidecar instead),
`kokorox` as a cargo dep (GPL-3.0 + unpublished to crates.io — sidecar fallback only),
`sherpa-rs` (deprecated 3rd-party binding — **use `sherpa-onnx`**; one slice's `sherpa-rs 0.6.8`
must be reconciled in the compile loop).

---

## Load-bearing invariants (carry forward every session)

- `panic = "unwind"` (release profile) is **load-bearing** — the transcription `catch_unwind` depends
  on it. The `catch_unwind`/peak-normalize chokepoint stays in the **coordinator/manager**, not the engine.
- **Silero VAD = CPU-only** (CUDA-deadlock invariant).
- **NeMo / Cohere / GigaAM / Kaldi / SenseVoice / Dolphin = DirectML-incompatible → force CPU.** This
  set is **identical** to the **int8-preferred** family set (7 families incl. `t-one`) — `catalog.rs`
  asserts the equality as a test; do not let them drift.
- **Canary / Cohere context-prompt slot is untrained** → no initial-prompt bias for them (Whisper-only).
- fp16-auto only ≥500M params **on CUDA** AND only if the family publishes fp16 (Canary has none).
- **CUDA is retired on Windows** — DirectML (default GPU) + CPU only; no `ort`/cuda feature.
- Kokoro TTS is **DirectML-safe** (not in the int8 DML-incompatible STT set).
- **espeak-ng is GPL-v3** → in-process Kokoro makes the whole binary GPL-v3 (GATE 3 decision).
- **New code only under `winstt/`**; Handy-file edits are the explicit, minimal list in `lib_wiring.md` §0.
- `winstt/mod.rs` is **missing 4 module declarations** (`catalog`, `stt`, `wakeword`, `tts`) — repair
  first thing in the compile loop (write-conflict casualty).

---

## Known drift / corrections logged (so they aren't re-discovered)

- Catalog is **42 models, not ~40** (inventory `03_stt_core.md` undercounts: whisper 14→15
  +crisper-whisper, nemo 7→8 +canary-1b-flash; moonshine tiny-zh/ja replaced by uk/fr). Live
  `catalog.json` is authoritative.
- Settings: inventory `01_settings_schema.md` still lists removed `model.computeType` + `tts.device`
  — both gone from the live Zod schema. Follow `settings-schema.ts`, not the spec or inventory.
- transcribe-rs only covers **6 STT families** — confirms the full ort re-port (not a transcribe-rs
  extension) is required for the 42-model catalog.
- `detection_speed` runtime default is **2.0** (ServerState), not the 1.5 in `EndpointConfig`.

---

## Reference index (read when resuming a subsystem)

| Need | Source |
|---|---|
| Master plan + blueprint | `app/PORT/README.md` |
| Registration map (mod/manage/commands/events/actions/sidecar) | `app/PORT/lib_wiring.md` |
| Per-subsystem specs | `app/PORT/00..07_*.md` |
| WinSTT behavior (reference engine) | `../server/src/` (Python) |
| WinSTT renderer (to reuse) | `../frontend/src/` |
| Authoritative settings | `../frontend/src/shared/config/settings-schema.ts` |
| STT correctness (~12 per-model fixes) | `E:/DL/Projects/onnx-asr/src/onnx_asr/` |
| Verified inventory + Handy extension map | `E:/DL/Projects/handy_winstt/examples/winstt-port-docs/inventory/01..09_*.md` |
| Hard-won invariants | `C:/Users/MASTE/.claude/projects/E--DL-Projects-WinSTT/memory/*.md` |
| Handy registration site | `app/src-tauri/src/lib.rs` (managers L140–167, commands L326–429, events L430) |
| Handy action/binding pattern | `app/src-tauri/src/actions.rs` (ACTION_MAP L700) + `settings.rs` (default_bindings L725) |
