// Generic per-model DirectML spike — the harness behind the per-EngineKind DML pin audit.
//
// Same pattern as `cohere_dml_spike.rs` but model-agnostic: resolves ANY catalog id through the
// real catalog + resolver (offline-first), builds the real engine with a FORCED provider list
// (bypassing `override_dml_to_cpu_for_kind`), and drives a real transcribe inside catch_unwind so
// a DML kernel crash is reported instead of aborting. Used to (in)validate every entry in
// `EngineKind::is_dml_incompatible`.
//
//   SPIKE_PROVIDER=dml SPIKE_MODEL=nemo-canary-180m-flash cargo run --release --example stt_dml_spike
//
// Env:
//   SPIKE_PROVIDER  cpu | dml                          (default dml)
//   SPIKE_MODEL     catalog id                          (default nemo-canary-180m-flash)
//   SPIKE_QUANT     "" | fp16 | int8 | q4 | ...         (default "" = fp32/auto)
//   SPIKE_AUDIO     raw f32le 16 kHz mono clip          (default tools/bench/audio/jfk_short_3s.f32)
//   SPIKE_LANG      language hint                       (default en)
//   SPIKE_TIMEOUT_S watchdog seconds before declaring a HANG and aborting (default 120)

use std::path::PathBuf;
use std::time::Instant;

use winstt_app_lib::winstt::catalog;
use winstt_app_lib::winstt::stt::resolver::{ResolveRequest, resolve_blocking};
use winstt_app_lib::winstt::stt::{
    Accelerator, EngineConfig, Quantization, TranscribeOptions, build_engine, cache_probe,
};

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key)
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| default.to_string())
}

fn providers_from_env() -> Vec<Accelerator> {
    match env_or("SPIKE_PROVIDER", "dml").to_lowercase().as_str() {
        "cpu" => vec![Accelerator::Cpu],
        _ => vec![Accelerator::DirectMl, Accelerator::Cpu],
    }
}

fn audio_path() -> PathBuf {
    if let Ok(p) = std::env::var("SPIKE_AUDIO") {
        return PathBuf::from(p);
    }
    let cwd = PathBuf::from("tools/bench/audio/jfk_short_3s.f32");
    if cwd.exists() {
        return cwd;
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .map(|repo| repo.join("tools/bench/audio/jfk_short_3s.f32"))
        .unwrap_or(cwd)
}

fn load_audio() -> Vec<f32> {
    let p = audio_path();
    let bytes = std::fs::read(&p).unwrap_or_else(|e| panic!("read audio {}: {e}", p.display()));
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
    let model_arg = env_or("SPIKE_MODEL", "nemo-canary-180m-flash");
    let model_id = catalog::canonical_model_id(&model_arg);
    let providers = providers_from_env();
    let lang = Some(env_or("SPIKE_LANG", "en"));
    let quant = match std::env::var("SPIKE_QUANT").unwrap_or_default().as_str() {
        "" | "default" | "fp32" => Quantization::Default,
        other => Quantization::parse(other).unwrap_or(Quantization::Default),
    };
    let watchdog_s: u64 = env_or("SPIKE_TIMEOUT_S", "120").parse().unwrap_or(120);

    let Some(entry) = catalog::find(model_id) else {
        eprintln!("model '{model_id}' not in catalog");
        std::process::exit(2);
    };
    let kind = cache_probe::engine_kind_for(entry.id, entry.family.as_str(), entry.onnx_model_name);

    eprintln!("── STT DML spike ──");
    eprintln!(
        "model    = {model_id} (kind {kind:?}, family {})",
        entry.family.as_str()
    );
    eprintln!("quant    = {quant:?}");
    eprintln!("providers= {providers:?}");
    eprintln!("audio    = {}", audio_path().display());

    // HANG watchdog: several sherpa-class graphs are pinned for a silent DML hang — a plain spike
    // would block forever. A detached thread turns "no verdict after N seconds" into a loud abort.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(watchdog_s));
        eprintln!("\n⏰ HANG: no verdict after {watchdog_s}s — aborting (DML hang reproduced)");
        std::process::exit(9);
    });

    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    let local_dir = std::env::var("SPIKE_LOCAL_DIR")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    if let Some(d) = &local_dir {
        eprintln!("local_dir = {}", d.display());
    }
    let req = ResolveRequest {
        model_id: entry.onnx_model_name.to_string(),
        kind,
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
    eprintln!("resolved quant = {:?}", resolved.effective_quantization);
    let mut keys: Vec<&String> = resolved.files.keys().collect();
    keys.sort();
    eprintln!("resolved files: {keys:?}");

    let cfg = EngineConfig {
        model_name: model_id.to_string(),
        family: entry.family.as_str().to_string(),
        kind,
        resolved,
        providers,
        whisper_fp16_workaround: false,
        language: None,
    };

    let load_start = Instant::now();
    let engine = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| build_engine(cfg)));
    let mut engine = match engine {
        Ok(Ok(e)) => e,
        Ok(Err(e)) => {
            eprintln!("\n❌ LOAD ERROR (SttError): {e}");
            std::process::exit(3);
        }
        Err(_) => {
            eprintln!("\n💥 LOAD PANIC (DML kernel crash during session build)");
            std::process::exit(4);
        }
    };
    eprintln!("loaded in {:?}", load_start.elapsed());
    eprintln!("active providers = {:?}", engine.active_providers());

    let audio = load_audio();
    eprintln!(
        "audio samples = {} ({:.1}s @16k)",
        audio.len(),
        audio.len() as f32 / 16000.0
    );
    let opts = TranscribeOptions {
        language: lang,
        ..Default::default()
    };

    // SPIKE_PASSES>1 → warm multi-pass; reports min-of-N (the cohere lesson: a single cold pass
    // includes EP fusion/allocation and mis-ranks providers).
    let passes: usize = env_or("SPIKE_PASSES", "1").parse().unwrap_or(1);
    let mut best = std::time::Duration::MAX;
    let mut result = None;
    for i in 0..passes {
        let run_start = Instant::now();
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            engine.transcribe(&audio, &opts)
        }));
        let dt = run_start.elapsed();
        eprintln!("pass {}/{passes}: {dt:?}", i + 1);
        if dt < best {
            best = dt;
        }
        result = Some(r);
    }
    let result = result.expect("at least one pass");
    match result {
        Ok(Ok(t)) => {
            eprintln!("\n✅ SUCCESS min-of-{passes} = {best:?}");
            eprintln!("transcript: {:?}", t.text);
            if t.text.trim().is_empty() {
                eprintln!("⚠️  empty transcript — ran but produced no text");
                std::process::exit(5);
            }
        }
        Ok(Err(e)) => {
            eprintln!("\n❌ TRANSCRIBE ERROR (SttError): {e}");
            std::process::exit(6);
        }
        Err(_) => {
            eprintln!("\n💥 TRANSCRIBE PANIC (DML kernel crash during decode)");
            std::process::exit(7);
        }
    }
}
