# Plan: ARM Phase 1 — native windows-arm64 (aarch64-pc-windows-msvc) WinSTT

> Generated 2026-07-14 by a Fable planning agent from repository analysis. Status: NOT implemented.
> Scope: native ARM64 CPU build only. NPU/QNN is explicitly deferred to a later phase.

## 0. Investigation findings (verified in-repo)

**ONNX Runtime linkage.** `ort = "=2.0.0-rc.12"` with `["ndarray","half"]` base features (`src-tauri/Cargo.toml:126`) plus `["directml"]` added under `[target.'cfg(windows)'.dependencies]` (line 171). `ort-sys 2.0.0-rc.12` downloads pyke prebuilt **static** libs; its dist table (`ort-sys/build/download/dist.txt` in the registry) **includes `aarch64-pc-windows-msvc`** in the "none" feature set (ONNX Runtime 1.24.2). The `directml` cargo feature does not change which binary is downloaded — it only gates the `ort::ep::DirectML` API; per the build script comment, "pyke libs always ship compiled with DirectML on Windows" and unconditionally link `dxguid/DXCORE/DXGI/D3D12/DirectML` for every windows target. So the aarch64 build compiles with the same Cargo.toml, DML EP included. `DirectML.dll` is copied to `target\release\` by ort-sys's `copy_dylibs`, then staged by `tools/windows/tauri-build.ps1` (lines 117–134, hard `throw` if missing) into `src-tauri/binaries/runtime/`, which `src-tauri/tauri.windows.conf.json` maps next to the exe (`"binaries/runtime/*.dll": "./"`). `src-tauri/build.rs:97` already `/DELAYLOAD`s `directml.dll`/`d3d12.dll`/`dxgi.dll`, so the exe starts even if DML is never touched.

**Device routing choke points** (this is where "windows = DirectML" lives):
- `src-tauri/src/winstt/stt/device.rs:86` — `DeviceType::Auto if cfg!(windows) => Accelerator::DirectMl`.
- `src-tauri/src/winstt/tts/provider.rs:194–195` — `TtsDevice::DirectMl` and `TtsDevice::Auto if cfg!(windows)` → DML.
- `src-tauri/src/winstt/stt/device.rs:164` — `execution_providers` pushes `ort::ep::DirectML` under `#[cfg(windows)]`.
- `src-tauri/src/managers/transcription/accel.rs:60` — `available_ort_options` lists `directml` under `#[cfg(windows)]`.
- `src-tauri/src/winstt/commands/runtime.rs:355 enumerate_gpus()` — DXGI adapter enumeration; the **entire renderer** keys "GPU available" off `gpus.length > 0` (fit-assessor `src/entities/system-resources/lib/fit-assessor.ts:159,367`, picker `src/widgets/model-picker/stt/lib/filter-state.ts:69`, download dialog, LLM hardware-fit, `SttModelCard`). The doc comment on `gpu_get_info` says explicitly: non-empty list = "a DirectML-capable GPU exists". `detected_max_vram_bytes()` (runtime.rs:416) feeds `fit_aware_auto_quant`'s VRAM budget.
- Everything else (`families/*`, `backend.rs`, `whisper/ort_shapes.rs`, IO-binding `AllocationDevice::DIRECTML` picks) only acts when `providers.first() == DirectMl`, so it's downstream of `resolve_accelerator`.

**Quant policy on CPU is already correct**: `fit_aware_auto_quant` (`src-tauri/src/winstt/stt/quant_resolve.rs:167 CPU_ORDER`) prefers fp32→int8→q4 and demotes fp16-compute quants; STT `DeviceType` is only `auto|cpu` (settings_schema.rs:47, zod `src/shared/api/schema.zod.ts:71`), so once `Auto` resolves to CPU on ARM, all existing CPU logic (intra-op threads, CPU_ORDER, mem-pattern) applies unchanged.

**Native deps audit (Cargo.lock)**: no `bindgen` in tree. Windows-relevant natives: `aws-lc-sys 0.41` (cmake/cc — compiled today for rustls), `ring 0.17.14`, `bzip2-sys`, `libsqlite3-sys` (bundled), `onig_sys 69.9` (cc, pre-generated bindings), `ort-sys`, `webview2-com-sys`, `vswhom-sys`. Pure-Rust: cpal 0.17/wasapi 0.23/enigo/rodio/rubato/rustfft/symphonia/sentencepiece-rs/hf-xet. `vad-rs` resolves to the same single `ort 2.0.0-rc.12`. The TTS espeak runtime **already has an ARM64 branch**: `src-tauri/src/winstt/tts/phonemize/runtime.rs:36` downloads `espeakng_loader-0.2.4-py3-none-win_arm64.whl` under `#[cfg(all(windows, target_arch = "aarch64"))]`. Ollama is detect-and-spawn of the user's installed `ollama.exe` + HTTP (`ollama_proc.rs`, `ollama_client.rs`) — no bundled binary; native ARM64 Ollama exists upstream. The `winstt_context` sidecar is a plain cargo bin using UIA via windows-rs — cross-compiles fine; it's built and staged by `tauri-build.ps1:102`.

**CI/release**: `rust-ci.yml` gates releases — `release.yml` triggers on `workflow_run` of "Rust CI" and additionally requires a green `ci.yml` run for the head SHA (release.yml:97–109). Windows release artifacts: `tools/windows/tauri-build.ps1` (vcvars**64** only, requires lld-link at `C:\Program Files\LLVM\bin`, stages DirectML.dll + x64 CRT) → `tools/windows/tauri-portable.ps1` (hardcodes `target\release`, emits `dist/WinSTT.exe` + `WinSTT-portable.zip`) → `tools/release/upload-github-assets.ps1` builds `latest.json` with platform keys `windows-x86_64`, `linux-x86_64`, `darwin-aarch64`, `darwin-x86_64` (lines 67–90) and picks the Windows sig as *first* `*.exe.sig` (line 216). `.cargo/config.toml` (repo root) sets `lld-link` **only** for `[target.x86_64-pc-windows-msvc]` — aarch64 is unaffected. The custom NSIS template `src-tauri/nsis/installer.nsi` already handles `${ARCH} == "arm64"` (lines 119–121, 571–573; it's the upstream tauri-v2.9.1 template). Docs download links live in `docs/src/lib/site.ts` + `docs/src/lib/downloads.ts`; README badges are generated by `tools/release/sync-readme-download-badges.mjs` and `--check`ed by the release gate.

---

## 1. Decision: DML on ARM64 in Phase 1 — **compiled in, never selected; CPU-only routing by default**

- Keep `Cargo.toml` untouched: the pyke aarch64 binary has DML compiled in regardless, and stripping the `directml` feature per-arch would break the `#[cfg(windows)]` `ort::ep::DirectML` code path for no size win.
- Route **around** DML at runtime: on `aarch64` Windows, `Auto` resolves to CPU everywhere, the accelerator option list omits `directml`, and `enumerate_gpus()` returns empty — the app behaves exactly like a clean CPU-only x64 box (which the renderer fully supports; `gpus: []` is the designed "no DML" signal).
- Justification: Snapdragon X's Adreno DML stack is immature (correctness and perf regressions vs CPU are widely reported; the repo's own DML policy is measurement-driven per `override_dml_to_cpu_for_kind`, and there are zero ARM measurements). Also DXGI on Snapdragon reports the Adreno iGPU with near-zero `DedicatedVideoMemory` (UMA), which would poison the VRAM-budget fit logic. No "DML behind a setting" in Phase 1 — the STT device setting has no `directml` value to expose anyway (`auto|cpu` only), so a hidden toggle would be new surface with no way to test it. Leaving the EP compiled keeps the door open for a later phase (flip one predicate after real-device benchmarks).
- Ship `DirectML.dll` if the pyke arm64 archive provides it (expected; verify in CI wave 1), but tolerate its absence on ARM since it's delay-loaded and unreachable.

## 2. Exact changes

### 2a. Rust backend — one predicate, five call sites, tests

Add to `src-tauri/src/winstt/stt/device.rs`:

```rust
/// DirectML is only enabled on x64 Windows in this phase. ARM64 Windows ships
/// CPU-only (Adreno DML unvalidated); NPU/QNN is a later phase.
pub fn dml_enabled() -> bool {
    cfg!(all(windows, target_arch = "x86_64"))
}
```

1. `device.rs:86`: `DeviceType::Auto if cfg!(windows)` → `DeviceType::Auto if dml_enabled()`.
2. `device.rs:158 execution_providers`: inside the existing `#[cfg(windows)]` DirectML arm, add `if dml_enabled() { out.push(...) }` (belt-and-suspenders for any stale persisted state).
3. `tts/provider.rs:191 providers_for_tts_device`: both the `TtsDevice::DirectMl` and `TtsDevice::Auto if cfg!(windows)` arms → `if dml_enabled()`; explicit `DirectMl` on ARM degrades to `vec![Cpu]`.
4. `managers/transcription/accel.rs:60`: replace `#[cfg(windows)]` with `#[cfg(all(windows, target_arch = "x86_64"))]` on the `directml` option (or call `dml_enabled()` at runtime — pick one style and mirror it).
5. `commands/runtime.rs:355 enumerate_gpus`: change the outer gate from `#[cfg(windows)]` to `#[cfg(all(windows, target_arch = "x86_64"))]` so ARM returns `Vec::new()` — this single change makes every renderer GPU badge, device picker, fit assessor, and download-dialog path behave CPU-only (their tests already cover `gpus: []`). `detected_max_vram_bytes()` then returns 0 (permissive, and moot since routing is CPU).

Test updates (same files):
- `quant_resolve.rs:650` `auto_device_resolves_to_directml_on_windows`: gate `#[cfg(all(windows, target_arch = "x86_64"))]`; add `#[cfg(all(windows, target_arch = "aarch64"))] fn auto_device_resolves_to_cpu_on_windows_arm64()` asserting `Accelerator::Cpu`. Also fix the companion `#[cfg(all(not(windows), ...))]` test at line 659 — its cfg must now be "not x64-windows and no gpu feature" or simply add the aarch64 case separately and leave it.
- `tts/provider.rs:205` `tts_auto_maps_to_platform_provider`: branch on `dml_enabled()` instead of `cfg!(windows)`; `tts_directml_keeps_cpu_fallback` similarly (on ARM expect `[Cpu]`).

**Not changing in Phase 1:** `CPU_ORDER` in `fit_aware_auto_quant`. The parent question of "int8-first on ARM (KleidiAI kernels)" is a *measured-policy* change in a repo whose quant ordering is justified by benchmarks; there are no ARM numbers. Phase 1 keeps accuracy-first fp32→int8 (int8 is already reached on tight-RAM devices). Follow-up item: run `stt_decode_bench` fp32-vs-int8 on a Snapdragon device and, if int8 wins decisively, introduce `const CPU_ORDER_ARM64` gated on `cfg!(target_arch = "aarch64")` with a pinned test.

### 2b. Cargo / linker config — no changes required

- `src-tauri/Cargo.toml`: unchanged (the `cfg(windows)` ort/directml block covers aarch64 and must keep doing so).
- `.cargo/config.toml`: unchanged — the lld-link override is scoped to `x86_64-pc-windows-msvc`; the ARM leg links with MSVC `link.exe`. Do **not** add an aarch64 lld entry until the runner's LLVM is confirmed.
- `Cargo.lock`: unchanged (aarch64-windows deps are already resolved into it — `windows-rs`, etc. are target-independent entries).

### 2c. Build scripts (`tools/windows/`)

`tauri-build.ps1` — make arch-aware (native host build; no `--target` plumbing needed because the ARM leg builds *on* an ARM runner):
- `Find-VcVars64` → `Find-VcVars`: when `$env:PROCESSOR_ARCHITECTURE -eq "ARM64"`, probe `VC\Auxiliary\Build\vcvarsarm64.bat` (and vswhere `-requires Microsoft.VisualStudio.Component.VC.Tools.ARM64`); else the existing vcvars64 list.
- `Import-Llvm`: required only on x64 (it exists to honor the x64 lld-link cargo config). On ARM64 skip silently if `lld-link.exe` is absent.
- CRT staging (lines 140–150): pick `Join-Path $env:VCToolsRedistDir "arm64"` on ARM (the `Microsoft.VC*.CRT` dir under it has arm64 `msvcp140.dll` etc.).
- `DirectML.dll` staging (lines 125–134): on ARM64, if `target\release\DirectML.dll` is missing, log a warning and continue (CPU-only build doesn't need it; delay-loaded); keep the hard `throw` on x64.
- The `winstt_context` sidecar build/staging (lines 102–110) works unchanged (native host build → `target\release\winstt_context.exe` is arm64).

`tauri-portable.ps1` — add `[string] $ArtifactSuffix = ""` used to name outputs: `dist/WinSTT$ArtifactSuffix.exe`, `dist/WinSTT-portable$ArtifactSuffix.zip`, portable dir `dist/WinSTT-portable$ArtifactSuffix`. x64 callers pass nothing (names unchanged, updater URL compatibility preserved); the ARM job passes `-ArtifactSuffix "-arm64"`.

### 2d. tauri.conf.json / NSIS — no structural change

- `bundle.targets` already contains `"nsis"`; the bundler emits `WinSTT_<version>_arm64-setup.exe` automatically when the build is aarch64. The custom `nsis/installer.nsi` already branches on `${ARCH} == "arm64"`. `tauri.windows.conf.json` resource maps are arch-agnostic.
- `createUpdaterArtifacts` stays as-is (note: the release pipeline currently builds Windows with `tools/tauri-ci-artifacts.conf.json` which sets it `false` — that looks inconsistent with the `*.sig` upload path and the latest.json warning branch in `upload-github-assets.ps1`; the ARM leg should mirror whatever x64 does; this pre-existing oddity deserves its own follow-up, not a Phase-1 change).

### 2e. CI — `rust-ci.yml`

Add a job (native ARM runner; GitHub-hosted `windows-11-arm` is available free for public repos — this repo is public):

```yaml
  rust-windows-arm64:
    name: Rust ARM64 (check / clippy / test)
    runs-on: windows-11-arm
    continue-on-error: true   # wave 1: observe; promote to hard gate once green
    steps:
      - checkout (pinned sha, same as others)
      - dtolnay/rust-toolchain@stable (components: clippy, rustfmt)
      - swatinem/rust-cache@v2  (workspaces: "src-tauri -> target", key: ci-windows-arm64)
      - Reset stale native build cache (same pwsh step, ort-sys globs)
      - Clippy:  cd src-tauri && cargo clippy --all-targets --locked -- -D warnings
      - Test:    same PATH prepend of $PWD\target\debug, cargo test --locked
```

Rationale for **native runner over cross-compile**: tests actually execute on aarch64 (the only ARM verification the project can get without hardware); ort-sys downloads the correct aarch64 dist automatically; no vcvars cross-toolchain or `--target` path divergence in scripts. Cross-compile from x64 would only prove linkage.

Notes / knobs:
- Skip `fmt` (already covered on x64) and skip Bun in this job (the pure cargo steps don't need it).
- Optionally add an ARM leg to the "Windows artifacts (optional)" job (`continue-on-error: true`) running `tools\windows\tauri-build.ps1 -Bundles nsis -Config tools\tauri-ci-artifacts.conf.json` + `tauri-portable.ps1 -SkipBuild -ArtifactSuffix "-arm64"`, uploading `winstt-windows-arm64`. This job **does** need Bun (renderer build). Bun has no native win-arm64 build — `oven-sh/setup-bun` may fail to resolve an asset on that runner; first attempt setup-bun as-is, fallback: install x64 Bun explicitly (`irm bun.sh/install.ps1`) under Windows-on-ARM x64 emulation, or build the renderer `dist/` in an x64 job and hand it over as an artifact (then bypass `beforeBuildCommand`). Treat this as the top CI-mechanics risk.
- Because `release.yml` keys off the **whole "Rust CI" workflow conclusion**, `continue-on-error: true` keeps ARM from blocking releases during the stabilization waves; removing it later makes ARM a release gate.

### 2f. Release — `release.yml` + `upload-github-assets.ps1`

- New job `windows-arm64` cloned from `windows` (needs `metadata`, `runs-on: windows-11-arm`, cache key `release-windows-arm64`, same signing env), building via the same scripts with `-ArtifactSuffix "-arm64"`, uploading artifact `winstt-windows-arm64` with paths `dist/WinSTT-arm64.exe`, `dist/WinSTT-portable-arm64.zip`, `src-tauri/target/release/bundle/nsis/*arm64*.sig`. Add it to `publish.needs`. During rollout, consider making publish tolerate a failed ARM job (`if: always()` + explicit checks) *or* accept that ARM failures block the release — recommend the latter only after the CI leg has been green for several releases.
- `upload-github-assets.ps1`:
  - Fix the Windows sig disambiguation: x64 sig = first `*.exe.sig` whose name does **not** match `arm64|aarch64`; ARM sig = first that does.
  - Collect optional `WinSTT-arm64.exe` / `WinSTT-portable-arm64.zip` (warn-if-missing during rollout, then required).
  - `New-UpdaterManifest`: add a `windows-aarch64` platform entry (tauri-plugin-updater's target key on Windows/aarch64) pointing at `WinSTT-arm64.exe` with its sig, added only when both exist — mirroring the darwin-x86_64 optional pattern. The single `latest.json` endpoint in `tauri.conf.json` (`plugins.updater.endpoints`) needs no change; per-arch resolution is by platform key.

### 2g. Docs / download surfaces

- `docs/src/lib/site.ts`: add `latestWindowsArm64InstallerUrl = releaseAssetUrl("WinSTT-arm64.exe")` and `latestWindowsArm64PortableZipUrl = releaseAssetUrl("WinSTT-portable-arm64.zip")`.
- `docs/src/lib/downloads.ts`: two new entries in `releaseDownloadOptions.windows` labeled e.g. "Installer (Windows on ARM)" / "Portable (Windows on ARM)" — browsers can't reliably distinguish arm64 Windows in UA, so keep x64 as the default-ordered options and list ARM beneath.
- `docs/content/docs/install.mdx`: add a "Windows ARM64 (Snapdragon)" row (~line 66–68 table) noting native CPU inference, no DirectML in this phase.
- `tools/release/sync-readme-download-badges.mjs` + regenerate README block: add the ARM installer link (secondary link/badge, keep the primary Windows badge = x64). This is release-gated by `--check`, so it must land in the same release that first publishes the ARM asset naming.

## 3. Step ordering (wave workflow)

The repo's established pattern for platforms the developer can't run locally (the macOS/Linux port) is CI-driven waves: push a compile wave, read the runner logs, fix, then clippy, then tests, then artifacts. Apply it here:

1. **Wave 1 — CI skeleton + compile**: add `rust-windows-arm64` (continue-on-error) with only `cargo check --all-targets --locked`. This proves: rustup host toolchain on the runner, ort-sys aarch64 dist download, aws-lc-sys/ring/onig_sys/bzip2/sqlite compilation, tauri/webview2-com linkage. Fix fallout.
2. **Wave 2 — routing change + clippy + tests**: land the `dml_enabled()` backend changes and test updates (these also compile/test on x64, so normal CI covers regression), switch the ARM job to clippy + `cargo test --locked`.
3. **Wave 3 — bundle**: script changes (2c), optional ARM artifacts job; confirm NSIS produces `*_arm64-setup.exe`, confirm whether pyke's aarch64 archive ships `DirectML.dll` (adjust the staging warning accordingly), inspect the uploaded artifact's contents (sidecar, CRT arm64 DLLs, resources).
4. **Wave 4 — optional CPU decode smoke on ARM**: a CI step that snapshots `whisper-tiny.en` from HF and runs `cargo run --release --example stt_decode_bench` (expects the JFK f32 clip at `tools/bench/audio/jfk_short_3s.f32`, already in-repo) asserting the expected transcript — the strongest "inference actually works on aarch64" proof CI can give. Also optionally dlopen the espeakng win_arm64 wheel's DLL.
5. **Wave 5 — release plumbing**: release.yml job, upload-github-assets.ps1, docs site, install.mdx, README badges; dry-run via `workflow_dispatch` draft release; verify `latest.json` contains `windows-aarch64`.
6. **Wave 6 — promotion**: drop `continue-on-error` on the ARM test job; announce ARM build as experimental pending device reports.

## 4. Test list (what runs where)

| Test | Where |
|---|---|
| Existing full `cargo test` suite incl. new `auto_device_resolves_to_cpu_on_windows_arm64`, TTS provider ARM assertions | `windows-11-arm` runner, natively |
| x64 regression of routing changes (`auto...directml` test now arch-gated) | existing `windows-latest` job |
| Renderer suite (`bun run test`) — unchanged; CPU-only behavior already covered by `gpus: []` fixtures (`model-options.test.ts:386`, fit-assessor tests) | `ci.yml` ubuntu |
| Clippy `-D warnings` on aarch64 (catches arch-gated dead code) | ARM job |
| NSIS arm64 bundle builds; portable zip contents (exe arch via `dumpbin /headers` or PE probe step) | ARM artifacts job |
| whisper-tiny CPU decode smoke (`stt_decode_bench`) | ARM job, wave 4 |
| latest.json schema (has `windows-aarch64`, valid sigs) | release dry-run + a small unit in the upload script's `-DryRun` path |

## 5. Cannot-verify-locally (requires a physical Snapdragon X device)

For each: what CI proves vs. what it cannot.

1. **Microphone capture (cpal/WASAPI) & loopback listen-mode (wasapi crate)** — CI: compiles, unit tests of resampler/VAD logic pass. Cannot: real device enumeration, sample-rate negotiation, loopback capture on ARM audio drivers.
2. **Global hotkeys, tray, enigo paste pipeline, clipboard snapshot/restore** — CI: compiles + non-interactive unit tests. Cannot: interactive behavior on ARM shell.
3. **WebView2 rendering/perf** — Evergreen runtime is ARM64-native; CI cannot exercise the packaged app UI.
4. **UIA context sidecar behavior** against real ARM apps — CI: sidecar builds, protocol unit tests pass. Cannot: live UIA tree reads.
5. **Inference performance / thermals** (fp32 vs int8 on Oryon cores; the KleidiAI int8 question; `pick_intra_op_threads` fit) — CI: decode correctness only, on Cobalt/Azure ARM silicon, not Snapdragon. Performance-tuning decisions stay open.
6. **Installer UX on device** (NSIS under x86-emulation installing an arm64 app, WebView2 bootstrap path, portable mode on ARM) — CI proves the installer builds and its payload arch; not the install experience.
7. **Updater end-to-end** (ARM install updating via `windows-aarch64` key) — CI can validate manifest shape only.
8. **espeakng win_arm64 wheel runtime** (TTS phonemizer dlopen) — the ARM runner can dlopen it (optional wave-4 test); audio output cannot be verified.

Recommendation: label the first ARM release "experimental — native ARM64" in release notes and solicit device feedback.

## 6. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| `aws-lc-sys 0.41` fails to build on aarch64-msvc (cmake/clang expectations) | Medium | Wave 1 exposes it. Fallbacks: bump aws-lc-sys; or force rustls's `ring` provider on the ARM target (ring 0.17.14 supports aarch64-pc-windows-msvc). |
| Bun unavailable natively on windows-arm64 → renderer build fails in bundle jobs | Medium | x64 Bun under Windows-on-ARM emulation; or build `dist/` on x64 job and pass as artifact (strip `beforeBuildCommand` via a `--config` overlay like `tools/tauri-ci-artifacts.conf.json`). |
| pyke aarch64 archive lacks `DirectML.dll` → `tauri-build.ps1` staging throw | Low–Medium | Planned change: warn-and-skip on ARM (delay-loaded, unreachable under CPU routing). |
| pyke CDN aarch64 binary availability regression on future ort bumps | Low | ort is pinned `=2.0.0-rc.12`. Fallbacks: `ort/load-dynamic` on ARM with Microsoft's official win-arm64 `onnxruntime.dll`, or compile-from-source (`ORT_LIB_LOCATION`). Do not pre-build this. |
| NSIS (x86 makensis) under emulation flaky on the ARM runner | Low | Known-working pattern; else run bundling on an x64 runner against cross-staged binaries (last resort — requires `--target` plumbing). |
| `onig_sys` / `bzip2-sys` / `esaxx-rs` C compilation quirks under MSVC arm64 | Low | cc-rs handles arm64 MSVC; wave 1 catches it. |
| Stale persisted settings on ARM (`device:auto` copied from x64) | Low | Guarded: `execution_providers` also checks `dml_enabled()`; `Auto` resolves CPU. |
| Adreno DXGI adapter with ~0 dedicated VRAM would have poisoned fit logic | Closed | `enumerate_gpus()` returns empty on ARM (Phase-1 semantics = "DML-capable GPU list"). |
| Release gate breaks for x64 while ARM stabilizes | Low | ARM jobs `continue-on-error` until wave 6; publish additions warn-if-missing initially. |

## Critical Files for Implementation
- `src-tauri/src/winstt/stt/device.rs` (resolve_accelerator / execution_providers / new `dml_enabled()`)
- `src-tauri/src/winstt/commands/runtime.rs` (enumerate_gpus / detected_max_vram_bytes)
- `tools/windows/tauri-build.ps1` (vcvars/CRT/DirectML staging arch-awareness; with tauri-portable.ps1 suffix param)
- `.github/workflows/rust-ci.yml` (new windows-11-arm job; with release.yml windows-arm64 job)
- `tools/release/upload-github-assets.ps1` (ARM assets + `windows-aarch64` latest.json entry)

Also touched: `src-tauri/src/winstt/tts/provider.rs`, `src-tauri/src/managers/transcription/accel.rs`, `src-tauri/src/winstt/stt/quant_resolve.rs` (tests), `docs/src/lib/site.ts`, `docs/src/lib/downloads.ts`, `docs/content/docs/install.mdx`, `tools/release/sync-readme-download-badges.mjs`.
