# Cross-Platform STT Support - Implementation Plan

Status: revised on 2026-06-03 from the current WinSTT tree and
`examples/handy`.

This replaces the older survey-style handoff with an implementation plan. The
goal is to make the Rust/Tauri WinSTT STT path work on Windows, macOS, and
Linux without giving up the optimized Rust ONNX engine. Handy remains the
reference for a proven multi-OS packaging path, but WinSTT should keep its own
ONNX decoders as the primary engine.

## Goal

Ship WinSTT STT on:

- Windows: DirectML where it is already validated, CPU fallback.
- macOS: CPU first, then CoreML where it is actually validated.
- Linux: CPU first, then CUDA/ROCm where feature-built and validated.

Do not make the cross-platform work depend on whisper.cpp unless measurement
shows that ORT Whisper GPU is not good enough on macOS/Linux. Handy's
whisper.cpp route is a useful fallback pattern, not the primary WinSTT design.

## Verified Current Facts

### Handy reference

`examples/handy` is genuinely multi-OS:

- `examples/handy/src-tauri/Cargo.toml` uses base
  `transcribe-rs = { features = ["whisper-cpp", "onnx"] }`.
- Windows adds `whisper-vulkan` and `ort-directml`.
- macOS adds `whisper-metal`.
- Linux adds `whisper-vulkan`.
- `examples/handy/src-tauri/src/managers/transcription.rs` routes
  `EngineType::Whisper` to `transcribe_rs::whisper_cpp::WhisperEngine`.
- The other STT families route to transcribe-rs ONNX model loaders.
- Handy exposes two accelerator settings:
  `WhisperAcceleratorSetting` for whisper.cpp and `OrtAcceleratorSetting` for
  the ONNX families.

Important correction: Handy's cross-platform GPU story is strongest for
Whisper because whisper.cpp has Metal/Vulkan backends. Handy's non-Whisper ONNX
families are cross-platform, but their non-Windows GPU coverage is not the same
thing as WinSTT's desired native ORT EP matrix.

### WinSTT current path

The WinSTT app is not just the Handy path:

- The primary catalog engine lives under `src-tauri/src/winstt/stt/`.
- `src-tauri/src/winstt/stt/mod.rs` has
  `Accelerator::{Cpu, Cuda, DirectMl, CoreMl, Rocm, OpenVino}`.
- `execution_providers()` currently registers DirectML only behind
  `cfg(windows)` and CUDA only behind the `cuda` feature. CoreML, ROCm, and
  OpenVINO are labels/enums only in this helper today.
- `src-tauri/src/winstt/stt/families.rs::register_providers` still treats
  CoreML/ROCm/OpenVINO as CPU fallback and uses deprecated
  `*ExecutionProvider` aliases. This should be unified with the modern
  `ort::ep::*` helper.
- `src-tauri/src/winstt/stt/backend.rs::resolve_catalog` maps
  `model.device = auto` to DirectML on Windows and CPU everywhere else.
- `src-tauri/src/winstt/commands/stt.rs::picker_accelerator` uses the same
  Windows-only DirectML mapping for the picker.
- `src-tauri/src/winstt/settings_schema.rs` exposes only
  `DeviceType::{Auto, Cpu}` for `model.device`.
- `src/shared/api/schema.zod.ts` also has `DeviceTypeSchema = ["auto", "cpu"]`.
- `src-tauri/Cargo.toml` has direct `ort` features `["ndarray", "half"]` and a
  package feature `cuda = ["ort/cuda"]`. DirectML is available on Windows via
  the target-specific `transcribe-rs` `ort-directml` feature, which unifies the
  `ort/directml` feature into the build.
- `transcribe-rs` whisper.cpp dependencies are still present: base
  `whisper-cpp`, macOS `whisper-metal`, Linux `whisper-vulkan`. They are not
  the primary WinSTT catalog route.
- `src-tauri/src/managers/transcription.rs::apply_accelerator_settings` still
  applies Handy/transcribe-rs accelerator globals for the fallback route.
- `src-tauri/src/winstt/commands/runtime.rs` can label CoreML/ROCm/OpenVINO,
  but the current resolver never returns those accelerators.
- GPU enumeration and VRAM sizing are Windows/DXGI-only today. Non-Windows
  returns no GPUs and `detected_max_vram_bytes()` returns `0`.
- Wake-word device resolution currently maps `model.device = auto` to DirectML
  without a platform guard in
  `src-tauri/src/winstt/managers/wakeword_manager.rs`. That must be fixed before
  claiming non-Windows CPU support.

### Optimization boundary

Most WinSTT optimizations are portable because they live above the execution
provider:

- Rust featurizers and mel/fbank extraction.
- TDT duration frame skipping.
- Custom family decoders.
- `TensorRef`/typed tensor I/O.
- Physical-core thread selection.
- The catalog quantization and forced-CPU policy structure.

Do not overstate IoBinding portability. The Whisper IoBinding path currently
maps device allocations only for DirectML and CUDA in
`src-tauri/src/winstt/stt/whisper.rs::device_for_providers`; CoreML/ROCm/OpenVINO
fall back to CPU allocation today. Extending that is a separate implementation
task and may not be available for every ORT EP.

## Plan Of Action

### Phase 0 - CPU builds on macOS/Linux

Objective: make the existing WinSTT ONNX engine compile and run on macOS and
Linux with CPU EP only.

Actions:

1. Centralize accelerator resolution.
   - Create one backend helper for `model.device -> Accelerator`.
   - Replace duplicated mappings in `winstt/stt/backend.rs`,
     `winstt/commands/stt.rs`, runtime chip code, TTS/wakeword device helpers
     where applicable.
   - Initial policy: Windows `auto -> DirectMl`; macOS/Linux `auto -> Cpu`.

2. Fix non-Windows DirectML leaks.
   - Change wake-word `auto` to CPU on non-Windows.
   - Audit TTS/wakeword/STT runtime labels so non-Windows CPU builds do not
     report DirectML or GPU when the active route is CPU.
   - Keep Windows-only WASAPI, DXGI, DPAPI, foreground-window, ducking, loopback,
     and preview code behind `cfg(windows)`.

3. Make provider helpers deterministic.
   - Ensure all STT session builders can accept `[Cpu]` on macOS/Linux without
     touching DirectML code paths.
   - CPU fallback must be appended once, not duplicated through multiple helper
     layers.
   - Prefer one provider-registration helper shared by Whisper, Moonshine, and
     family engines.

4. Verify model resolution and cache paths.
   - Confirm HF cache/model paths do not assume Windows separators.
   - Confirm downloaded ONNX model directories are opened by path APIs, not
     hardcoded strings.

Acceptance criteria:

- `cargo check` passes on Windows for the current default build.
- macOS and Linux builds pass on their native OS runners or machines.
- On macOS/Linux, the app launches, downloads or reuses one catalog model, and
  transcribes a short clip on CPU.
- Runtime info reports CPU on macOS/Linux CPU builds.
- Whisper/lite-whisper and at least one non-Whisper family run on CPU.

### Phase 1 - Native ORT EP wiring

Objective: make the non-Windows GPU EPs real build features and route `auto` to
them only when compiled and validated.

Actions:

1. Add explicit Cargo feature aliases.
   - Keep `cuda = ["ort/cuda"]`.
   - Add `coreml = ["ort/coreml"]`.
   - Add `rocm = ["ort/rocm"]`.
   - Add `openvino = ["ort/openvino"]` only if we decide to ship/test it.
   - Add `webgpu = ["ort/webgpu"]` only as experimental.
   - If a fallback transcribe-rs ONNX route needs the same EP, also enable the
     matching transcribe-rs feature (`ort-coreml`, `ort-rocm`, etc.).

2. Register modern ORT EPs.
   - Use `ort::ep::{CPU, CUDA, DirectML, CoreML, ROCm, OpenVINO}` instead of the
     deprecated `*ExecutionProvider` aliases.
   - Guard registrations with both platform and feature cfgs:
     - DirectML: Windows.
     - CoreML: macOS + `coreml` feature.
     - CUDA: `cuda` feature.
     - ROCm: `rocm` feature.
     - OpenVINO: `openvino` feature.
   - Log a clear fallback when a requested provider is not compiled in.

3. Update `auto` policy.
   - Windows default build: DirectML.
   - macOS `--features coreml`: CoreML.
   - Linux `--features cuda`: CUDA.
   - Linux `--features rocm`: ROCm.
   - No GPU feature or provider init failure: CPU.
   - Do not add a broad public device enum until the backend can expose compiled
     and available EPs accurately; `auto|cpu` is enough for the first pass.

4. Update session hygiene per EP.
   - Keep the DirectML memory-pattern fix.
   - Measure whether disabling memory patterns for all non-CPU EPs is still the
     right choice; do not assume the DirectML rule applies to CoreML/CUDA/ROCm.
   - Add CoreML model cache dir if CoreML session creation is slow.

5. Handle Whisper device-resident state carefully.
   - Extend `device_for_providers()` only for EPs with a correct ORT
     `AllocationDevice` mapping.
   - If CoreML/OpenVINO cannot use the same IoBinding path, explicitly route that
     part to host tensors and document the expected performance.
   - Confirm ROCm allocation support before advertising ROCm Whisper GPU.

Acceptance criteria:

- macOS `--features coreml` creates sessions with CoreML when the model/shape is
  supported, otherwise falls back to CPU without crashing.
- Linux `--features cuda` creates CUDA sessions on NVIDIA machines, otherwise
  falls back to CPU without crashing.
- Linux `--features rocm` creates ROCm sessions on AMD machines, otherwise falls
  back to CPU without crashing.
- Runtime info reports the actual active provider list, not just the persisted
  setting.

### Phase 2 - Per-EP compatibility and performance policy

Objective: stop applying the DirectML benchmark matrix to every non-CUDA EP by
default.

Actions:

1. Refactor DML-specific policy names.
   - Replace or wrap `is_dml_incompatible`, `dml_slower_than_cpu`, and
     `override_dml_to_cpu_for_kind` with a policy keyed by `Accelerator`.
   - Keep the DirectML matrix as the Windows policy.
   - Start CoreML/ROCm/OpenVINO conservatively: CPU-route unmeasured families or
     mark them "unknown" until benchmarked.

2. Benchmark every family/quant/provider pair.
   - Matrix dimensions: engine kind, quantization, provider, model size, cold
     load, warm decode, correctness, crash/fallback reason.
   - Record results in `.deep-research/STT_BENCH_MATRIX.md` or a new adjacent
     matrix file.

3. Feed the matrix back into runtime.
   - A model should either run on the requested EP, route to CPU with a log
     reason, or be hidden/disabled for that EP.
   - The picker quant list must reflect provider-specific bad choices. CUDA
     already filters sub-fp16 quantizations; CoreML/ROCm need their own measured
     rules.

4. Fix RAM/VRAM fit logic.
   - Windows can keep DXGI.
   - macOS should treat unified memory as a shared RAM budget unless a better API
     is added.
   - Linux CUDA/ROCm should add GPU memory detection or avoid making hard fit
     claims.
   - `fit_aware_auto_quant()` currently treats GPU budget as DirectML/CUDA only;
     update it when CoreML/ROCm become real GPU paths.

Acceptance criteria:

- No new EP inherits the DirectML crash/slowness matrix without an explicit
  comment and test.
- Every supported EP/family/quant path has one of: validated GPU, measured CPU
  fallback, or intentionally unsupported.
- Logs explain provider routing decisions.

### Phase 3 - Handy-style Whisper fallback, only if needed

Objective: use Handy's proven whisper.cpp path only as a pragmatic macOS/Linux
Whisper GPU fallback.

Actions:

1. Measure ORT Whisper first.
   - Test WinSTT Whisper ONNX on CPU, CoreML, CUDA, and ROCm where available.
   - Compare with Handy whisper.cpp Metal/Vulkan on the same audio and model
     class.

2. If ORT Whisper is weak on macOS/Linux, add a fallback route.
   - Reuse the existing transcribe-rs whisper.cpp dependencies:
     `whisper-metal` on macOS and `whisper-vulkan` on Linux.
   - Use `examples/handy/src-tauri/src/managers/transcription.rs` as the
     reference for loading `WhisperEngine`.
   - Keep the fallback limited to Whisper models that have GGML assets.

3. Keep the tradeoff explicit.
   - This path cannot run lite-whisper ONNX variants.
   - It introduces a second model format/cache.
   - It should not replace WinSTT's ONNX engine for the other families.

Acceptance criteria:

- The fallback is selected only on platforms/models where it is faster or more
  reliable than ORT.
- User-facing model availability does not imply that GGML can run an ONNX-only
  model.

### Phase 4 - CI and release packaging

Objective: prevent regressions after cross-platform support lands.

Actions:

1. Add build matrix jobs.
   - Windows default.
   - Windows `--features cuda` if we keep CUDA as an opt-in check.
   - macOS CPU.
   - macOS `--features coreml`.
   - Linux CPU.
   - Linux `--features cuda` and/or `--features rocm` on appropriate runners or
     manual release machines.

2. Add pure resolver tests.
   - `model.device` resolution per OS/feature.
   - Provider list construction.
   - Runtime label/provider list output.
   - Forced-CPU policy per EP.

3. Add smoke tests.
   - Use a tiny known clip such as the JFK sample.
   - Assert non-empty transcript and rough expected text.
   - Run at least Whisper/lite-whisper plus one CTC/transducer family on CPU.
   - Run one GPU smoke per available OS/hardware.

4. Document release flavors.
   - Default builds should not bundle CUDA runtime payloads.
   - CUDA/ROCm builds should be opt-in and clearly labeled.
   - macOS CoreML should be the default macOS GPU candidate only after the matrix
     proves it is reliable.

## Suggested Execution Order

1. Phase 0: CPU builds and non-Windows DirectML cleanup.
2. Phase 1: provider feature wiring and actual runtime provider reporting.
3. Phase 2: provider-specific matrix and policy.
4. Phase 3: whisper.cpp fallback only if ORT Whisper loses on macOS/Linux.
5. Phase 4: CI/release hardening.

The first shippable milestone is Phase 0: CPU-only macOS/Linux using the WinSTT
ONNX engine. That gives cross-platform support without waiting for GPU matrix
work.
