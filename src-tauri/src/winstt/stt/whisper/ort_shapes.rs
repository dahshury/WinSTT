// Small ORT/config introspection helpers: device-from-providers mapping, runtime/graph
// tensor-shape reads for KV-cache shaping, and tolerant config.json integer reads. Self-free;
// split out of `whisper.rs` so the engine core stays cohesive.

use std::path::Path;

use ort::memory::AllocationDevice;
use ort::session::Session;
use ort::value::{DynValue, ValueType};

use super::super::Accelerator;

/// The `AllocationDevice` (+ id) the sessions run on, for IoBinding the encoder output + KV-cache
/// resident on it (mirrors onnx-asr `_hf.py` `get_onnx_device`). Derived from the FIRST requested
/// accelerator: DirectML/CUDA → that device; everything else (incl. Rocm/CoreML/OpenVINO, which
/// `execution_providers` routes to a CPU fallback) → CPU, where IoBinding just binds host memory.
pub(super) fn device_for_providers(providers: &[Accelerator]) -> (AllocationDevice, i32) {
    match providers.first() {
        Some(Accelerator::DirectMl) => (AllocationDevice::DIRECTML, 0),
        Some(Accelerator::Cuda) => (AllocationDevice::CUDA, 0),
        _ => (AllocationDevice::CPU, 0),
    }
}

/// First (batch) dimension of a tensor value's runtime shape, read from metadata (no host copy).
/// Used to detect the empty `present.*` outputs (shape[0]==0) that mean "reuse the prior KV".
pub(super) fn first_dim(v: &DynValue) -> i64 {
    match v.dtype() {
        ValueType::Tensor { shape, .. } => shape.first().copied().unwrap_or(0),
        _ => 0,
    }
}

/// Read (num_heads, head_dim) for a past_key_values input from the declared graph dims.
/// Whisper exports declare `(batch, num_heads, past_len, head_dim)`; dims 1 & 3 are static.
/// Unknown/dynamic dims → 0, yielding a (0,0,0,0) empty cache ORT accepts as "no past".
pub(super) fn kv_head_dim(decoder: &Session, name: &str) -> (i64, i64) {
    if let Some(outlet) = decoder.inputs().iter().find(|o| o.name() == name) {
        if let ValueType::Tensor { shape, .. } = outlet.dtype() {
            let dims: &[i64] = shape; // Shape derefs to [i64]
            let h = dims.get(1).copied().filter(|&d| d > 0).unwrap_or(0);
            let d = dims.get(3).copied().filter(|&d| d > 0).unwrap_or(0);
            return (h, d);
        }
    }
    (0, 0)
}

/// Read an integer field (e.g. `num_mel_bins`) from a Whisper `config.json`. Tolerant: missing
/// file / key / non-integer → None (caller falls back to a default).
pub(super) fn read_config_usize(config_path: &Path, key: &str) -> Option<usize> {
    let raw = std::fs::read_to_string(config_path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get(key).and_then(|x| x.as_u64()).map(|n| n as usize)
}

/// Read (num_heads, head_dim) from the Whisper `config.json` that sits beside `vocab.json`
/// in the HF snapshot. `head_dim = d_model / decoder_attention_heads`. Used to shape the
/// step-0 empty KV cache when the decoder graph declares those dims symbolically (ort → 0).
pub(super) fn read_whisper_head_dims(vocab_path: &Path) -> Option<(i64, i64)> {
    let cfg_path = vocab_path.parent()?.join("config.json");
    let raw = std::fs::read_to_string(cfg_path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let heads = v.get("decoder_attention_heads").and_then(|x| x.as_i64())?;
    let d_model = v.get("d_model").and_then(|x| x.as_i64())?;
    if heads > 0 && d_model > 0 {
        Some((heads, d_model / heads))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::super::super::{kv_sort_key, provider_label, Accelerator};

    #[test]
    fn kv_sort_orders_by_layer_then_sub() {
        let mut names = [
            "past_key_values.10.encoder.value".to_string(),
            "past_key_values.2.decoder.key".to_string(),
            "past_key_values.2.decoder.value".to_string(),
            "past_key_values.2.encoder.key".to_string(),
        ];
        names.sort_by_key(|n| kv_sort_key(n));
        assert_eq!(names[0], "past_key_values.2.decoder.key");
        assert_eq!(names[1], "past_key_values.2.decoder.value");
        assert_eq!(names[2], "past_key_values.2.encoder.key");
        assert_eq!(names[3], "past_key_values.10.encoder.value");
    }

    #[test]
    fn provider_labels_stable() {
        assert_eq!(
            provider_label(&Accelerator::DirectMl),
            "DmlExecutionProvider"
        );
        assert_eq!(provider_label(&Accelerator::Cpu), "CPUExecutionProvider");
    }
}
