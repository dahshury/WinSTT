# Rust ONNX STT implementations per family + performance leads

**Date:** 2026-06-03. Goal: identify dedicated Rust ASR impls to benchmark our per-family `ort` decoders against, and mine model-specific speed optimizations. Sources cited inline.

## Comparison set (who to benchmark per family)

| Family | Best dedicated Rust impl | Backend / EP | Notes |
|---|---|---|---|
| **Parakeet** CTC/RNNT/TDT | **`altunenes/parakeet-rs`** [1] (crates.io 0.2.4, active) | `ort` (ONNX Runtime), EPs: CPU/**DirectML**/CUDA/TensorRT/WebGPU/MIGraphX | Cache-aware streaming (Nemotron), int8/fp16/**int4**, Sortformer diarization. "Significantly faster than Whisper-metal even on CPU (M3)." Directly comparable to our stack (ort). **Primary parakeet baseline.** |
| **Whisper / lite/distil/Crisper** | `whisper-rs` (whisper.cpp/GGML) [2]; `candle-whisper` (Kalosm/`rwhisper`, pure-Rust Candle) [2]; **`faster-whisper-rs`** (CTranslate2) [2] | GGML / Candle / CT2 | **CT2 faster-whisper is the fast whisper path** — the Electron HF cache has `faster-whisper-large-v3-turbo-ct2` + `mobiuslabsgmbh--faster-whisper-large-v3-turbo`, so Electron likely decodes whisper via CTranslate2 (int8 + tight KV-cache), which beats ONNX whisper decode. Quote: "the ONNX [whisper] version is still 4× slower than the PyTorch model using kv-caching" [2]. |
| **Parakeet/Moonshine/SenseVoice/GigaAM** (cross-cutting) | **`transcribe-rs`** [3] (the crate Handy uses) | **`ort` 2.0.0-rc.12 — SAME runtime as us** | Implements SenseVoice/GigaAM/Parakeet/Moonshine (onnx feature) + Whisper (GGML). `OrtAccelerator` Auto/Cpu/Cuda/DirectMl/Rocm/CoreML/WebGPU; Int8 default. Because it's the **same ort version**, any speed delta vs us is **decode loop + session config, NOT the runtime.** |
| **Zipformer / NeMo streaming** | `sherpa-onnx` (Rust bindings) | ort/onnxruntime | We already use sherpa for these + wake-word + diarization. |
| **Canary / Cohere / Dolphin / Kaldi / T-one** | (no dedicated Rust impl found) | — | Only our `ort` decoders + the **onnx-asr fork** (Python) exist. Benchmark = ours vs onnx-asr-fork. |

## Optimization leads (ranked — what to check/port)

### L1 — DirectML session settings (HIGH, likely smoking gun) ★★★★★
ONNX Runtime's DirectML EP is **incompatible with memory-pattern + parallel execution**; you must set `DisableMemPattern()` + sequential `ExecutionMode`. transcribe-rs explicitly excludes DML from its "Auto" because "DirectML requires special ORT session settings (`parallel_execution(false)`, `memory_pattern(false)`) that would hurt other backends" [2]. **Our `families.rs` session builder sets `optimization_level=Level3` + `intra_threads` but does NOT disable memory_pattern / force sequential for the DirectML EP.** → Likely degrades (or mis-runs / silently CPU-falls-back) our DML path. **Test: add `.with_memory_pattern(false)` + sequential execution when EP==DirectML and re-benchmark.**

### L2 — CTranslate2 for whisper (HIGH for whisper family) ★★★★☆
If whisper/lite-whisper is the family that "felt instant in Electron," Electron is probably using CT2 faster-whisper (the cached ct2 model), not ONNX. CT2 whisper decode is markedly faster than ONNX whisper (int8 + fused KV-cache). Options: (a) ship a CT2 path for whisper, or (b) verify onnx-asr-fork's whisper decode optimizations and match them in our ort decoder (IoBinding KV-cache — we already do this per `project_whisper_iobinding_dml_decode`, so confirm it's active + correct).

### L3 — parakeet-rs cache-aware decode (MED, parakeet) ★★★☆☆
parakeet-rs ships cache-aware streaming + int4/int8. Benchmark our parakeet (ctc/rnnt/tdt) vs parakeet-rs CPU+DML; if it wins, port its session/decode config (it's ort, so portable).

### L4 — onnx-asr-fork parity (MED) ★★★☆☆
Use OUR fork `onnx-asr-work` (editable at `E:/DL/Projects/onnx-asr-work`) as the Python baseline (it has our optimizations + extra models), NOT upstream onnx-asr. For families where the fork beats us, diff its per-family graph-input prep / quant defaults / EP options against ours.

### L5 — int8 vs fp32 on DML (KNOWN) ★★☆☆☆
Per our own memory matrix: DML does NOT accelerate int8/QDQ (per-op kernel launches), and several families are faster fp32-on-DML or int8-on-CPU. Confirm the per-quant routing is optimal in the benchmark (we already have `is_dml_incompatible` + `dml_slower_than_cpu` policy — validate it empirically per quant).

## Benchmark plan (next phase)
Matrix: **{ours `stt_spike --catalog`, onnx-asr-fork, transcribe-rs, parakeet-rs(parakeet only), CT2/whisper-rs(whisper only)} × {CPU, DirectML} × {installed quants} × {short ~3s, medium JFK ~11s, long ~60-120s}**, measuring **warm RTF** + **WER vs reference transcript**. >10% RTF gap vs the best = a finding to chase. Stop the app first (GPU/CPU contention). Extend `scripts/bench_onnxasr_electron.py` into an orchestrator that shells to the Rust binaries + the fork python + emits a comparison table.

## Sources
[1] altunenes/parakeet-rs — github.com/altunenes/parakeet-rs, crates.io/crates/parakeet-rs (0.2.4), docs.rs/parakeet-rs. ort-based, multi-EP incl DirectML, CTC/TDT/streaming/diarization, int8/fp16/int4.
[2] Rust whisper landscape — cprohm.de/blog/whisper (ONNX whisper 4× slower than kv-cached PyTorch), transcribe-rs crates.io/docs.rs (DirectML special session settings; OrtAccelerator Auto excludes DML), github: igor-yusupov/rusty-whisper (tract), Kalosm/rwhisper (Candle), CodersCreative/faster-whisper-rs (CT2).
[3] transcribe-rs — docs.rs/transcribe-rs, crates.io/crates/transcribe-rs. ort 2.0.0-rc.12 (== ours); engines SenseVoice/GigaAM/Parakeet/Moonshine (onnx) + Whisper (GGML); EPs CPU/CUDA/ROCm/DirectML/CoreML/WebGPU; Int8 default.
