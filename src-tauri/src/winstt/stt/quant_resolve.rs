// Pure quant/fit/device-routing decision helpers (RAM/VRAM-aware auto-quant, accuracy-first
// resolution, DML→CPU override) + the deterministic CTC/thread/vocab helpers, with their unit
// tests. Split out of the stt module root for navigability; re-exported there so every
// `crate::winstt::stt::X` path and sibling `super::X` reference keeps resolving.
//
// Leaf dependency direction: device <- engine_kind <- quant_resolve. These helpers reach back
// into the module root (via `super::`) for `EngineKind`, the `Accelerator`/`Quantization` types,
// and `providers_for_accelerator`/`resolve_accelerator`, all of which the root re-exports.

use super::{Accelerator, EngineKind, Quantization, providers_for_accelerator};

// ---------------------------------------------------------------------------
// Pure-logic helpers. These are the safe
// deterministic ports; everything ML stays a stub above.
// ---------------------------------------------------------------------------

/// Port of `asr._vocab_is_uppercase`: report whether ≳90% of the vocab's cased
/// tokens are UPPERCASE — identifies icefall/Kaldi LibriSpeech BPE vocabs
/// (e.g. `sherpa-onnx-zipformer-en`) whose ALL-CAPS output must be lowercased
/// for dictation. Special markers (`<…>`) and uncased tokens (digits, `▁`, CJK)
/// are ignored; a vocab with no cased real tokens returns false.
pub fn vocab_is_uppercase<'a>(tokens: impl IntoIterator<Item = &'a str>) -> bool {
    let mut cased_total = 0usize;
    let mut upper = 0usize;
    for t in tokens {
        let is_marker = t.starts_with('<') && t.ends_with('>');
        // "cased" == lowercasing changes it differently than uppercasing
        // (i.e. it has at least one cased letter). Mirrors Python `t.lower() != t.upper()`.
        let has_case = t.to_lowercase() != t.to_uppercase();
        if has_case && !is_marker {
            cased_total += 1;
            if t == t.to_uppercase() {
                upper += 1;
            }
        }
    }
    if cased_total == 0 {
        return false;
    }
    (upper as f64) / (cased_total as f64) > 0.9
}

/// Port of the int8-preferred / fp16-auto resolution from
/// `bootstrap._resolve_quantization`, reduced to the (already EP-resolved)
/// decision. `param_count` gates fp16 auto-promotion (≥500M on CUDA only);
/// `available` is the catalog's published quant set (`None` = unknown / off-catalog,
/// permissive). Returns the quant to actually load.
///
/// NOTE: the FULL function also rejects sub-fp16 quants on CUDA and warns on
/// unpublished concrete quants — those branches are specified in 03_stt_engine.md §7
/// and folded into the resolver; this helper covers the AUTO path that the unit
/// test pins.
pub fn resolve_quantization_auto(
    requested: Quantization,
    accelerator: Accelerator,
    family: &str,
    param_count: u64,
    available: Option<&[Quantization]>,
) -> Quantization {
    const FP16_AUTO_PARAM_THRESHOLD: u64 = 500_000_000;
    let publishes = |q: Quantization| available.is_none_or(|a| a.contains(&q));

    // Only the AUTO path ("" / Default) auto-resolves; concrete requests pass
    // through the fuller resolver (see spec §7). Here `Default` IS the auto sentinel.
    if requested != Quantization::Default {
        return requested;
    }
    let _ = family; // accuracy-first default no longer keys off the int8-preferred family list
    if accelerator == Accelerator::Cuda
        && param_count >= FP16_AUTO_PARAM_THRESHOLD
        && publishes(Quantization::Fp16)
    {
        return Quantization::Fp16;
    }
    // ACCURACY-FIRST default: load the model's NATURAL unsuffixed (fp32) export when it's
    // published — do NOT silently downgrade to int8. int8 trades accuracy for speed/size and is
    // the USER's call (the picker exposes every published quant off-CUDA). This also tends to be
    // FASTER on DirectML (gigaam-ctc fp32 32ms < int8 51ms — DML doesn't accelerate int8/QDQ).
    // int8-only models (sense_voice/dolphin publish no fp32) fall back to int8.
    if publishes(Quantization::Default) {
        return Quantization::Default;
    }
    if publishes(Quantization::Int8) {
        return Quantization::Int8;
    }
    Quantization::Default
}

/// Runtime footprint bytes-per-param at each quant — mirrors the renderer fit-assessor
/// `BYTES_PER_PARAM_BY_QUANT` (fp32 4, fp16 2, int8/uint8 1.2, 4-bit 0.75).
fn bytes_per_param(q: Quantization) -> f64 {
    match q {
        Quantization::Default => 4.0,
        Quantization::Fp16 | Quantization::Fp16w => 2.0,
        Quantization::Int8 | Quantization::Uint8 => 1.2,
        Quantization::Q4 | Quantization::Q4f16 | Quantization::Bnb4 | Quantization::Int4 => 0.75,
    }
}

/// Accuracy/faithfulness weight (higher = more accurate) — mirrors the picker's
/// `QUANTIZATION_WEIGHT` ("" 32, fp16 16, int8/uint8 8, q4f16 6, int4/bnb4/q4 4).
fn accuracy_weight(q: Quantization) -> u32 {
    match q {
        Quantization::Default => 32,
        Quantization::Fp16 | Quantization::Fp16w => 16,
        Quantization::Int8 | Quantization::Uint8 => 8,
        Quantization::Q4f16 => 6,
        Quantization::Bnb4 | Quantization::Q4 | Quantization::Int4 => 4,
    }
}

/// RAM/VRAM-aware AUTO quant: the HIGHEST-ACCURACY published quant whose runtime footprint
/// (`param_count × bytes_per_param`) FITS the user's hardware — degrading fp32→fp16→int8→q4 only as
/// needed. This is the smart "auto" the user asked for (NOT a blind int8, NOT a blind fp32): a roomy
/// box keeps fp32 (best accuracy); a tight box steps down to what fits. The fit BUDGET is the device
/// the (engine, quant) actually runs on (per `override_dml_to_cpu_for_kind`): VRAM for a DML engine,
/// available system RAM for a CPU engine. Budgets in bytes (0 = unknown → permissive, never blocks).
/// If nothing fits, the most-compact published quant. Concrete user picks bypass this (explicit).
pub fn fit_aware_auto_quant(
    available: &[Quantization],
    kind: EngineKind,
    primary: Accelerator,
    param_count: u64,
    available_ram_bytes: u64,
    vram_bytes: u64,
) -> Quantization {
    const GPU_HEADROOM: f64 = 1.5; // matches catalog_data GPU_HEADROOM
    const RAM_USABLE_FRACTION: f64 = 0.7; // matches fit-assessor cpuBudget
    // Accuracy order best→worst (GPU / VRAM-backed EPs).
    const ORDER: &[Quantization] = &[
        Quantization::Default,
        Quantization::Fp16,
        Quantization::Fp16w,
        Quantization::Int8,
        Quantization::Uint8,
        Quantization::Q4f16,
        Quantization::Bnb4,
        Quantization::Q4,
        Quantization::Int4,
    ];
    // CPU-EP order: the fp16-COMPUTE quants (fp16 / fp16w / q4f16) go LAST. onnxruntime's CPU
    // EP (through the bundled 1.24 build) has no native fp16 matmul kernels — it up-casts fp16→fp32
    // per op every decode step, so an fp16 weight set runs DRAMATICALLY SLOWER than fp32, not faster.
    // MEASURED on cohere-transcribe (CPU EP, 8.6s clip, this repo's `stt_decode_bench`):
    //   fp32 ~1.3s · q4 ~1.0s   (fast — fp32-compute)
    //   fp16 ~5–11s · q4f16 ~3–5s   (SLOW — fp16-compute up-cast)
    // This is the INVERSE of a CUDA/WebGPU box (where fp16 is both accurate AND fast — hence the
    // CUDA-only fp16 auto-promotion in `resolve_quantization_auto`). So on the CPU EP prefer the
    // fp32-compute quants by accuracy (fp32 → int8 → q4 …) and only fall to an fp16 set when it is
    // the ONLY thing published. Without this, a box that fits fp16 (2×param) but not fp32 (4×param)
    // — anything with ~6–11 GB free RAM for a 2 B model — silently lands on the 5–11s fp16 path.
    const CPU_ORDER: &[Quantization] = &[
        Quantization::Default,
        Quantization::Int8,
        Quantization::Uint8,
        Quantization::Q4,
        Quantization::Bnb4,
        Quantization::Int4,
        Quantization::Fp16,
        Quantization::Fp16w,
        Quantization::Q4f16,
    ];
    // Does the model run on the CPU EP under the user's primary? AED families (cohere/canary) are
    // CPU-pinned regardless of device; a GPU-capable model is CPU-bound only when the user picked the
    // CPU device. Probe with the natural (Default) export — the routing that decides DML-vs-CPU.
    let cpu_bound = matches!(
        override_dml_to_cpu_for_kind(
            providers_for_accelerator(primary),
            kind,
            Quantization::Default
        )
        .first(),
        Some(Accelerator::Cpu) | None
    );
    let order: &[Quantization] = if cpu_bound { CPU_ORDER } else { ORDER };
    for &q in order {
        if !available.contains(&q) {
            continue;
        }
        let footprint = (param_count as f64) * bytes_per_param(q);
        // Resolve the ACTUAL device for (kind, q) under the user's primary: CPU-device → always CPU
        // (RAM budget); GPU primary → the per-(engine,quant) override decides DML vs CPU. Only a
        // VRAM-backed EP (DirectML/CUDA) uses the VRAM budget.
        let routed = override_dml_to_cpu_for_kind(providers_for_accelerator(primary), kind, q);
        let on_gpu = matches!(
            routed.first(),
            Some(Accelerator::DirectMl) | Some(Accelerator::Cuda)
        );
        let fits = if on_gpu {
            vram_bytes == 0 || footprint * GPU_HEADROOM <= vram_bytes as f64
        } else {
            available_ram_bytes == 0
                || footprint <= available_ram_bytes as f64 * RAM_USABLE_FRACTION
        };
        if fits {
            return q;
        }
    }
    // Nothing fits the budget — fall back to the most-compact (lowest-accuracy-weight) published quant.
    available
        .iter()
        .copied()
        .min_by_key(|q| accuracy_weight(*q))
        .unwrap_or(Quantization::Default)
}

/// EngineKind-based DML→CPU override. This is the runtime provider-routing policy:
/// the reference blanket-excluded whole families; we measured per-engine with the
/// DirectML benchmark harness and route to CPU only when DML CRASHES
/// (`is_dml_incompatible`: AED decoders + unstable sherpa graphs) OR is SLOWER than CPU
/// (`dml_slower_than_cpu`: the RNN-T predictor-loop transducers). The NeMo CTC/TDT +
/// GigaAM-CTC + T-One graphs run 2–3× faster on DML, so they keep the GPU EP.
/// Only fires for non-CUDA GPU EPs; CUDA/CPU/None pass through.
pub fn override_dml_to_cpu_for_kind(
    providers: Vec<Accelerator>,
    kind: EngineKind,
    quant: Quantization,
) -> Vec<Accelerator> {
    if !kind.is_dml_incompatible() && !kind.dml_slower_than_cpu(quant) {
        return providers;
    }
    match providers.first().copied() {
        Some(Accelerator::Cuda) | Some(Accelerator::Cpu) | None => providers,
        Some(
            Accelerator::DirectMl
            | Accelerator::Rocm
            | Accelerator::CoreMl
            | Accelerator::OpenVino
            | Accelerator::WebGpu,
        ) => vec![Accelerator::Cpu],
    }
}

/// Scan an ONNX **graph** file for a specific `op_type` string. ONNX stores `NodeProto.op_type` as a
/// plain UTF-8 protobuf field, and the node section sits at the TOP of the graph proto (ahead of any
/// inline initializer `raw_data`), so a bounded byte search is exact and cheap. Shipped exports keep
/// weights in a sibling `.onnx_data`, leaving the `.onnx` graph file tiny (≈1 MB). The `CAP` guards
/// the pathological monolithic-export case (weights inline) — node defs are always within it.
///
/// Reads in 1 MiB chunks, carrying `needle.len()-1` bytes across the boundary so a match that
/// straddles two chunks is never missed. Any I/O error → `false` (treated as "op not present": the
/// caller falls back to the conservative CPU pin, never to an unsafe GPU route).
pub fn onnx_graph_contains_op(path: &std::path::Path, op: &str) -> bool {
    use std::io::Read;
    const CAP: u64 = 256 * 1024 * 1024;
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let needle = op.as_bytes();
    if needle.is_empty() {
        return false;
    }
    let overlap = needle.len() - 1;
    let mut reader = std::io::BufReader::new(file.take(CAP));
    let mut chunk = vec![0u8; 1 << 20];
    // `window` holds the trailing `overlap` bytes of the previous read + the current read, so a
    // needle spanning the seam is found; it is drained back down to `overlap` each iteration.
    let mut window: Vec<u8> = Vec::with_capacity(overlap + chunk.len());
    loop {
        let n = match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        window.extend_from_slice(&chunk[..n]);
        if window.windows(needle.len()).any(|w| w == needle) {
            return true;
        }
        if window.len() > overlap {
            window.drain(..window.len() - overlap);
        }
    }
    false
}

/// Whether a resolved **Cohere** export is safe to run on DirectML. Cohere's DML crash is confined to
/// exports that bake in the fused `com.microsoft.MultiHeadAttention` contrib op (e.g. onnx-community):
/// its DirectML kernel faults on the cross-attention (`encoder_attn`) node. Hand-decomposed exports
/// (e.g. the Masterx conversions) contain NO `MultiHeadAttention` nodes — plain MatMul/Softmax
/// attention — and run correctly, and 2–3× faster than CPU, on DirectML.
///
/// `EngineKind::is_dml_incompatible` pins ALL Cohere to CPU *before* resolve (no files on disk yet);
/// this probes the actual encoder+decoder graphs once resolved so the caller can RESTORE the GPU EP
/// for a decomposed export. Absent files / unreadable graphs → `false` (keep the safe CPU pin).
pub fn cohere_export_dml_safe(resolved: &super::ResolvedModel) -> bool {
    let mut probed_any = false;
    for key in ["encoder", "decoder"] {
        if let Some(path) = resolved.files.get(key) {
            probed_any = true;
            if onnx_graph_contains_op(path, "MultiHeadAttention") {
                return false;
            }
        }
    }
    // Only vouch for DML if we actually inspected the graph(s); an empty file map stays CPU-pinned.
    probed_any
}

/// CTC greedy collapse: argmax already done → ids; drop `blank_id`, collapse
/// consecutive repeats. Pure port of `sense_voice._ctc_greedy_decode` /
/// the `_AsrWithCtcDecoding` collapse. Returns the surviving token ids.
pub fn ctc_greedy_collapse(ids: &[i64], blank_id: i64) -> Vec<i64> {
    // Collapsed output is always <= input length — exact upper bound, no reallocs.
    let mut out = Vec::with_capacity(ids.len());
    let mut prev: i64 = -1;
    for &t in ids {
        if t != blank_id && t != prev {
            out.push(t);
        }
        prev = t;
    }
    out
}

/// `intra_op_num_threads` pick from `onnxasr_transcriber._pick_intra_op_threads`:
/// CPU EP uses physical cores capped at 16; GPU EP uses 2 feeder threads.
/// (0 = "all cores" is 49–84% SLOWER — never use the default.)
pub fn pick_intra_op_threads(is_gpu: bool, cpu_count: usize) -> usize {
    // Benchmark compatibility override: `STT_BENCH_INTRA_THREADS` lets the STT benchmark
    // sweep the intra-op thread count without recompiling (0 = let ORT auto-pick = physical cores,
    // matching onnx-asr's default).
    if let Ok(Ok(n)) = std::env::var("STT_BENCH_INTRA_THREADS").map(|v| v.trim().parse::<usize>()) {
        return n;
    }
    if is_gpu {
        // GPU EP does the compute; CPU threads only feed it. 2 is enough (more contend).
        return 2;
    }
    // CPU EP: use PHYSICAL cores (matches onnx-asr / onnxruntime's own default, which kept
    // pace with us — the old hard `min(logical, 8)` cap left ~12% on the table on this 24-logical
    // box: 16 threads beat 8). `get_physical()` avoids HT over-subscription; capped at 16 for
    // diminishing returns on big servers, and never exceeds the logical count (sanity).
    num_cpus::get_physical().min(cpu_count).clamp(1, 16)
}

#[cfg(test)]
mod tests {
    use super::super::resolve_accelerator;
    use super::*;

    #[test]
    fn uppercase_vocab_detected_for_kaldi_caps() {
        // sherpa-onnx-zipformer-en style: all-caps real tokens + markers.
        let vocab = ["<blk>", "<unk>", "THE", "QUICK", "BROWN", "FOX", "▁", "123"];
        assert!(vocab_is_uppercase(vocab));
    }

    #[test]
    fn mixed_case_vocab_not_flagged() {
        let vocab = ["<blk>", "the", "Quick", "brown", "Fox", "▁hello"];
        assert!(!vocab_is_uppercase(vocab));
    }

    #[test]
    fn cjk_only_vocab_not_flagged() {
        // No cased letters at all → false (matches Python: cased list empty).
        let vocab = ["<blk>", "你", "好", "▁", "。"];
        assert!(!vocab_is_uppercase(vocab));
    }

    #[test]
    fn ctc_collapse_drops_blanks_and_repeats() {
        // blank=0; "a a _ a b b" → "a a b"
        assert_eq!(ctc_greedy_collapse(&[1, 1, 0, 1, 2, 2], 0), vec![1, 1, 2]);
    }

    #[test]
    fn ctc_collapse_empty() {
        assert!(ctc_greedy_collapse(&[], 0).is_empty());
        assert!(ctc_greedy_collapse(&[0, 0, 0], 0).is_empty());
    }

    #[test]
    fn auto_resolves_accuracy_first_to_fp32_when_published() {
        // nemo on DirectML (non-CUDA): ACCURACY-FIRST → the natural fp32 export when published,
        // NOT a silent int8 downgrade (the user picks int8 in the picker for speed/size).
        let q = resolve_quantization_auto(
            Quantization::Default,
            Accelerator::DirectMl,
            "nemo",
            600_000_000,
            Some(&[Quantization::Default, Quantization::Int8]),
        );
        assert_eq!(q, Quantization::Default);
        // int8-only models (no fp32 published, e.g. sense_voice/dolphin) fall back to int8.
        let q_int8_only = resolve_quantization_auto(
            Quantization::Default,
            Accelerator::DirectMl,
            "dolphin",
            100_000_000,
            Some(&[Quantization::Int8]),
        );
        assert_eq!(q_int8_only, Quantization::Int8);
    }

    #[test]
    fn int8_not_forced_when_unpublished() {
        // t-one publishes only "" → stays Default even though int8-preferred.
        let q = resolve_quantization_auto(
            Quantization::Default,
            Accelerator::Cpu,
            "t-one",
            71_700_000,
            Some(&[Quantization::Default]),
        );
        assert_eq!(q, Quantization::Default);
    }

    #[test]
    fn fp16_auto_only_for_large_on_cuda() {
        // whisper large-v3-turbo (795M) on CUDA, publishes fp16 → fp16.
        let big = resolve_quantization_auto(
            Quantization::Default,
            Accelerator::Cuda,
            "whisper",
            795_800_000,
            Some(&[Quantization::Default, Quantization::Fp16]),
        );
        assert_eq!(big, Quantization::Fp16);
        // whisper tiny (37M) on CUDA → stays Default (cast overhead dominates).
        let small = resolve_quantization_auto(
            Quantization::Default,
            Accelerator::Cuda,
            "whisper",
            37_800_000,
            Some(&[Quantization::Default, Quantization::Fp16]),
        );
        assert_eq!(small, Quantization::Default);
    }

    #[test]
    fn fp16_auto_never_on_cpu_for_whisper() {
        // Large whisper on CPU/DML → Default (CPU EP has no fp16 kernels;
        // whisper is NOT int8-preferred so it doesn't pick int8 either).
        let q = resolve_quantization_auto(
            Quantization::Default,
            Accelerator::DirectMl,
            "whisper",
            1_550_000_000,
            Some(&[Quantization::Default, Quantization::Fp16]),
        );
        assert_eq!(q, Quantization::Default);
    }

    #[test]
    fn cpu_auto_quant_avoids_slow_fp16_compute() {
        // cohere-class: 2 B, forced to the CPU EP (AED), publishes ["", fp16, q4, q4f16]. Our ORT CPU
        // EP up-casts fp16→fp32 (fp16 ~5–11s vs fp32 ~1.3s), so auto must NEVER pick fp16/q4f16 here.
        let available = [
            Quantization::Default,
            Quantization::Fp16,
            Quantization::Q4,
            Quantization::Q4f16,
        ];
        const GB: u64 = 1024 * 1024 * 1024;
        // Roomy box → the natural fp32 export (best accuracy AND fast on CPU).
        assert_eq!(
            fit_aware_auto_quant(
                &available,
                EngineKind::CohereAsr,
                Accelerator::DirectMl, // GPU primary, but cohere is DML-incompatible → CPU EP
                2_000_000_000,
                64 * GB,
                12 * GB,
            ),
            Quantization::Default
        );
        // Mid-RAM box (fp32 8 GB doesn't fit 0.7×10 GB, fp16 4 GB WOULD) → must step to q4 (fast),
        // NOT fp16 (the old accuracy-first ORDER's trap on this exact RAM band).
        assert_eq!(
            fit_aware_auto_quant(
                &available,
                EngineKind::CohereAsr,
                Accelerator::Cpu,
                2_000_000_000,
                10 * GB,
                0,
            ),
            Quantization::Q4
        );
    }

    #[test]
    fn cpu_auto_quant_falls_back_to_fp16_only_when_sole_option() {
        // If fp16 is the ONLY thing published, the CPU order still reaches it (fallback, not skip).
        assert_eq!(
            fit_aware_auto_quant(
                &[Quantization::Fp16],
                EngineKind::CohereAsr,
                Accelerator::Cpu,
                2_000_000_000,
                64 * 1024 * 1024 * 1024,
                0,
            ),
            Quantization::Fp16
        );
    }

    #[test]
    fn gpu_auto_quant_keeps_accuracy_first_order() {
        // A DML-capable model on a GPU primary keeps the accuracy-first ORDER (fp16 is fast on GPU).
        // gigaam-class publishing ["", fp16] with VRAM only fitting fp16 → fp16, not a CPU downgrade.
        const GB: u64 = 1024 * 1024 * 1024;
        assert_eq!(
            fit_aware_auto_quant(
                &[Quantization::Default, Quantization::Fp16],
                EngineKind::NemoCtc, // DML-compatible → stays on the GPU EP
                Accelerator::DirectMl,
                600_000_000,
                64 * GB,
                2 * GB, // fp32 (2.4GB×1.5 headroom) doesn't fit; fp16 (1.2GB×1.5) does
            ),
            Quantization::Fp16
        );
    }

    #[test]
    fn cpu_device_resolves_to_cpu_accelerator() {
        assert_eq!(
            resolve_accelerator(crate::winstt::settings_schema::DeviceType::Cpu),
            Accelerator::Cpu
        );
    }

    #[cfg(windows)]
    #[test]
    fn auto_device_resolves_to_directml_on_windows() {
        assert_eq!(
            resolve_accelerator(crate::winstt::settings_schema::DeviceType::Auto),
            Accelerator::DirectMl
        );
    }

    #[cfg(all(
        not(windows),
        not(all(target_os = "macos", feature = "coreml")),
        not(all(target_os = "linux", feature = "cuda")),
        not(all(target_os = "linux", feature = "rocm"))
    ))]
    #[test]
    fn auto_device_resolves_to_cpu_without_non_windows_gpu_features() {
        assert_eq!(
            resolve_accelerator(crate::winstt::settings_schema::DeviceType::Auto),
            Accelerator::Cpu
        );
    }

    #[cfg(all(target_os = "macos", feature = "coreml"))]
    #[test]
    fn auto_device_resolves_to_coreml_on_macos_coreml_builds() {
        assert_eq!(
            resolve_accelerator(crate::winstt::settings_schema::DeviceType::Auto),
            Accelerator::CoreMl
        );
    }

    #[cfg(all(target_os = "linux", feature = "cuda"))]
    #[test]
    fn auto_device_resolves_to_cuda_on_linux_cuda_builds() {
        assert_eq!(
            resolve_accelerator(crate::winstt::settings_schema::DeviceType::Auto),
            Accelerator::Cuda
        );
    }

    #[cfg(all(target_os = "linux", not(feature = "cuda"), feature = "rocm"))]
    #[test]
    fn auto_device_resolves_to_rocm_on_linux_rocm_builds() {
        assert_eq!(
            resolve_accelerator(crate::winstt::settings_schema::DeviceType::Auto),
            Accelerator::Rocm
        );
    }

    #[test]
    fn provider_preference_list_keeps_cpu_fallback_only_when_needed() {
        assert_eq!(
            providers_for_accelerator(Accelerator::Cpu),
            vec![Accelerator::Cpu]
        );
        assert_eq!(
            providers_for_accelerator(Accelerator::DirectMl),
            vec![Accelerator::DirectMl, Accelerator::Cpu]
        );
    }

    #[test]
    fn dml_incompatible_engine_forced_to_cpu() {
        assert_eq!(
            override_dml_to_cpu_for_kind(
                vec![Accelerator::DirectMl, Accelerator::Cpu],
                EngineKind::NemoAed,
                Quantization::Default
            ),
            vec![Accelerator::Cpu]
        );
        assert_eq!(
            override_dml_to_cpu_for_kind(
                vec![Accelerator::DirectMl, Accelerator::Cpu],
                EngineKind::KaldiTransducerStreaming,
                Quantization::Default
            ),
            vec![Accelerator::Cpu]
        );
        assert_eq!(
            override_dml_to_cpu_for_kind(
                vec![Accelerator::DirectMl, Accelerator::Cpu],
                EngineKind::NemoRnntStreaming,
                Quantization::Int8
            ),
            vec![Accelerator::Cpu]
        );
        assert_eq!(
            override_dml_to_cpu_for_kind(
                vec![Accelerator::DirectMl, Accelerator::Cpu],
                EngineKind::NemoRnntStreaming,
                Quantization::Default
            ),
            vec![Accelerator::DirectMl, Accelerator::Cpu]
        );
        // Engine kinds measured as DML-safe keep DML.
        assert_eq!(
            override_dml_to_cpu_for_kind(
                vec![Accelerator::DirectMl, Accelerator::Cpu],
                EngineKind::NemoCtc,
                Quantization::Default
            ),
            vec![Accelerator::DirectMl, Accelerator::Cpu]
        );
        assert_eq!(
            override_dml_to_cpu_for_kind(
                vec![Accelerator::DirectMl, Accelerator::Cpu],
                EngineKind::NemoCtcStreaming,
                Quantization::Default
            ),
            vec![Accelerator::DirectMl, Accelerator::Cpu]
        );
        assert_eq!(
            override_dml_to_cpu_for_kind(
                vec![Accelerator::DirectMl, Accelerator::Cpu],
                EngineKind::ToneCtc,
                Quantization::Default
            ),
            vec![Accelerator::DirectMl, Accelerator::Cpu]
        );
        // CUDA passes through even for an incompatible engine.
        assert_eq!(
            override_dml_to_cpu_for_kind(
                vec![Accelerator::Cuda, Accelerator::Cpu],
                EngineKind::CohereAsr,
                Quantization::Default
            ),
            vec![Accelerator::Cuda, Accelerator::Cpu]
        );
    }

    #[test]
    fn engine_kind_capability_gates() {
        assert!(EngineKind::WhisperHf.supports_initial_prompt());
        assert!(!EngineKind::Moonshine.supports_initial_prompt());
        // Canary/Cohere prompt slot is UNTRAINED → no initial prompt.
        assert!(!EngineKind::CohereAsr.supports_initial_prompt());
        assert!(!EngineKind::NemoAed.supports_initial_prompt());
        // Translate: whisper + canary only.
        assert!(EngineKind::NemoAed.supports_translate());
        assert!(!EngineKind::CohereAsr.supports_translate());
        // Word timestamps possible only on WhisperHf (still load-confirmed).
        assert!(EngineKind::WhisperHf.may_support_word_timestamps());
        assert!(!EngineKind::WhisperOrt.may_support_word_timestamps());
        // Native streaming is a strict subset of final-reuse-safe models.
        assert!(EngineKind::ToneCtc.supports_native_streaming());
        assert!(EngineKind::NemoCtcStreaming.supports_native_streaming());
        assert!(EngineKind::NemoRnntStreaming.supports_native_streaming());
        assert!(EngineKind::KaldiTransducerStreaming.supports_native_streaming());
        assert!(!EngineKind::NemoCtc.supports_native_streaming());
        assert!(EngineKind::ToneCtc.final_reuse_safe());
        assert!(EngineKind::GigaamCtc.final_reuse_safe());
        assert!(EngineKind::GraniteSpeechNar.final_reuse_safe());
        assert!(!EngineKind::WhisperHf.final_reuse_safe());
        assert!(!EngineKind::NemoAed.final_reuse_safe());
        assert!(!EngineKind::GraniteSpeechAr.final_reuse_safe());
    }

    #[test]
    fn intra_op_threads_policy() {
        assert_eq!(pick_intra_op_threads(true, 16), 2); // GPU
        let physical = num_cpus::get_physical();
        assert_eq!(
            pick_intra_op_threads(false, 16),
            physical.min(16).clamp(1, 16)
        );
        assert_eq!(
            pick_intra_op_threads(false, 4),
            physical.min(4).clamp(1, 16)
        );
        assert_eq!(pick_intra_op_threads(false, 0), 1); // floor
    }
}
