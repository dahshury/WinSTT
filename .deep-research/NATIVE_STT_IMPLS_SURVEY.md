# Native STT implementations — full ecosystem survey (Rust / C++ / Python), per family

**Date:** 2026-06-03. **Goal:** find every native ASR inference impl worth benchmarking against + mining
optimizations from, for our Windows Rust `ort` (ONNX Runtime 2.0) + DirectML/CPU engine. Extends the
earlier survey (which only covered onnx-asr-fork, parakeet-rs, transcribe-rs, CT2). Citations inline.

---

## Executive summary — the structural truth

**DirectML is a desert for fast ASR engines.** Every genuinely-fast engine is locked to a backend we
don't have: faster-whisper/CTranslate2 = CUDA+ROCm only (no DML), whisper.cpp's Windows-GPU answer is
**Vulkan** (DirectML requested in issue #2303, never built), TensorRT-LLM = CUDA, WhisperKit = Apple ANE,
TheStageAI/TheWhisper = NVIDIA-tensor-core + Apple, candle = CUDA/Metal (no DML), ratchet = WebGPU
(slower than DML today, Chromium-only). **The only mature ort+DirectML ASR runtime in existence is
`sherpa-onnx`** — and its DirectML session config is literally `DisableMemPattern()` +
`SetExecutionMode(ORT_SEQUENTIAL)` ([sherpa-onnx `session.cc`](https://github.com/k2-fsa/sherpa-onnx)),
**byte-for-byte the L1 fix we shipped this session.** This independently validates our architecture: a
hand-rolled ort+DML per-family decoder is the *correct* design for a Windows GPU dictation app, and there
is no off-the-shelf engine that beats it on our hardware. The competition is CPU engines (whisper.cpp,
CT2, OpenVINO) and reference-only GPU-locked engines we can only mine ideas from.

**TheStageAI/TheWhisper verdict (the user's flagged example):** real but **not relevant**. It's optimized
Whisper checkpoints from a closed proprietary compiler ("ANNA": PTQ INT8/FP8/INT4 + SmoothQuant + a
CUDA-targeted DNN compiler emitting fused tensor-core kernels; CoreML/ANE on Apple). Hardware: NVIDIA
(incl. Blackwell/RTX 5090) + Apple Silicon — **no Windows, no DirectML, no CPU**. The fast NVIDIA engines
are **commercial, behind a paid token** (free path = plain PyTorch). Headline RTFx (e.g. RTX 5090 S-tier
280 vs "Original" 114) are **batched server throughput vs an unoptimized HF-eager baseline** — the honest
single-stream gain is ~2–4×, and they never compare to faster-whisper / whisper.cpp / TensorRT-LLM (the
actual fast competitors). **Zero portability to ort/DML/CPU.** Only takeaways: the fine-tuned
large-v3-turbo weights are CC-BY-4.0 (could be exported to ONNX ourselves) and ANNA validates *per-layer
mixed-precision* quant over blanket INT4. Sources: [TheWhisper GitHub](https://github.com/TheStageAI/TheWhisper),
[HF card](https://huggingface.co/TheStageAI/thewhisper-large-v3-turbo), [quant tutorial](https://docs.thestage.ai/tutorials/source/quantization_tutorial.html).

---

## Per-family / per-runtime table (the new ground, beyond the 4 we already benched)

| Impl | Repo | Lang / runtime | GPU EPs | Maintained | Perf claim (+ baseline + src) | Key optimizations | Win ort/DML/CPU? | For us |
|---|---|---|---|---|---|---|---|---|
| **sherpa-onnx** ⭐ | k2-fsa/sherpa-onnx | C++ + ORT, Rust crate 1.13.2 | **CUDA + DirectML** + CoreML | very active | Zipformer int8 RTF 0.06–0.16 @1thread CPU | cache-aware streaming, greedy/modified-beam, int8 enc/dec/joiner, `DisableMemPattern`+`ORT_SEQUENTIAL` for DML | **Yes** (DML needs self-built native lib + `SHERPA_ONNX_LIB_DIR`) | THE reference oracle; covers Zipformer/SenseVoice/Dolphin/NeMo/Cohere + DML. We already dep on it (CPU). |
| **whisper.cpp** | ggerganov/whisper.cpp | C++ GGML | CUDA/**Vulkan**/Metal (no DML) | very active | 3–12× over CPU on iGPU (Vulkan) | GGML quant Q5/Q8, `-fa` flash-attn (+1.25× but degrades non-EN) | Win CPU + Vulkan (not DML) | CPU/Vulkan yardstick; ideas only |
| **distil-whisper** | huggingface/distil-whisper | model (any runtime) | runtime-agnostic | yes | 5.8× standalone (2/32 dec layers); **2× as spec-decode draft, lossless** | shared encoder, 2 decoder layers | **Yes via ort** | benchmark: standalone + speculative draft |
| **WhisperX** | m-bain/whisperX | Python | backend-agnostic | yes | **12× long-form** (VAD cut+merge 30s batched) | VAD chunking + overlap-merge (kills boundary hallucination) | **Yes (algorithm)** | adopt the chunking strategy (our `merge_chunks` gap) |
| **Moonshine / moonshine.cpp** | moonshine-ai/moonshine, royshil/moonshine.cpp | C++ + ORT (`.ort` mmap) | ORT EPs | very active | Tiny-Streaming 34ms@12%WER vs whisper-tiny 277ms | **no 30s pad** (variable window), KV-cache + cached encoder across stream ticks | **Yes** | low-latency dictation candidate; variable-window trick |
| **OpenVINO GenAI** | openvinotoolkit/openvino.genai | C++ + OpenVINO | Intel CPU/iGPU/NPU (not DML) | yes | "stateful Whisper", INT8 NNCF, **speculative decoding** | KV-cache opt, seq chunking >30s | Win, but OV stack not ort | spec-decode + stateful-decoder ideas; 2025: OV ships as an **ORT EP under Windows ML** |
| **NVIDIA NeMo** | NVIDIA-NeMo/NeMo | Python/CUDA | CUDA | very active | up to 10× RTFx (label-loop + CUDA graphs) | **label-looping**, CUDA-graph nodes, bf16, batched CTC argmax, **TDT frame-skip** | No (ref) | label-looping (portable half) + TDT-skip (we do it) |
| **achetronic/parakeet** | achetronic/parakeet | **Go + ORT, CPU** | CPU | yes | int8 ~2GB RAM vs fp32 ~6GB | worker-pool batching, int8 | **Yes (CPU)** | CPU Parakeet baseline |
| **FunASR / SenseVoice** | FunAudioLLM/SenseVoice | Python + ORT/C++ | ORT EPs | yes | "70ms/10s, 15× vs Whisper-large" | **LFR-7/6 frame stacking (~6× fewer enc frames)**, CMVN, non-AR CTC | **Yes** (via sherpa/ort) | LFR/CMVN (we do it); confirms our SenseVoice approach |
| **T-one** | voicekit-team/T-one | Python + ONNX | CUDA/TRT; ort | yes (265★) | call-center WER 8.63% | 300ms chunk + carried hidden state, greedy/KenLM (skip KenLM on Win) | partial (ort, greedy) | streaming chunk+state carry |
| **WeNet (U2++)** | wenet-e2e/wenet | C++ + ORT | ORT EPs | yes | production | two-pass CTC→attention-rescore, incremental KV, **batched single-pass rescore w/ causal mask** | Yes (ort) | two-pass + batched rescore idea |
| **Vosk/Kaldi** | alphacep/vosk-api, Bear-03/vosk-rs | Kaldi C++ + Rust FFI | **CPU only** | yes | ~50MB models, RPi-capable | WFST decode, quantized AM, true streaming | Win CPU (not ort) | CPU streaming baseline only |
| **ratchet** | huggingface/ratchet | Rust + WebGPU | WebGPU | semi | ~3–5× slower than llama.cpp | static-encoder/dynamic-decoder graph split, in-place ops | ref (WebGPU<DML) | graph-discipline idea |
| **kyutai/moshi.rs** | kyutai-labs/delayed-streams-modeling | Rust + candle | Metal/CUDA (no DML) | yes | streaming 0.5–2.5s delay | delayed-streams architecture | ref | streaming design |
| **WhisperKit** | argmaxinc/WhisperKit | Swift + CoreML/MLX | ANE/Metal | yes | 72× RT M2 Ultra; spec-decode 2.35× | **OD-MBP** outlier-aware 4-bit palettization, stateful ANE | ref (Apple) | mixed-bit/outlier quant idea (vs our lite-whisper int4 garbage) |
| **parakeet.cpp (Frikallo)** | Frikallo/parakeet.cpp | C++ (Axiom) | Metal | yes | enc ~27ms/10s, 96× vs CPU | greedy+beam+ARPA-LM+context-biasing | ref (no Win) | context-biasing / phrase-boost idea |
| **TheStageAI/TheWhisper** | TheStageAI/TheWhisper | Python SDK (commercial) | NVIDIA tensor-core + Apple | yes | RTX5090 280 RTFx (batched, weak baseline) | ANNA compiler: PTQ INT8/FP8/INT4 + SmoothQuant + CUDA kernel compile | **No** | weights CC-BY-4.0; per-layer-quant philosophy only |

(Canary-Qwen-2.5B, Riva/NIM, TensorRT-LLM whisper, parakeet-mlx, FluidAudio, GigaAM-official: all
reference-only — CUDA/Apple/PyTorch-locked; mine algorithms, don't benchmark. Details in the agent dumps.)

---

## Portable optimization leads — reconciled against what we ALREADY do

| # | Optimization | Source mechanism | Status in WinSTT |
|---|---|---|---|
| 1 | **IoBinding device-resident KV + per-step `synchronize_outputs`** on DML | ORT Whisper redesign; sherpa-onnx | ✅ **DONE** (whisper.rs) — survey confirms it's THE biggest DML win + correct foundational choice |
| 2 | **`memory_pattern(false)` + sequential exec for DML** | sherpa-onnx `session.cc`; transcribe-rs | ✅ **DONE this session** (L1, families.rs+whisper.rs) — matches sherpa byte-for-byte |
| 3 | **TDT frame-skipping** (advance by `argmax(duration)`, not +1) | TDT paper; NeMo; istupakov | ✅ **DONE** (families.rs:1439/1942) — up to ~2.8× fewer decode steps |
| 4 | **Parallel featurizers + thread-local FFT** | (ours) | ✅ **DONE this session** — beats all native impls' single-threaded featurizers |
| 5 | **LFR-7/6 frame stacking + CMVN** for CTC | FunASR `wav_frontend.py` | ✅ **DONE** (apply_lfr/apply_cmvn) — confirms SenseVoice approach |
| 6 | **ORT 3-model Whisper topology** (encoder computes cross-attn KV once; single reused decoder; NO `WhisperBeamSearch` op — it CRASHES on DirectML) | ORT PR #23549; Olive #1221 | ✅ effectively DONE (we use IoBinding decode, not the beam-search op) |
| 7 | **WhisperX VAD cut-&-merge 30s chunking + overlap-merge** | WhisperX (Interspeech 2023) | ⚠ **GAP** — prod VAD-segments but no overlap-merge; fixes boundary hallucination + enables batching (12× long-form). The `merge_chunks` item our memory flags. |
| 8 | **Label-looping transducer decode** (run predictor once per real token; batch the joint across utterances/frames) | Label-Looping arXiv 2406.06220; NeMo | ⚠ **PARTIAL/NEW** — we do frame-skip + greedy single-hyp; batching the joint + predictor-once-per-token is unexploited headroom (RNNT/TDT) |
| 9 | **Speculative decoding w/ distil-whisper draft** (encoder-shared, +8% RAM, ~2× lossless) | HF spec-decode blog | 🔬 **EXPERIMENTAL** — CUDA-proven only, batch≤4, unproven on DML/CPU. Benchmark-gated. |
| 10 | **`max_symbols_per_step` guard** on transducer decode | NeMo; parakeet-rs (MAX=10) | ❓ **VERIFY** — robustness; may already exist in our realtime guard |
| 11 | **Outlier-aware / static-calibration quant** (not naive dynamic INT4) | WhisperKit OD-MBP; SmoothQuant | ✅ aligned — we already exclude int4 for lite-whisper (the int4-garbage finding) |
| 12 | **INT4-on-DML is benchmark-gated, often SLOWER on CPU/DML** | onnxruntime-genai #1098 | ✅ aligned — matches our per-engine quant matrix; corroborated cohere-int8-CPU 5× slower |

**Net: of 12 leads, we already implement 8.** The genuinely new/unexploited ones are **#7 (VAD
overlap-merge chunking)**, **#8 (label-looping/batched-joint for transducers)**, and **#9 (speculative
decoding — experimental)**. Everything else the survey confirms we already do correctly.

---

## Benchmark shortlist

**Build + benchmark on Windows (apples-to-apples with ort/DML/CPU):**
1. **sherpa-onnx with a self-built DirectML native lib** — highest leverage; the ONLY real ort+DML
   competitor, covers Zipformer/SenseVoice/Dolphin/NeMo/Cohere. We already dep on the crate (CPU); DML
   needs `cmake -DSHERPA_ONNX_ENABLE_DIRECTML=ON` + `SHERPA_ONNX_LIB_DIR`. Even if never adopted, it's the
   "is my DML doing the right thing" oracle. **Effort: medium-high (CMake C++ build).**
2. **distil-whisper on ort** — standalone + as a speculative-decode draft (lossless 2×). **Effort: medium.**
3. **moonshine ONNX** — low-latency dictation model that beats whisper-tiny; variable-window. **Low effort.**
4. **achetronic/parakeet (Go CPU ONNX)** — CPU Parakeet baseline. **Low effort.**

**Reference-only (mine the algorithm, don't run — wrong backend):** NeMo (label-looping source),
parakeet.cpp/parakeet-mlx (TDT/beam/context-biasing reference), WhisperKit (OD-MBP quant), TensorRT-LLM
(paged KV), OpenVINO GenAI (speculative), kyutai/moshi (streaming arch), TheStageAI (skip).

---

## Recommendations (priority order)
1. **Implement #7 (WhisperX VAD overlap-merge chunking)** — real long-form quality+throughput win, fully
   portable, no external dep, addresses the gigaam-245s-class limit + boundary hallucinations.
2. **Investigate #8 (label-looping / batched joint)** for our RNNT/TDT decode — measure if predictor-once
   + batched-joint beats our current per-frame greedy (we already win vs onnx-asr/parakeet-rs, so this is
   incremental, not urgent).
3. **Benchmark sherpa-onnx DirectML** as the cross-family oracle (medium effort; validates our per-family
   DML against the one mature ort+DML runtime).
4. **Spike #9 (speculative decoding)** only if single-stream Whisper latency becomes a complaint — it's
   CUDA-proven-only and likely marginal on DML/CPU.
5. Verify **#10 (`max_symbols_per_step` guard)** exists in our transducer loop (cheap robustness).

## Sources
Consolidated from 4 research passes; full citation lists in the agent reports. Key: sherpa-onnx DirectML
(C++ source: CMakeLists/provider.cc/session.cc), ORT Whisper redesign PR #23549, WhisperX Interspeech 2023,
Label-Looping arXiv 2406.06220, TDT arXiv 2304.06795, HF speculative-decoding blog, FunASR wav_frontend.py,
TheStageAI HF card + docs, onnxruntime-genai #1098 (INT4-slow). URLs in `.deep-research/` agent dumps +
`~/Documents/Whisper_Engines_Research_20260603/`.
