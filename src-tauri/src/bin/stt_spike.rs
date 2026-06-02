// STT de-risking spike (PORT/03 §11). Proves the unified ort-ONNX Whisper engine
// transcribes a real cached model end-to-end. NOT shipped — a `cargo run --bin stt_spike`
// harness only.
//
//   cargo run --release --bin stt_spike            # default: whisper-tiny.en, CPU
//   cargo run --release --bin stt_spike -- <hf_snapshot_dir> [n_mels] [lang]
//   SPIKE_PROVIDER=dml cargo run --release --bin stt_spike   # measure the DirectML/GPU path
//
// Audio: src-tauri/jfk_16k_mono.f32 (raw f32le 16 kHz mono, pre-decoded from
//   examples/faster-whisper/tests/data/jfk.flac via ffmpeg). Expected transcript:
//   "And so my fellow Americans, ask not what your country can do for you, ask what
//    you can do for your country."

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Instant;

use handy_app_lib::winstt::stt::{
    Accelerator, EngineConfig, EngineKind, Quantization, ResolvedModel, TranscribeOptions,
    Transcriber, WhisperEngine,
};

/// Default snapshot: the whisper-tiny.en hf-hub cache dir on this machine.
/// Derived from `HF_HOME`/`HF_HUB_CACHE` (or `$HOME/.cache/huggingface/hub`)
/// instead of a hardcoded absolute path so the spike isn't pinned to one
/// machine's layout. The trailing snapshot hash can vary across re-downloads,
/// so we glob the `snapshots/` dir and pick the first entry. Falls back to
/// the canonical relative path string when nothing is cached (the run then
/// fails loudly in `WhisperEngine::load`, same as before).
fn default_snap() -> String {
    let hub = std::env::var("HF_HUB_CACHE")
        .map(PathBuf::from)
        .or_else(|_| std::env::var("HF_HOME").map(|h| PathBuf::from(h).join("hub")))
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .unwrap_or_default();
            PathBuf::from(home).join(".cache/huggingface/hub")
        });
    let snapshots = hub
        .join("models--onnx-community--whisper-tiny.en")
        .join("snapshots");
    if let Ok(entries) = std::fs::read_dir(&snapshots) {
        let first_dir = entries
            .flatten()
            .map(|e| e.path())
            .find(|p| p.is_dir());
        if let Some(dir) = first_dir {
            return dir.to_string_lossy().into_owned();
        }
    }
    snapshots.join("<snapshot-hash>").to_string_lossy().into_owned()
}

/// Provider selection for the spike, via `SPIKE_PROVIDER` (cpu|dml|cuda; default cpu).
/// DirectML/CUDA fall back to CPU inside `execution_providers()` if the EP isn't present,
/// so the spike still runs; the active-providers print tells you what actually bound.
fn providers_from_env() -> Vec<Accelerator> {
    match std::env::var("SPIKE_PROVIDER").unwrap_or_default().to_lowercase().as_str() {
        "dml" | "directml" => vec![Accelerator::DirectMl, Accelerator::Cpu],
        "cuda" => vec![Accelerator::Cuda, Accelerator::Cpu],
        _ => vec![Accelerator::Cpu],
    }
}

/// Locate the pre-decoded test audio. Prefers `jfk_16k_mono.f32` in the CWD
/// (when run from the crate dir) and falls back to the file next to the
/// crate manifest (`CARGO_MANIFEST_DIR/jfk_16k_mono.f32`) so the spike works
/// regardless of where it's launched from — no machine-specific absolute path.
fn audio_path() -> PathBuf {
    let cwd = PathBuf::from("jfk_16k_mono.f32");
    if cwd.exists() {
        cwd
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("jfk_16k_mono.f32")
    }
}

fn load_audio() -> Vec<f32> {
    let audio_path = audio_path();
    let bytes = std::fs::read(&audio_path).expect("read jfk_16k_mono.f32");
    let mut audio: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    let peak = audio.iter().fold(0.0f32, |m, &x| m.max(x.abs()));
    if peak > 0.0 {
        let g = 0.95 / peak;
        for x in audio.iter_mut() {
            *x *= g;
        }
    }
    audio
}

/// Catalog `Family` → the policy slug the engine helpers key on.
fn family_slug_of(family: handy_app_lib::winstt::catalog::Family) -> &'static str {
    use handy_app_lib::winstt::catalog::Family;
    match family {
        Family::Whisper => "whisper",
        Family::Moonshine => "moonshine",
        Family::Cohere => "cohere",
        Family::Nemo => "nemo",
        Family::SenseVoice => "sense_voice",
        Family::GigaAm => "gigaam",
        Family::Kaldi => "kaldi",
        Family::TOne => "t-one",
        Family::Dolphin => "dolphin",
        Family::Custom => "custom",
    }
}

/// Catalog mode — exercises the EXACT path `TranscriptionManager::load_winstt_model` uses:
/// `catalog::find(id)` → `resolver::resolve` (cache-only) → `build_engine` → `transcribe`.
/// Proves the resolver wires the right files (incl. config-derived n_mels) for a real catalog id.
fn run_catalog_mode(cat_id: &str) {
    use handy_app_lib::winstt::catalog;
    use handy_app_lib::winstt::stt::resolver::{self, ResolveRequest};
    use handy_app_lib::winstt::stt::build_engine;

    let entry = catalog::find(cat_id).unwrap_or_else(|| panic!("catalog id '{cat_id}' not found"));
    let family_slug = family_slug_of(entry.family);
    let kind = handy_app_lib::winstt::stt::cache_probe::engine_kind_for(
        entry.id,
        family_slug,
        entry.onnx_model_name,
    );
    eprintln!("=== CATALOG MODE ===");
    eprintln!("catalog id : {cat_id}");
    eprintln!("repo       : {} (family {:?} -> {:?})", entry.onnx_model_name, entry.family, kind);

    // Download if not cached (family models often aren't pre-cached); cache-first when present.
    let local_files_only = std::env::var("SPIKE_CACHE_ONLY").is_ok();
    let req = ResolveRequest {
        model_id: entry.onnx_model_name.to_string(),
        kind,
        effective_quant: Quantization::Default,
        local_dir: None,
        local_files_only,
    };
    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    let resolved = match rt.block_on(resolver::resolve(&req)) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("RESOLVE FAILED: {e}");
            std::process::exit(4);
        }
    };
    let mut keys: Vec<&String> = resolved.files.keys().collect();
    keys.sort();
    eprintln!("resolved   : {} files {:?}", resolved.files.len(), keys);

    let cfg = EngineConfig {
        model_name: cat_id.to_string(),
        family: family_slug.to_string(),
        kind,
        resolved,
        providers: providers_from_env(),
        whisper_fp16_workaround: false,
    };
    let mut engine = match build_engine(cfg) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("BUILD FAILED: {e}");
            std::process::exit(5);
        }
    };
    let audio = load_audio();
    // cold pass (DML compiles kernels on first inference) then warm pass (steady-state).
    for (label, _) in [("cold", ()), ("warm", ())] {
        let t = Instant::now();
        match engine.transcribe(&audio, &TranscribeOptions::default()) {
            Ok(out) => println!(
                "\n=== CATALOG TRANSCRIPT ({cat_id}, {label} {:?}) ===\n{}\n==================",
                t.elapsed(),
                out.text
            ),
            Err(e) => {
                eprintln!("TRANSCRIBE FAILED: {e}");
                std::process::exit(6);
            }
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    // Catalog mode: `stt_spike --catalog <catalog_id>` (verifies the resolver→engine path).
    if args.get(1).map(|s| s == "--catalog").unwrap_or(false) {
        let cat_id = args.get(2).cloned().unwrap_or_else(|| "tiny.en".to_string());
        run_catalog_mode(&cat_id);
        return;
    }
    let snap = args.get(1).cloned().unwrap_or_else(default_snap);
    let n_mels = args.get(2).and_then(|s| s.parse::<usize>().ok()).unwrap_or(80);
    let lang = args.get(3).cloned().unwrap_or_else(|| "en".to_string());

    eprintln!("=== STT SPIKE ===");
    eprintln!("snapshot : {snap}");
    eprintln!("n_mels   : {n_mels}");
    eprintln!("language : {lang}");

    // ---- 1. load audio (raw f32le 16k mono) ----
    let audio_path = audio_path();
    let bytes = std::fs::read(&audio_path).expect("read jfk_16k_mono.f32");
    let mut audio: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    eprintln!("audio    : {} samples ({:.2}s)", audio.len(), audio.len() as f32 / 16_000.0);

    // peak-normalize to 0.95 (the coordinator's single chokepoint; engines expect conditioned audio)
    let peak = audio.iter().fold(0.0f32, |m, &x| m.max(x.abs()));
    if peak > 0.0 {
        let g = 0.95 / peak;
        for x in audio.iter_mut() {
            *x *= g;
        }
    }
    eprintln!("peak     : {peak:.4} -> normalized to 0.95");

    // ---- 2. build engine config ----
    let mut files: BTreeMap<String, PathBuf> = BTreeMap::new();
    files.insert("encoder".into(), PathBuf::from(format!("{snap}/onnx/encoder_model.onnx")));
    files.insert("decoder".into(), PathBuf::from(format!("{snap}/onnx/decoder_model_merged.onnx")));
    files.insert("vocab".into(), PathBuf::from(format!("{snap}/vocab.json")));
    let added = PathBuf::from(format!("{snap}/added_tokens.json"));
    if added.exists() {
        files.insert("added_tokens".into(), added);
    }
    files.insert("num_mel_bins".into(), PathBuf::from(n_mels.to_string()));

    for (k, v) in &files {
        if k != "num_mel_bins" && !v.exists() {
            eprintln!("!! MISSING resolved file '{k}' -> {}", v.display());
        }
    }

    let cfg = EngineConfig {
        model_name: snap.clone(),
        family: "whisper".into(),
        kind: EngineKind::WhisperHf,
        resolved: ResolvedModel { files, effective_quantization: Quantization::Default },
        providers: providers_from_env(),
        whisper_fp16_workaround: false,
    };

    // ---- 3. load ----
    let t0 = Instant::now();
    let mut engine = match WhisperEngine::load(&cfg) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("LOAD FAILED: {e}");
            std::process::exit(2);
        }
    };
    eprintln!("loaded in {:?}; providers={:?}", t0.elapsed(), engine.active_providers());
    eprintln!("word-ts capable: {}", engine.supports_word_timestamps());

    // ---- 4. transcribe ----
    let opts = TranscribeOptions {
        language: if lang.is_empty() { None } else { Some(lang) },
        ..Default::default()
    };
    // Multiple passes on the SAME engine — production reuses one engine across every dictation,
    // so passes 2..N must match pass 1 (catches device-value lifecycle bugs across transcribe()).
    for label in ["run1", "run2", "run3"] {
        let t1 = Instant::now();
        match engine.transcribe(&audio, &opts) {
            Ok(out) => {
                eprintln!("transcribed ({label}) in {:?}", t1.elapsed());
                println!("\n=== TRANSCRIPT ({label}) ===\n{}\n==================", out.text);
            }
            Err(e) => {
                eprintln!("TRANSCRIBE FAILED: {e}");
                std::process::exit(3);
            }
        }
    }
}
