// Quantization + Accelerator types, EP resolution, and the shared ORT session/provider helpers
// used by whisper.rs / moonshine.rs / families.rs. Split out of the stt module root for
// navigability; re-exported there to preserve every `crate::winstt::stt::X` path.

// ---------------------------------------------------------------------------
// Quantization / accelerator
// ---------------------------------------------------------------------------

/// The precision tier actually loaded. Maps to the HF file suffix
/// (`""` → default fp32 export, `fp16`, `int8`, `q4`, `q4f16`, `bnb4`, `uint8`).
/// `None`/`Default` means "the unsuffixed export on disk".
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Quantization {
    #[default]
    Default, // ""  — unsuffixed export
    Fp16,
    Fp16w,
    Int8,
    Q4,
    Q4f16,
    Bnb4,
    Uint8,
}

impl Quantization {
    /// HF file suffix WITHOUT the separator (`""` for `Default`). The separator
    /// (`_` for onnx-community, `.` for Kaldi/sherpa) is chosen at glob time —
    /// see `resolver` spec §2 and `_file_quantization`.
    pub fn suffix(self) -> &'static str {
        match self {
            Quantization::Default => "",
            Quantization::Fp16 => "fp16",
            Quantization::Fp16w => "fp16w",
            Quantization::Int8 => "int8",
            Quantization::Q4 => "q4",
            Quantization::Q4f16 => "q4f16",
            Quantization::Bnb4 => "bnb4",
            Quantization::Uint8 => "uint8",
        }
    }

    pub fn parse(s: &str) -> Option<Quantization> {
        Some(match s.trim() {
            "" => Quantization::Default,
            "fp16" => Quantization::Fp16,
            "fp16w" => Quantization::Fp16w,
            "int8" => Quantization::Int8,
            "q4" => Quantization::Q4,
            "q4f16" => Quantization::Q4f16,
            "bnb4" => Quantization::Bnb4,
            "uint8" => Quantization::Uint8,
            _ => return None,
        })
    }
}

/// Resolved ORT execution-provider intent. The user-facing setting
/// (`auto` / `cuda` / `directml` / `cpu` …) is collapsed to one of these by
/// `resolve_accelerator` (ported in 03_stt_engine.md §9).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Accelerator {
    Cpu,
    Cuda,
    DirectMl,
    CoreMl,
    Rocm,
    OpenVino,
}

/// Resolve `model.device` to the primary STT accelerator for this target.
///
/// CPU-first cross-platform milestone: the shipped Windows target uses DirectML for `auto`;
/// non-Windows defaults to CPU unless a validated provider feature is built for that target.
pub fn resolve_accelerator(device: crate::winstt::settings_schema::DeviceType) -> Accelerator {
    use crate::winstt::settings_schema::DeviceType;

    match device {
        DeviceType::Cpu => Accelerator::Cpu,
        DeviceType::Auto if cfg!(windows) => Accelerator::DirectMl,
        DeviceType::Auto if cfg!(all(target_os = "macos", feature = "coreml")) => {
            Accelerator::CoreMl
        }
        DeviceType::Auto if cfg!(all(target_os = "linux", feature = "cuda")) => Accelerator::Cuda,
        DeviceType::Auto if cfg!(all(target_os = "linux", feature = "rocm")) => Accelerator::Rocm,
        DeviceType::Auto => Accelerator::Cpu,
    }
}

/// Expand a primary accelerator to the ORT provider preference list.
/// CPU is included as the op/session fallback for non-CPU providers.
pub fn providers_for_accelerator(primary: Accelerator) -> Vec<Accelerator> {
    match primary {
        Accelerator::Cpu => vec![Accelerator::Cpu],
        other => vec![other, Accelerator::Cpu],
    }
}

// ---------------------------------------------------------------------------
// Shared ORT session/provider helpers (used by whisper.rs, moonshine.rs, families.rs)
// ---------------------------------------------------------------------------

/// Best-effort logical CPU count for `with_intra_threads` / `pick_intra_op_threads`.
/// Falls back to 4 when the platform can't report it.
pub(crate) fn num_cpus_best_effort() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
}

/// Map our `Accelerator` list to ort `ExecutionProviderDispatch`es. CPU is always appended as
/// the op-level fallback. Platform/provider EPs are compiled only behind their target/feature
/// cfgs; unavailable accelerators are skipped and fall through to CPU at session creation.
pub(crate) fn execution_providers(
    providers: &[Accelerator],
) -> Vec<ort::ep::ExecutionProviderDispatch> {
    let mut out: Vec<ort::ep::ExecutionProviderDispatch> = Vec::new();
    for acc in providers {
        match acc {
            Accelerator::DirectMl => {
                #[cfg(windows)]
                {
                    out.push(ort::ep::DirectML::default().build());
                }
            }
            Accelerator::Cuda => {
                #[cfg(feature = "cuda")]
                {
                    out.push(ort::ep::CUDA::default().build());
                }
            }
            Accelerator::CoreMl => {
                #[cfg(all(target_os = "macos", feature = "coreml"))]
                {
                    out.push(ort::ep::CoreML::default().build());
                }
            }
            Accelerator::Rocm => {
                #[cfg(feature = "rocm")]
                {
                    out.push(ort::ep::ROCm::default().build());
                }
            }
            Accelerator::OpenVino => {
                #[cfg(feature = "openvino")]
                {
                    out.push(ort::ep::OpenVINO::default().build());
                }
            }
            _ => {}
        }
    }
    out.push(ort::ep::CPU::default().build());
    out
}

/// The ORT provider-name string for an `Accelerator` (diagnostics / logging).
pub(crate) fn provider_label(a: &Accelerator) -> String {
    match a {
        Accelerator::Cpu => "CPUExecutionProvider",
        Accelerator::Cuda => "CUDAExecutionProvider",
        Accelerator::DirectMl => "DmlExecutionProvider",
        Accelerator::CoreMl => "CoreMLExecutionProvider",
        Accelerator::Rocm => "ROCMExecutionProvider",
        Accelerator::OpenVino => "OpenVINOExecutionProvider",
    }
    .to_string()
}

/// Canonical sort key for `{past_key_values|present}.N.{decoder|encoder}.{key|value}` KV-cache
/// tensor names → `(layer index, sub-tensor rank)`, giving a total order independent of graph
/// iteration order. Strips whichever prefix is present, so it serves both the `past_key_values.`
/// (decoder inputs) and `present.` (decoder outputs) forms.
pub(crate) fn kv_sort_key(name: &str) -> (i64, i64) {
    let rest = name
        .trim_start_matches("past_key_values.")
        .trim_start_matches("present.");
    let mut parts = rest.split('.');
    let layer = parts
        .next()
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(i64::MAX);
    let sub = match (parts.next(), parts.next()) {
        (Some("decoder"), Some("key")) => 0,
        (Some("decoder"), Some("value")) => 1,
        (Some("encoder"), Some("key")) => 2,
        (Some("encoder"), Some("value")) => 3,
        _ => 4,
    };
    (layer, sub)
}
