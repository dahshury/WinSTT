# WinSTT (Tauri) Bundle-Size Analysis

**Date:** 2026-06-03. All sizes measured from `src-tauri/target/release/` + `src-tauri/resources/` + `dist/` on this machine.

> Historical note: the tracked `resources/espeakng_loader/` copy was removed after this analysis. Current builds install the eSpeak NG runtime on demand under app data instead of bundling that tree.

## 1. What ships today (the installed app)

Tauri bundles the **main binary + the DLLs next to it + `resources/**/*`**; WebView2 is a download-bootstrapper (NOT a bundled runtime). The 26 MB `handy_app_lib.dll` (cdylib) is a build artifact and does **not** ship (the exe statically links the lib).

| Shipped item | Size | What it is |
|---|---|---|
| `winstt.exe` | **67 MB** | Rust binary, **already stripped** (`strip=true`, `lto=true`, `codegen-units=1`). Statically links: `transcribe-rs` (**whisper.cpp + ggml**, GGML STT), `sherpa-onnx`, the `ort`/ONNX glue, Tauri runtime, **and the embedded frontend** (`dist/` = 7.6 MB). |
| `DirectML.dll` | **18 MB** | DirectML GPU execution provider (for STT on GPU). |
| `onnxruntime.dll` | **16 MB** | ONNX Runtime core (winstt ONNX engines + transcribe-rs ONNX). |
| `sherpa-onnx-c-api.dll` (+ cxx-api, providers_shared) | **~4.8 MB** | sherpa-onnx — wake-word KWS + speaker-diarization. |
| `resources/espeakng_loader/` | **19 MB** | `espeak-ng.dll` (0.4 MB) + **`espeak-ng-data` ~18.6 MB** — phoneme dicts for **~100 languages** (`ru_dict` 8.2 MB, `cmn_dict` 1.5 MB, `lb_dict` 0.7 MB, `yue_dict` 0.5 MB, `ar_dict` 0.5 MB, …). |
| `resources/models/silero_vad_v4.onnx` | **1.8 MB** | Silero VAD — loaded at startup, legitimately bundled. |
| `resources/*.wav` + tray icons | **~0.6 MB** | recording/feedback sounds + tray PNGs. |
| WebView2 | bootstrapper | Downloaded at install (correct — not the ~150 MB fixed runtime). |

**Installed total ≈ 127 MB** (excl. WebView2 runtime). The NSIS installer is LZMA-compressed, so the *download* is likely ~60–80 MB; the *on-disk* footprint is ~127 MB. Models/voices are **not** bundled (they download on-demand) — that part is already correct.

## 2. Why it's big (ranked)

1. **`winstt.exe` 67 MB** — dominated by statically-linked native C/C++: whisper.cpp+ggml (transcribe-rs), sherpa-onnx, ort glue, + 7.6 MB embedded frontend. Two STT stacks live here (see §4 W2).
2. **ONNX runtime + DirectML = 34 MB** of DLLs.
3. **espeak-ng-data 18.6 MB** — multilingual dicts, most of which are never used.
4. **sherpa-onnx ~4.8 MB DLLs** (+ static in the exe).

## 3. Already optimal (no win here)

- `strip = true`, `lto = true`, `codegen-units = 1` — release profile is already size-tuned.
- WebView2 = download-bootstrapper (not a bundled fixed runtime).
- No STT/TTS **models or voices** in the bundle — they download on-demand (only the 1.8 MB Silero VAD ships, which is needed at boot).

## 4. Wins (ranked by value ÷ effort)

### W1 — DirectML.dll (18 MB) → optional / on-demand GPU pack ★★★★★
DirectML is only used for **STT on GPU**; TTS is CPU-only and many STT families are forced to CPU anyway. Ship **CPU-only by default** and fetch `DirectML.dll` on first GPU use (or behind a "GPU acceleration" toggle). `ort` loads EP DLLs dynamically, so the DLL can live in the per-user data dir and be downloaded like a model. **~18 MB off the default install.** Medium effort.

### W2 — Consolidate the two STT stacks ★★★★☆ (biggest, needs a product decision)
The app links **both** Handy's `transcribe-rs` (whisper.cpp/ggml + its parakeet/moonshine/sensevoice + sherpa-onnx) **and** WinSTT's own ONNX catalog (`LoadedEngine::Winstt`: lite-whisper, cohere, gigaam, …). `EngineType::Whisper` still routes to the **GGML whisper.cpp** engine (`WhisperEngine::load`), while the catalog the user actually runs (lite-whisper, cohere) is the winstt ONNX path. If the winstt ONNX catalog is canonical:
- Dropping `transcribe-rs`'s `whisper-cpp` feature removes **whisper.cpp + ggml** (several MB of static code in the 67 MB exe).
- If wake-word/diarization aren't core, dropping `sherpa-onnx` removes **~4.8 MB of DLLs** + its static code.
Potentially **20–40 MB** off the exe. **High value, high effort + needs verification** that no shipped model needs the GGML/transcribe-rs path (and that KWS wake-word has a winstt replacement). This is the deep refactor; do it deliberately.

### W3 — Prune espeak-ng-data to used languages ★★★☆☆
Keep the core (`phondata`, `phonindex`, `phontab`, `intonations`) + `lang/` voice defs + the per-language dicts for **only** the languages we phonemize (en + the Kokoro 9 + Piper 49). Drop the ~40 unused languages' `*_dict` files. Add a prune step to the build (or curate `resources/` so `resources/**/*` only globs the kept set). **~5–10 MB.** Caveat: must keep every lang any voice uses (e.g. `ru_dict` 8.2 MB stays — Piper ru_RU; `cmn_dict` stays — Kokoro/Piper Chinese). Medium effort, low risk if the kept-list is derived from the catalogs.

### W4 — `panic = "abort"` in `[profile.release]` ★★★☆☆
Currently `panic = "unwind"`. Switching to `abort` drops landing-pad/unwind tables (~1–3 MB) and is slightly faster. Low risk — the app already wraps its hot loops in `catch_unwind` at the boundaries; audit those (the hotkey pump, coordinator) since `abort` makes in-thread `catch_unwind` ineffective. **~1–3 MB**, trivial to try.

### W5 — Frontend trim ★★☆☆☆
`dist/` is 7.6 MB embedded. The `winstt-diag` chunk is oddly **354 KB** — investigate what it pulls in (a diagnostic helper shouldn't be that big). Run `knip` for dead deps/exports. Realistic **~1–2 MB**. Low priority.

### W6 — Confirmed non-issues
- `handy_app_lib.dll` (26 MB cdylib) does **not** ship — verified.
- WebView2 already a bootstrapper — no win.
- `strip` already on — no win.

## 5. Recommended order

1. **W1 (DirectML on-demand, ~18 MB)** — biggest clean win, no functional loss (GPU users fetch it once).
2. **W3 (espeak prune, ~5–10 MB)** + **W4 (panic=abort, ~1–3 MB)** — quick, low-risk.
3. **W2 (drop transcribe-rs/whisper.cpp/sherpa if redundant, 20–40 MB)** — the big one, but a deliberate refactor: first confirm the winstt ONNX catalog fully supersedes the GGML/transcribe-rs engines and that wake-word has a winstt path.
4. **W5 (frontend, ~1–2 MB)** — opportunistic.

**Ceiling:** W1+W3+W4 alone ≈ **25–30 MB** off ~127 MB with low risk. Adding W2 could roughly **halve** the install (~60–70 MB) but is the involved one.
