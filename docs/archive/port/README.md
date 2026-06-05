# WinSTT → Rust/Tauri port (`app/`)

This directory (`app/`) is the **WinSTT desktop app rewritten in Rust + Tauri 2**, built on top of the
[Handy](https://github.com/cjpais/Handy) foundation (MIT). It lives on the `winstt-rust-port` branch inside
the WinSTT repo. The original Python+Electron WinSTT (`../server/`, `../frontend/`) stays untouched as the
**behavioral reference** we test against for parity.

## The blueprint (locked design decisions)

| Area | Decision |
|---|---|
| Foundation | **Build on top of Handy** (extend its src-tauri; add WinSTT as new modules) |
| STT engine | **S2 — Unified ONNX on `ort`** (one runtime for every model) |
| lite-whisper | **Keep** — runs via ONNX+`ort` (no whisper.cpp path exists for it) |
| Catalog | **All ~40 models day one** |
| TTS | **Local Kokoro in-process (cargo-link)** ⚠️ espeak-ng is GPL-v3 → app inherits GPL-v3 |
| LLM / Ollama | **All in Rust** (extend `llm_client.rs`; `ollama-rs`/`reqwest`) |
| Wake word | **sherpa-onnx KWS** (open-vocabulary, offline) |
| VAD | **Lean on Handy** (Silero + SmoothedVad) + port Calibrator/dynamic-silence |
| Frontend | **Reuse the React renderer** in the Tauri webview (re-wire IPC → `invoke`/events) |
| Advanced (v1) | realtime · diarization · word-timestamps · listen/loopback · context-awareness · file-transcribe |

⚠️ **Licensing:** the in-process TTS choice cargo-links espeak-ng (GPL-v3), which makes the whole binary
GPL-v3. If the app must stay proprietary, switch TTS to a downloaded sidecar (see `PORT/06_tts.md`).

## Layout

```
app/
├── src-tauri/            ← Rust backend (Handy foundation + WinSTT modules)
│   ├── Cargo.toml        ← deps (additions tracked in PORT/00_cargo_additions.md)
│   └── src/
│       ├── <handy files> ← UNMODIFIED Handy (extend, don't rewrite — keeps merges feasible)
│       └── winstt/       ← ALL new WinSTT subsystems live here (new modules only)
├── src/                  ← Handy React renderer (to be replaced by WinSTT's renderer, IPC re-wired)
└── PORT/                 ← this dir: the engineering package
    ├── README.md         ← you are here (master)
    ├── PROGRESS.md       ← phase tracker (resumable; update every session)
    ├── 00_cargo_additions.md
    ├── 01_stt_catalog.md
    ├── 02_settings.md
    ├── 03_stt_engine.md  ← the ort-ONNX engine + onnx-asr per-model fixes (highest risk)
    ├── 04_vad_endpoint_realtime.md
    ├── 05_wakeword_diarization_loopback_wordts.md
    ├── 06_tts.md
    ├── 07_llm_cloud_context_longtail.md
    └── lib_wiring.md     ← manager/command registration plan for lib.rs
```

## Reference sources (read these when implementing a subsystem)

- **WinSTT behavior:** `../server/` (Python engine), `../frontend/` (Electron app), `../spec/`.
- **Exhaustive verified inventory + Handy extension map:** `E:/DL/Projects/handy_winstt/examples/winstt-port-docs/inventory/01..09_*.md`.
- **Authoritative settings:** WinSTT's Zod schema `../frontend/src/shared/config/settings-schema.ts` (the OpenAPI spec is STALE).
- **onnx-asr fork (STT correctness source):** `E:/DL/Projects/onnx-asr/` — the ~12 per-model fixes the ort engine must replicate.
- **WinSTT project memory (hard-won invariants):** `C:/Users/MASTE/.claude/projects/E--DL-Projects-WinSTT/memory/*.md`.

## Build / test loop (BLOCKED until Rust is installed)

Prereqs (one-time, **user runs these — interactive**):
1. `winget install Rustlang.Rustup` then `rustup default stable`
2. Visual Studio Build Tools with the **Desktop development with C++** workload (MSVC linker).
3. WebView2 (preinstalled on Win11).

Then, from `app/`:
```
bun install
bun run tauri dev      # build + run; iterate on compile errors
```
**Acceptance for the first milestone:** app launches, downloads a Whisper model, hotkey → speak → text pasted,
DirectML engaged (target p50 ≈ 85 ms for whisper-tiny-q4).

## Conventions (honor these)

- **New modules only** under `src-tauri/src/winstt/` — don't rewrite Handy's files where you can extend, so
  `git merge` from a Handy remote stays feasible.
- `panic = "unwind"` in the release profile is **load-bearing** (transcription `catch_unwind`) — don't change it.
- Silero VAD must load **CPU-only** (CUDA deadlock invariant). NeMo/Cohere/GigaAM/Kaldi/SenseVoice/Dolphin are
  **DirectML-incompatible → force CPU**. See `03_stt_engine.md`.
- Every first-draft module is marked `// DRAFT PORT — not yet compiled` until the build loop verifies it.
