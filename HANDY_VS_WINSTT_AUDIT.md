# WinSTT (Rust fork) vs. upstream Handy — comparison audit

**Date:** 2026-06-02 · **Method:** 13 parallel per-dimension code auditors → 1 adversarial verifier per dimension (skeptical, default-refute, checks `winstt/` for reimplementations) → synthesis. 27 agents, ~2.7M tokens, 644 tool calls. **60 findings survived verification** (1 critical, 12 high, 17 medium, 30 low); **3 claims refuted**.

> Scope note: this is deliberately one-sided — it hunts for **where Handy beats us**, as asked. A balanced "where we beat Handy / parity" section is at the end so the picture isn't distorted. WinSTT is ~58k LOC vs Handy's ~13.7k; we forked Handy's lean core and layered a ~44k-LOC `winstt/` tree (cloud STT, TTS, diarization, wakeword, LLM, realtime, context, snippets, file-transcribe) it doesn't have. **None of that added capability is a regression** — the regressions are concentrated in (a) edits to shared/forked files and (b) the seams between the two halves.

---

## Verdict: the five ways Handy is genuinely better

1. **Model lifecycle is network-coupled, non-atomic, and offline-hostile.** Handy loads a cached model from a local path with **zero network** and never tears down a working engine on a failed swap. Our HF-resolver requires a **live HuggingFace tree-listing on every load/swap even for 100%-cached models**, and `load_model_blocking` **unloads the working engine *before* attempting the new load with no rollback** — so a network blip both fails the swap *and* leaves nothing dictatable. These compound.
2. **The IPC boundary throws away the type safety it pays to generate.** We run `tauri-specta` codegen (3161-line `bindings.ts`) but **import it from zero renderer files**; every call crosses an untyped string-channel adapter that resolves `undefined` on an unmapped channel. Renderer types come from the **deleted Python server's OpenAPI spec**, not the Rust commands — two never-reconciled contracts that already shipped the mic-device `index` string-vs-number bug (HEAD `ae7672c`).
3. **A single settings store vs. our two.** Handy has one `Settings` struct, one store, one read path. We have **two parallel stores** (`AppSettings` + `WinsttSettings`) where the same `model`/`language`/`microphone` value is read from **different stores by different `transcribe()` arms** — a divergence class Handy structurally cannot have.
4. **Handy's CI compiles, clippy's, tests, and builds the shipped code.** Ours targets the **deleted Electron `frontend/` and `server/` dirs**, so the ~58k-LOC Rust crate and its **62 test files (6× Handy's) never run in CI**. A broken Rust commit merges green.
5. **Lean startup + runtime hot path.** Handy builds ~2 WebView2 windows; we **synchronously build 8 prewarmed secondary windows** (one debug-only) plus a splash in `setup()` — the splash exists only to hide that cost. On the dictation path, cloud STT hits a **nested-runtime panic** (`block_on` inside a tokio worker).

The honest through-line is **fork debt**: not careless code, but the cumulative cost of grafting a much richer feature set and an Electron-shaped renderer onto Handy's minimal core.

---

## Critical / High findings (verified)

### 🔴 CRITICAL — Cached-model load needs a live HF network round-trip · `model-lifecycle`
- **Ours:** `resolver.rs:638-649` `resolve_remote()` unconditionally calls `list_repo_tree` → `repo.info().send()` (HTTP) before any download; `local_files_only` (`resolver.rs:731`) only gates per-file download, not the tree listing. `load_winstt_model` does this on every load/swap (`transcription.rs:753`).
- **Handy:** `transcription.rs:287` `get_model_path()` → purely-local `PathBuf` (`model.rs:1397` fs checks only) → `WhisperEngine::load`. Zero network.
- **Why:** We can't load/swap a 100%-cached model when HF is unreachable/slow; every post-idle reload pays network latency. Offline + latency + correctness regression.
- **Fix:** Offline-first tree resolution — derive the file set from the on-disk hf-hub snapshot (reuse `cache_probe.rs:222` scan) or cache the siblings list keyed by `(repo,revision)`; only hit `repo.info().send()` on a genuine cache miss. Pass-1 (`resolver.rs:547`) must never touch the network.

### 🟠 HIGH — Model swap unloads before load, no rollback · `model-lifecycle`
- `transcription.rs:572-615` `load_model_blocking` calls `unload_model()` **before** the new load; a failed resolve/build returns `Err` with no engine resident. Handy (`transcription.rs:253-413`) builds the new engine first, installs it only on success. **Fix:** build-new-then-swap; if the Windows DLL race truly forbids two concurrent ORT sessions, resolve+verify offline-first *before* unloading and re-emit `loading_completed` on failure.

### 🟠 HIGH — Picker-open does a full HF cache scan + per-`.onnx` parse on the command thread · `model-lifecycle`
- `runtime.rs:141-178` `list_models_with_state` (sync command) → `block_on(probe_cache)` over the whole catalog; `cache_probe.rs:242` `verify_external_data_complete` stat/parses every `.onnx`. Handy clones an in-memory `HashMap` (`model.rs:641`). **This is the Rust re-incarnation of the documented Python `list_models_onnx_parse_loop_starvation` bug.** **Fix:** make it `async fn` + `await` (no `block_on` on the command thread), memoize with a short TTL, keep `verify_external_data_complete` off the list path.

### 🟠 HIGH — Dual settings source-of-truth · `settings` + `architecture` (two findings, same root)
- `settings.rs:915` `get_settings` (AppSettings / `settings_store.json`) and `winstt/commands/settings.rs:129` `read_settings` (WinsttSettings / `winstt-settings.json`) both hold `model`/`language`/`microphone`/`historyLimit`/`retention`. Different `transcribe()` arms read from different stores; consistency depends on the renderer firing the right IPC pair. **Fix:** one owner per field — make all engine arms read `language` from `WinsttSettings.model.language`, delete the `AppSettings.selected_language` read (`transcription.rs:956`) + `apply_language` shim (`dictation.rs:113`); collapse `selected_model` onto `WinsttSettings.model.model`. Add a `debug_assert`/test that shared keys are never read from both stores by one path. (Do **not** fully unify AppSettings — it carries live Handy-only fields.)

### 🟠 HIGH — `prewarm_windows` builds 8 WebView2 windows synchronously in `setup()` before the pill shows · `startup`
- `lib.rs:780` → `windows.rs:696` loops `WINDOW_SPECS` building 8 secondary WebView2 instances on the main thread before `show_main_window` (`lib.rs:842`). Handy builds 1 (`lib.rs:294`). **Fix:** move `prewarm_windows` *after* `show_main_window`; eagerly prewarm only `overlay` + `tray-menu`, defer the rest to an idle callback / first-open via `run_on_main_thread` (**not** lazy-build-in-`open_window` — that hangs, `windows.rs:686`). Then the splash + backstop thread become removable.

### 🟠 HIGH — Generated `bindings.ts` is dead; renderer is type-erased · `ipc-typesafety` (3 findings)
- `src/bindings.ts` (3161 lines) imported by **zero** renderer files; all calls go through `electron-tauri-adapter.ts:672` `invoke(channel: string, ...args: unknown[]): Promise<unknown>`. Handy: 101 sites `import { commands } from "@/bindings"`, tsc-checked against Rust signatures.
- Renderer types come from `@spec/schema` (the **deleted Python server's** OpenAPI), not the Rust commands — the `AudioDevice` shape already diverges (`index:string`/`is_default` vs `index:number`/`isDefault`), which shipped the mic bug.
- Boundary failures are **swallowed into fallbacks** (`invokeOrDefault`), so a backend error is indistinguishable from "no value" — how "download 0% / RAM unknown" went unreported.
- **Fix (incremental):** first fix the 6 duplicate-identifier exports in `bindings.ts`; add it to tsc/CI; re-point new WinSTT feature code at `import { commands } from '@/bindings'`; generate `models.ts` from `bindings.ts`. Cheap interim: CI test asserting every adapter `ROUTE` `cmd` exists as a key in generated `commands`.

### 🟠 HIGH — Inherited core now depends sideways on the fork tree · `architecture`
- 7 inherited (non-`winstt`) files reach into `crate::winstt::*` — `transcription.rs` alone has 25 refs and grew 854→1432 LOC absorbing cloud/catalog/whisper branching. This **inverts the dependency edge** and defeats the stated "keep upstream merges feasible" goal (`winstt/mod.rs:4`). **Fix:** an `SttBackend` trait owned by `winstt/` that the inherited `TranscriptionManager` holds as `Box<dyn SttBackend>`; move cloud/catalog/whisper branching into a winstt-owned impl.

### 🟠 HIGH — Cloud-STT dictation: `block_on` inside a tokio worker → nested-runtime panic · `concurrency-errors`
- `transcription.rs:880` `block_on(cloud.transcribe_samples(...))` inside the sync `transcribe()`, which is called from `actions.rs:594` `spawn(async)` (a multi-thread tokio worker) → panics "Cannot start a runtime from within a runtime". Our own `resolver.rs:582-585` documents exactly this hazard. **Only** the cloud path via the hotkey/PTT worker is affected (loopback calls from `std::thread` are safe; local engines mask it). **Fix:** wrap the cloud branch in `tokio::task::block_in_place(|| block_on(...))`, or hoist the await up to the async `actions.rs` layer.

### 🟠 HIGH — CI targets the deleted Electron app; the Rust port has no CI · `build-test-release` (2 findings)
- `.github/workflows/ci.yml` runs jobs in `frontend/` and `server/` — **neither directory exists** (the port's renderer is `src/`, backend `src-tauri/`). 62 Rust test files never run. Handy's CI matches its layout and gates the build. **Fix:** add a CI job: `cargo fmt --check`, `cargo clippy --all-targets -D warnings`, `cargo test`, `tauri build --no-bundle` (windows-latest, or ubuntu with the `transcription_mock` swap); delete/re-point the dead Electron workflows. **This is rank #1 — it makes every other fix verifiable.**

### 🟠 HIGH — A second, never-shown `recording_overlay` WebView2 window built at boot · `ui-windows-tray-overlay`
- `lib.rs:371` builds Handy's `recording_overlay`, but every show path (`overlay.rs:379`) redirects to the React `overlay` window (`windows.rs:119`). `recording_overlay`'s only `show()`er is `#[allow(dead_code)]` — yet it still receives **per-frame `emit_levels` on the ~94 Hz audio callback** that no renderer listens to. **Fix:** stop calling `create_recording_overlay` on all platforms; delete it + `show_overlay_state` + `force_overlay_topmost` + the `recording_overlay` branch of `emit_levels` + the unlistened global `mic-level` emit; drop it from `capabilities/default.json`.

---

## Medium findings (verified) — by pipeline

- **STT:** `transcribe()` re-reads the whole WinSTT settings tree 3-5× per dictation; post-swap `warmup` serializes a cold decode in front of a racing real decode (holds `is_loading`).
- **VAD:** three unwired "DRAFT PORT — not yet compiled" modules (`endpointing`, `composite_vad`, `vad_calibrator` math, ~1100 LOC) ship as dead weight that still compiles.
- **Model:** dropped Handy's cheap `is_downloaded` pre-check on the catalog load path; per-quant downloads spawn **unbounded OS threads** (no concurrency cap), each holding a blocking HF client + nested `block_on`.
- **Audio:** "first non-virtual" mic heuristic silently overrides the OS default when "Default" is selected (never falls through to `default_input_device()`); the `live_audio` mirror doubles recording memory and clones the full buffer every realtime tick → **O(N²) per utterance**.
- **Settings:** secret decryption spawns `reg.exe` up to 3× per settings read (no machine-key cache) — but only when an API key is configured; the schema split + restart-classifier triples the surface for adding a setting.
- **Startup:** the **debug-only `context-playground` window is prewarmed in release builds**.
- **Shortcuts:** toggle/listen/wakeword dispatch now depends on a live WebView2 round-trip (the class behind the "~2s to listening" bug); PTT is dispatched twice through the coordinator, relying on the Stage machine deduping a race.
- **Text injection:** the Transforms pipeline pastes (and drives Enigo copy keystrokes) **off the async-runtime worker**, breaking the main-thread paste discipline, and reuses the dictation paste verbatim so `append_trailing_space`/`auto_submit` (an Enter keypress) leak into an in-place REPLACE.
- **Architecture:** two manager directories (`managers/` vs `winstt/managers/`) with no documented boundary rule; several winstt managers are >800-LOC god-objects.
- **Tray:** `update_tray_menu` rebuilds the entire native menu (looping all models) on every state transition, then does `let _ = menu;` — the HTML tray menu replaced it.

(30 low findings — dead-code cleanup, stale headers, hardcoded spike paths, log-level demotions, etc. — are in the action plan's quick-wins.)

---

## Prioritized action plan

| # | Action | Sev / Effort | Files |
|---|--------|------|-------|
| 1 | **Add real Rust+Tauri CI** (`fmt`/`clippy`/`test`/`tauri build`); delete dead Electron workflows | high / S–M | `.github/workflows/*` |
| 2 | **Offline-first cached-model load** (no HF tree-list on load/swap) | crit / M | `winstt/stt/resolver.rs`, `cache_probe.rs` |
| 3 | **Failure-atomic model swap** (build new before unloading old) | high / M | `managers/transcription.rs` |
| 4 | **Fix cloud-STT nested-runtime panic** (`block_in_place` or hoist await) | high / M | `managers/transcription.rs`, `actions.rs` |
| 5 | **Collapse dual language/model reads to one store per field** | high / L | `transcription.rs`, `dictation.rs`, `settings.rs` |
| 6 | **Defer window prewarm past `show_main_window`; cfg-gate context-playground** | high / M–L | `lib.rs`, `windows.rs`, `splash.rs` |
| 7 | **Async picker-open cache scan**; verify off the hot path | high / M | `runtime.rs`, `download_manager.rs`, `cache_probe.rs` |
| 8 | **Adopt `bindings.ts` for the WinSTT slice** (fix 6 dup exports first) | high / L | `bindings.ts`, adapter, `settings_schema.rs` |
| 9 | **Delete dead `recording_overlay` + orphaned `emit_levels`** | high / S | `lib.rs`, `overlay.rs`, `capabilities/default.json` |
| 10 | **Backend = single authority for hotkey dispatch** (ptt+toggle); kill double-dispatch | med / M | `shortcut/handler.rs`, `use-push-to-talk.ts` |
| 11 | **Transforms paste on main thread + replace-mode paste** | med / S | `transforms.rs`, `actions.rs`, `clipboard.rs` |
| 12 | **Renderer types from `bindings.ts`, not the dead OpenAPI spec** | high / L | `models.ts`, `bindings.ts`, `ipc-client.ts` |
| 13 | **Surface IPC failures instead of swallowing into fallbacks** | med / M | adapter, `ipc-client.ts` |
| 14 | **`SttBackend` trait to restore the one-way dependency edge** | high / L | `transcription.rs`, `winstt/stt/mod.rs`, `audio.rs` |
| 15 | Reduce per-dictation settings read amplification + warmup race | low–med / S–M | `transcription.rs` |
| 16 | Stop silence gate dropping quiet speech; unify listen-mode VAD under SmoothedVad | low / M | `transcription.rs`, `loopback_manager.rs` |
| 17 | Bound download concurrency (Semaphore); cache machine key (OnceLock) | med / M | `download_manager.rs`, `secret_storage.rs` |
| 18 | Route main-window quit through `app.exit(0)` + watchdog (runs `cleanup_before_exit`) | low / M | `lib.rs` |
| 19 | Remove the discarded native-menu rebuild in `update_tray_menu` | med / S | `tray.rs` |
| 20 | Honor OS default mic when "Default" selected (heuristic as fallback) | med / S | `managers/audio.rs` |
| 21 | Realtime snapshot O(new samples) not O(N) full-buffer clone | med / M | `recorder.rs`, `realtime_manager.rs` |
| 22 | Delete/cfg-gate dead draft modules; strip false "not yet compiled" headers | low / S | `composite_vad.rs`, `endpointing.rs`, `paste_ext.rs` |
| 23 | Recover poison in `transcribe_realtime`; document the dual-manager boundary | low / S | `transcription.rs`, `winstt/managers/mod.rs` |

### Quick wins (each a small, standalone edit)
- `cargo test` (then clippy/fmt) as a CI job — enforces 62 untested files.
- `cfg`-gate `context-playground` out of the prewarm loop in release.
- Delete `create_recording_overlay` + orphaned `mic-level`/`emit_levels` (dead window + 94 Hz hot-path work in one edit).
- Delete the `MenuItem`/`Submenu` construction in `update_tray_menu` (it ends in `let _ = menu;`).
- Delete `composite_vad.rs` + its `pub mod` line (confirmed fully dead; keep `vad_calibrator` — it's live).
- Strip false "not yet compiled" headers from ~50 shipping files; **keep** the `PORT IMPL — Source:` provenance lines.
- Memoize `machine_key` in a `OnceLock` (N `reg.exe` spawns → 1).
- CI assertion: every adapter `ROUTE` `cmd` exists in generated `commands`.
- `store.save()` on the AppSettings write path (durability parity with the WinSTT store).
- Demote per-utterance `LEVEL_LOG_TICK` + silence-gate `log::info!` → `debug!` (≈1/s steady-state log I/O off the audio path).
- Replace hardcoded spike-bin paths (`C:/Users/MASTE/…`, `E:/DL/…`) with `CARGO_MANIFEST_DIR`-relative + a dev feature.

---

## What did NOT hold up (refuted — do not action)

1. **"transcribe-rs 0.3.8 vs 0.3.3 version split is a problem."** No-op in *both* repos: Handy's `cfg(windows)` line carries the **identical** `0.3.3` pin, and Cargo resolves a single `0.3.8` either way. Not a Handy advantage. *(This was my own opening hunch — correctly killed by verification.)*
2. **"~2.5× higher unwrap/expect/panic density than Handy."** Raw counts are higher, but **per-kLOC we're lower in every category** (unwrap 5.15 vs 8.89; `lock().unwrap()` 1.48 vs 4.52) and we use the poison-tolerant `if let Ok = lock()` pattern 39× vs Handy's 3×. We are *more* defensive, not less. All 4 `panic!` sites are test/spike-only.
3. **"We discard the real `hotkey_string` on the transcribe path."** Both trees mark it `_shortcut_str` (deliberately unused) on the transcribe action; Handy's forwarding is a no-op there too. No consumer exists.

---

## Where we beat Handy / are at parity (for balance)

- **Whisper decode:** our `winstt/stt/whisper.rs` is a correct device-resident IoBinding KV-cache loop with per-step `synchronize_outputs` — fixes DML host-round-trip slowness+corruption that Handy's GGML whisper-cpp arm can't do for ONNX exports.
- **Security:** we encrypt API keys at rest (per-machine key); Handy stores them plaintext in the store file.
- **Robustness retained verbatim:** `transcription_coordinator.rs`, `signal_handle.rs`, `model.rs`, `tauri_impl.rs`, `resampler.rs`/`device.rs`/`visualizer.rs`, `input.rs`/`clipboard.rs` are byte-identical (modulo CRLF) — the panic-safety design (catch_unwind, take/put-back, poison-recovering `lock_engine`, idle watcher, `LoadingGuard` RAII) is preserved.
- **Richer error types:** `winstt` uses proper `thiserror` enums where Handy uses bare `anyhow`.
- **Dev-loop build speed:** our `line-tables-only` debug + `opt-level=2` deps + `lld-link` beat Handy's bare profile; release profiles are identical.
- **Genuine added robustness:** lone-Win-key Start-menu suppression in `handy_keys.rs`; overlay `OVERLAY_SHOW_GENERATION` race guard Handy lacks; per-field `#[serde(default)]` migration tolerance; `get_stored_binding` panic fix (vs Handy's `.unwrap()`).
- **Net-new capability Handy has none of:** cloud STT, TTS, diarization, wakeword, LLM transforms, realtime preview, file-transcribe queue, context-awareness, snippets, per-quant download/cache management.
