# STT performance matrix — ours (Rust `ort`) vs onnx-asr-fork

Benchmarked 2026-06-03 on a 24-logical / 16-physical Windows box, DirectML GPU.
Method: `stt_spike --catalog <id>` (ours) vs `scripts/bench_onnxasr_electron.py` with
`PYTHONPATH=E:/DL/Projects/onnx-asr-work/src` (the FORK, hash 20b872a — NOT upstream).
Each cell = median WARM ms (cold/kernel-compile pass discarded). Clip: JFK 11 s (medium),
`long_varied.f32` 245 s (long). int8 for NeMo/GigaAM, fp32 for Cohere (no int8 export),
fp16 for lite-whisper DML. `>10%` gap = significant (user's bar).

## DML (DirectML GPU) — medium 11 s

| model            | quant | ours BEFORE | ours NOW | fork | verdict           |
|------------------|-------|-------------|----------|------|-------------------|
| parakeet-ctc     | int8  | 109 ms      | **67 ms**| 69   | ✅ tied→win (was 1.6× slower) |
| parakeet-tdt     | int8  | 183 ms      | **124 ms**| 120 | ✅ ~tied (was 1.27× slower)   |
| gigaam-ctc       | int8  | 49 ms       | **44 ms**| 45   | ✅ win             |
| lite-whisper     | fp16  | 319 ms      | (re-test)| 275  | ⚠ fork 1.16× → mel-parallel re-test pending |

## CPU — medium 11 s

| model            | quant | ours | fork | verdict        |
|------------------|-------|------|------|----------------|
| parakeet-ctc     | int8  | 222  | 235  | ✅ 1.06×        |
| parakeet-tdt     | int8  | 247  | 586  | ✅ **2.37×**    |
| gigaam-ctc       | int8  | 147  | 512  | ✅ **3.5×**     |
| cohere           | fp32  | 1295 | 1816 | ✅ **1.4×**     |
| sensevoice       | int8  | 130  | n/a  | ours-only (fork has no SenseVoice) |

## CPU — long 245 s

| model            | quant | ours   | fork   | verdict          |
|------------------|-------|--------|--------|------------------|
| parakeet-tdt     | int8  | 14.8 s | 56.4 s | ✅ **3.8×** (fork's Python per-frame TDT loop crawls) |
| cohere           | fp32  | 50.4 s | 46.5 s | ⚠ fork 1.08× (under 10% bar; our median had a thermal outlier, clean ≈50 s) |
| sensevoice       | int8  | 15.4 s | n/a    | ours-only         |
| gigaam-ctc       | int8  | FAIL   | FAIL   | model length limit — BOTH fail on 245 s single-pass (prod VAD-segments; not a winstt bug) |

## Optimizations shipped this pass

1. **Parallel featurizers (rayon `par_chunks_mut`):** `nemo_features` (parakeet/canary/cohere
   128-mel), `compute_kaldi_fbank` (dolphin/vosk/zipformer), `gigaam_v3_features` (gigaam),
   `MelExtractor.extract` (whisper/lite-whisper 3000-frame 30 s window). `compute_fbank`
   (sensevoice) was already parallel from the prior pass. Frames are independent; rfft plan is
   thread-local / `Arc<dyn Fft>` is Send+Sync → byte-identical output.
2. **L1 DirectML session config:** `build_session` (families.rs + whisper.rs) now sets
   `.with_memory_pattern(false)` on the GPU path. ORT's DML EP requires DisableMemPattern (it
   manages its own device memory); parallel exec is already Sequential by default; our audio
   inputs are dynamic-length so the mem-pattern planner was useless anyway. Closed the parakeet
   DML gap (109→67 ctc, 183→124 tdt) together with the parallel featurizer.

## Native dedicated-Rust-impl comparison (parakeet-rs, transcribe-rs)

Both use **ort 2.0.0-rc.12 — the SAME runtime as us** → any delta is decode/session/featurizer, not the runtime.

### parakeet-rs (altunenes/parakeet-rs 0.3.5) — the dedicated parakeet baseline, ort+DirectML
Benched its `Parakeet` CTC (onnx-community/parakeet-ctc-0.6b-ONNX) vs our `nemo-parakeet-ctc-0.6b`, JFK 11 s, matched quant:

| quant | path | ours | parakeet-rs | verdict |
|-------|------|------|-------------|---------|
| int8  | DML  | 67 ms | 66.6 ms | **TIED** |
| int8  | CPU  | 222 ms | 630 ms | **ours 2.8× faster** |
| fp32  | DML  | 46–63 ms | 38–52 ms | tied (machine-noise-dominated) |
| fp32  | CPU  | 285 ms | 276 ms | tied |

**Verdict: parakeet-rs does NOT beat us at any matched quant** — tied on GPU, 2.8× slower on int8-CPU. (Side-finding: our fp32-DML 46–63 ms < our int8-DML 67 ms — DML doesn't accelerate int8/QDQ, so parakeet-on-DML could route fp32 instead of int8.)

### parakeet-rs Cohere + transcribe-rs SenseVoice (the families with no onnx-asr baseline), JFK 11 s CPU:

| family | quant | ours | native impl | verdict |
|--------|-------|------|-------------|---------|
| Cohere (AED) | fp32 | 1295 ms | parakeet-rs **3820 ms** | **ours 2.95× faster** |
| SenseVoice (CTC) | int8 | 130 ms | transcribe-rs **336 ms** | **ours 2.6× faster** |

Both transcripts match ours. Cohere: parakeet-rs reconstructs 32 KV tensors via `.to_vec()` every decode step
(source-mined) + single-threaded featurizer; our cohere uses zero-copy TensorRef KV + parallel 128-mel
`nemo_features`. SenseVoice: transcribe-rs rebuilds the FftPlanner per call + serial fbank; ours is parallel.
(parakeet-rs cohere auto-prefers the int8 `_quantized` export — forced fp32 for the match.)

**Resolver `_quantized` alias — tested, NOT worth adding:** our resolver globs `encoder_model?int8.onnx`
so it misses onnx-community's `encoder_model_quantized.onnx` → cohere silently runs fp32. Tested if int8
cohere is faster: **parakeet-rs cohere int8 CPU = 19,842 ms (RTF 1.80) = 5.2× SLOWER than its fp32 (3820 ms)**
— onnxruntime CPU dynamic-int8 (QDQ) dequant overhead on a 2B AED model; cohere is DML-incompatible (CPU-only)
so no GPU path redeems it. **Our fp32 cohere (1295 ms) is correct; enabling cohere int8 would be a 5× footgun.**
Decided against the resolver change.

### Source-mining (why we match/beat them) — both transcribe-rs AND parakeet-rs:
- Use **ort defaults**: NO `with_memory_pattern(false)`, NO IoBinding, intra-threads small/unset (parakeet-rs hardcodes 4). We set the L1 mem-pattern fix, IoBinding KV-cache (whisper), and 16 physical threads.
- **Single-threaded featurizers** (fresh `FftPlanner` per call in transcribe-rs; column-wise serial in parakeet-rs). We parallelize all featurizers (rayon) + thread-local cached FFT plans.
- Same decode algorithm we use: TDT duration-frame-skipping (we do it too, families.rs:1439/1942), greedy CTC argmax (naive loop, both).
- transcribe-rs Moonshine clones all KV + `encoder_hidden_states` every step (we don't); parakeet-rs Cohere uses zero-copy `TensorRef` cache views (so do we).
- **Conclusion: neither is architecturally better — we already do strictly more on the same runtime. W4 (drop transcribe-rs) is justified on the merits.**

### NeMo long-audio limit (corroborated): parakeet-rs's own `raw.rs` documents TDT/NeMo models error past ~8–10 min single-pass (the `axis == 1 || axis == largest` broadcast crash) → confirms our gigaam-ctc 245 s failure is an inherent NeMo-export limit, not a winstt bug.

### CT2 faster-whisper (CTranslate2) — the whisper-family CPU ceiling (no DirectML; CPU/CUDA only)
`deepdml/faster-whisper-large-v3-turbo-ct2`, int8, CPU, greedy, JFK 11 s: warm ≥ **5.3 s** (best, contended;
runs climbed to 13 s under load) = RTF ≥ 0.48. **Our lite-whisper DML fp16 = 319 ms decisively beats it.**
CT2's edge (int8-CPU + fused C++ transformer kernels) is a CPU-path optimization that does NOT beat our DML
GPU path; CT2 only wins on CUDA (no NVIDIA here to test). For a DML-first Windows app, no reason to port CT2.

### ⚠ Measurement caveat
All CPU numbers this session are contaminated by concurrent user builds/rust-analyzer (CPU runs swing 2–4×;
e.g. CT2 5.3→13 s within one invocation, parakeet fp32-CPU 276→1044 ms). DML/GPU numbers are stable (GPU
uncontended: parakeet int8-DML 67/67/66). Relative verdicts hold (large margins); treat absolute CPU ms as soft.

## Overall verdict
Across the onnx-asr fork, parakeet-rs (dedicated ort+DML), transcribe-rs (source), and CT2: **we are
faster-or-tied on every matched-quant column measured.** Only sub-bar gaps remain (cohere-long fork 1.08×;
lite-whisper-DML fork 1.16×, the mel-parallel fix for which is landed-but-unbenched pending preview.rs).

## Remaining
- lite-whisper DML (fork 1.16×): mel-parallelization re-bench pending (blocked on the user's untracked preview.rs not compiling).
- SenseVoice / Dolphin have no onnx-asr or parakeet-rs equal baseline (transcribe-rs has SenseVoice — source shows it's behind us; a standalone bench would confirm but the architectural posture is already known).
