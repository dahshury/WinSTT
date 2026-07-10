// Cohere DirectML spike — proves (or disproves) the "Cohere always crashes on DirectML" pin.
//
// The per-EngineKind DML pin (`EngineKind::is_dml_incompatible`) was derived from ONE export
// (onnx-community, which fuses attention into `com.microsoft.MultiHeadAttention` contrib nodes).
// The hand-converted Masterx Arabic export has ZERO MHA contrib nodes (decomposed attention), so it
// MAY run on DirectML where the fused export crashes. This harness forces the DirectML EP (bypassing
// the CPU override) and drives a real transcribe, wrapped in catch_unwind so an ORT kernel panic is
// reported instead of aborting the process.
//
//   cargo run --release --example cohere_dml_spike
//   COHERE_PROVIDER=dml COHERE_MODEL=cohere-transcribe-arabic COHERE_QUANT= cargo run --release --example cohere_dml_spike
//   COHERE_PROVIDER=cpu  ...                                                  # CPU baseline
//
// Env:
//   COHERE_PROVIDER  cpu | dml            (default dml)
//   COHERE_MODEL     catalog id or owner/repo (default cohere-transcribe-arabic)
//   COHERE_QUANT     "" | int8 | q4 | fp16 | q4f16   (default "")
//   COHERE_AUDIO     raw f32le 16 kHz mono clip (default tools/bench/audio/jfk_short_3s.f32)
//   COHERE_LANG      forced language (default: auto-detect)

use std::path::PathBuf;
use std::time::Instant;

use winstt_app_lib::winstt::stt::resolver::{ResolveRequest, resolve_blocking};
use winstt_app_lib::winstt::stt::{
    Accelerator, EngineConfig, EngineKind, Quantization, TranscribeOptions, build_engine,
};

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key)
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| default.to_string())
}

fn providers_from_env() -> Vec<Accelerator> {
    match std::env::var("COHERE_PROVIDER")
        .unwrap_or_else(|_| "dml".into())
        .to_lowercase()
        .as_str()
    {
        "cpu" => vec![Accelerator::Cpu],
        _ => vec![Accelerator::DirectMl, Accelerator::Cpu],
    }
}

fn quant_from_env() -> Quantization {
    match std::env::var("COHERE_QUANT").unwrap_or_default().as_str() {
        "" | "default" | "fp32" => Quantization::Default,
        other => Quantization::parse(other).unwrap_or(Quantization::Default),
    }
}

// COHERE_AUDIO accepts a comma-separated list; passes cycle through the clips (shape-cache probing:
// alternating lengths reveals whether the DML EP keeps multiple compiled signatures per session).
fn audio_paths() -> Vec<PathBuf> {
    if let Ok(p) = std::env::var("COHERE_AUDIO") {
        return p.split(',').map(PathBuf::from).collect();
    }
    let cwd = PathBuf::from("tools/bench/audio/jfk_short_3s.f32");
    if cwd.exists() {
        return vec![cwd];
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    vec![
        manifest_dir
            .parent()
            .map(|repo| repo.join("tools/bench/audio/jfk_short_3s.f32"))
            .unwrap_or(cwd),
    ]
}

fn load_audio(p: &PathBuf) -> Vec<f32> {
    let bytes = std::fs::read(p).unwrap_or_else(|e| panic!("read audio {}: {e}", p.display()));
    let mut audio: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    let peak = audio.iter().fold(0.0f32, |m, &x| m.max(x.abs()));
    if peak > 0.0 {
        let g = 0.95 / peak;
        for x in &mut audio {
            *x *= g;
        }
    }
    audio
}

fn main() {
    let model_id = env_or("COHERE_MODEL", "cohere-transcribe-arabic");
    let quant = quant_from_env();
    let providers = providers_from_env();
    let lang = std::env::var("COHERE_LANG").ok().filter(|s| !s.is_empty());

    eprintln!("── Cohere DML spike ──");
    eprintln!("model    = {model_id}");
    eprintln!("quant    = {quant:?} (suffix '{}')", quant.suffix());
    eprintln!("providers= {providers:?}");
    for p in audio_paths() {
        eprintln!("audio    = {}", p.display());
    }

    // Resolve the model files from the HF cache (offline-first).
    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    let local_dir = std::env::var("COHERE_LOCAL_DIR")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    if let Some(d) = &local_dir {
        eprintln!("local_dir = {}", d.display());
    }
    let req = ResolveRequest {
        model_id: model_id.clone(),
        kind: EngineKind::CohereAsr,
        effective_quant: quant,
        local_dir,
        local_files_only: true,
    };
    let resolved = match resolve_blocking(rt.handle(), &req) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("RESOLVE FAILED: {e}");
            std::process::exit(2);
        }
    };
    eprintln!(
        "resolved effective quant = {:?}",
        resolved.effective_quantization
    );
    let mut keys: Vec<&String> = resolved.files.keys().collect();
    keys.sort();
    eprintln!("resolved files: {keys:?}");
    // Tier-1 routing verdict on the REAL resolved graph (the function backend::resolve_catalog uses).
    let dml_safe = winstt_app_lib::winstt::stt::cohere_export_dml_safe(&resolved);
    eprintln!(
        "cohere_export_dml_safe = {dml_safe}  → resolve_catalog would {} DirectML",
        if dml_safe {
            "RESTORE"
        } else {
            "keep CPU pin, NOT restore"
        }
    );

    let cfg = EngineConfig {
        model_name: model_id,
        family: "cohere".into(),
        kind: EngineKind::CohereAsr,
        resolved,
        providers,
        whisper_fp16_workaround: false,
        language: None,
    };

    // ── LOAD (session creation is where a DML kernel-registration crash would fire) ──
    let load_start = Instant::now();
    let engine = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| build_engine(cfg)));
    let mut engine = match engine {
        Ok(Ok(e)) => e,
        Ok(Err(e)) => {
            eprintln!("\n❌ LOAD ERROR (SttError): {e}");
            std::process::exit(3);
        }
        Err(_) => {
            eprintln!("\n💥 LOAD PANIC (likely a DirectML kernel crash during session build)");
            std::process::exit(4);
        }
    };
    eprintln!("loaded in {:?}", load_start.elapsed());
    eprintln!("active providers = {:?}", engine.active_providers());

    // ── TRANSCRIBE (the decode loop drives MultiHeadAttention every token) ──
    let clips: Vec<Vec<f32>> = audio_paths().iter().map(load_audio).collect();
    for audio in &clips {
        eprintln!(
            "audio samples = {} ({:.1}s @16k)",
            audio.len(),
            audio.len() as f32 / 16000.0
        );
    }
    let opts = TranscribeOptions {
        language: lang,
        ..Default::default()
    };

    // COHERE_PASSES>1: transcribe N times on the SAME loaded engine → steady-state timing with the
    // one-time DML graph compile excluded (it happens on pass 1). Per-pass wall time printed; use the
    // `[cohere-profile] decode ... avg-rest ms/tok` lines (WINSTT_COHERE_PROFILE=1) for the noise-free
    // per-token metric.
    let passes: usize = std::env::var("COHERE_PASSES")
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|&n| n > 0)
        .unwrap_or(1);
    let mut last_text = String::new();
    for pass in 0..passes {
        let audio = &clips[pass % clips.len()];
        let run_start = Instant::now();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            engine.transcribe(audio, &opts)
        }));
        match result {
            Ok(Ok(t)) => {
                let dt = run_start.elapsed();
                eprintln!("[pass {}/{passes}] {dt:?}", pass + 1);
                last_text = t.text;
                if last_text.trim().is_empty() {
                    eprintln!("⚠️  empty transcript — ran without crashing but produced no text");
                    std::process::exit(5);
                }
            }
            Ok(Err(e)) => {
                eprintln!("\n❌ TRANSCRIBE ERROR (SttError): {e}");
                std::process::exit(6);
            }
            Err(_) => {
                eprintln!("\n💥 TRANSCRIBE PANIC (DirectML kernel crash during decode)");
                std::process::exit(7);
            }
        }
    }
    eprintln!("\n✅ SUCCESS");
    eprintln!("transcript: {last_text:?}");
}
