// ORT session construction for the Whisper engine + the fp16 merged-decoder export repair.
// Pure functions taking path/cfg/intra; split out of `whisper.rs` (engine state stays there).

#![allow(dead_code)]

use std::path::Path;

use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;

use super::super::{execution_providers, Accelerator, EngineConfig, SttError, SttResult};

/// Build one ORT session with the resolved providers + thread count. `is_whisper_fp16`
/// lowers the optimization level to EXTENDED (Level2) to dodge `SimplifiedLayerNormFusion`
/// mis-fusing the fp16 encoder (§6.2).
pub(super) fn build_session(
    path: &Path,
    cfg: &EngineConfig,
    intra: usize,
    is_whisper_fp16: bool,
) -> SttResult<Session> {
    let level = if is_whisper_fp16 {
        GraphOptimizationLevel::Level2 // = ORT_ENABLE_EXTENDED (dodges SimplifiedLayerNormFusion)
    } else {
        GraphOptimizationLevel::All // = ORT_ENABLE_ALL (Level3 is layout-only, NOT "all")
    };
    let mut builder = Session::builder()
        .map_err(|e| SttError::SessionCreate(format!("session builder: {e}")))?
        .with_execution_providers(execution_providers(&cfg.providers))
        .map_err(|e| SttError::SessionCreate(format!("set providers: {e}")))?
        .with_optimization_level(level)
        .map_err(|e| SttError::SessionCreate(format!("opt level: {e}")))?
        .with_intra_threads(intra)
        .map_err(|e| SttError::SessionCreate(format!("intra threads: {e}")))?;
    // DirectML session config (L1): disable the memory-pattern planner on the GPU path. ORT's DML
    // EP manages its own device memory (DisableMemPattern + ORT_SEQUENTIAL are required), and our
    // Whisper KV-cache decode binds device-resident tensors via IoBinding — the mem-pattern planner
    // assumes host-side static reuse and fights that. Parallel exec is already Sequential by default.
    let is_gpu = cfg
        .providers
        .first()
        .is_some_and(|p| !matches!(p, Accelerator::Cpu));
    if is_gpu {
        builder = builder
            .with_memory_pattern(false)
            .map_err(|e| SttError::SessionCreate(format!("disable mem pattern (DML): {e}")))?;
    }
    builder
        .commit_from_file(path)
        .map_err(|e| SttError::SessionCreate(format!("commit {}: {e}", path.display())))
}

/// Load the merged decoder, recovering from the fp16-export defect (§6.1): on the fp16
/// subgraph-dtype error, surgically patch the `.onnx` in place and retry ONCE.
pub(super) fn load_decoder_with_fp16_repair(
    path: &Path,
    cfg: &EngineConfig,
    intra: usize,
) -> SttResult<Session> {
    match build_session(path, cfg, intra, cfg.whisper_fp16_workaround) {
        Ok(s) => Ok(s),
        Err(e) if cfg.whisper_fp16_workaround && is_fp16_decoder_error(&e) => {
            patch_whisper_decoder_fp16(path).map_err(|pe| {
                SttError::SessionCreate(format!("fp16 decoder patch failed: {pe}"))
            })?;
            build_session(path, cfg, intra, true)
        }
        Err(e) => Err(e),
    }
}

/// True if a session-create error matches the fp16 merged-decoder subgraph defect
/// (`onnxasr_transcriber._FP16_DECODER_LOAD_ERROR`): the "outer scope value ... float vs
/// float16" type mismatch ORT raises at create.
pub(super) fn is_fp16_decoder_error(e: &SttError) -> bool {
    let msg = e.to_string().to_lowercase();
    // Format A — dtype mismatch: "...float16... (type|subgraph|outer scope)...".
    let dtype_mismatch = (msg.contains("float16") || msg.contains("fp16"))
        && (msg.contains("type") || msg.contains("subgraph") || msg.contains("outer scope"));
    // Format B — structural (ORT 1.18+): "Subgraph output '...' is an outer scope value being
    // returned directly" (no dtype token). Folded in from the former
    // `fp16_patch::fp16_decoder_path_from_error` so BOTH ORT phrasings trigger the patch + retry.
    let structural = msg.contains("subgraph output") && msg.contains("outer scope value");
    dtype_mismatch || structural
}

/// Repair the Whisper fp16 merged-decoder export defect in place, delegating to
/// `winstt::stt::fp16_patch::patch_fp16_decoder`: it parses the ONNX protobuf, rewrites each
/// `If`-subgraph output's name + dtype (fp32→fp16) to match the parent `If`, writes the file back,
/// and is marker-guarded + idempotent. The caller then retries `build_session` on the same
/// (now-patched) path. A clean export yields 0 edits and still returns `Ok`.
pub(super) fn patch_whisper_decoder_fp16(path: &Path) -> Result<(), String> {
    crate::winstt::stt::fp16_patch::patch_fp16_decoder(path)
        .map(|_patched| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fp16_error_classifier() {
        let yes = SttError::SessionCreate(
            "Type Error: outer scope value 'present.0' float vs float16 in subgraph".into(),
        );
        assert!(is_fp16_decoder_error(&yes));
        // Format B — structural (ORT 1.18+) phrasing, no dtype token.
        let structural = SttError::SessionCreate(
            "Subgraph output 'logits' is an outer scope value being returned directly".into(),
        );
        assert!(is_fp16_decoder_error(&structural));
        let no = SttError::SessionCreate("file not found".into());
        assert!(!is_fp16_decoder_error(&no));
    }
}
