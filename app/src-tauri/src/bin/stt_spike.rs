// STT de-risking spike (PORT/03 §11). Proves the unified ort-ONNX Whisper engine
// transcribes a real cached model end-to-end. NOT shipped — a `cargo run --bin stt_spike`
// harness only.
//
//   cargo run --release --bin stt_spike            # default: whisper-tiny.en
//   cargo run --release --bin stt_spike -- <hf_snapshot_dir> [n_mels] [lang]
//
// Audio: app/src-tauri/jfk_16k_mono.f32 (raw f32le 16 kHz mono, pre-decoded from
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

const DEFAULT_SNAP: &str = "C:/Users/MASTE/.cache/huggingface/hub/models--onnx-community--whisper-tiny.en/snapshots/2575352d61be1bf7225cf8f8b268a4678025fc58";

fn load_audio() -> Vec<f32> {
    let audio_path = std::path::PathBuf::from("jfk_16k_mono.f32");
    let audio_path = if audio_path.exists() {
        audio_path
    } else {
        PathBuf::from("E:/DL/Projects/WinSTT/app/src-tauri/jfk_16k_mono.f32")
    };
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
        providers: vec![Accelerator::Cpu],
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
    match engine.transcribe(&audio, &TranscribeOptions::default()) {
        Ok(out) => println!("\n=== CATALOG TRANSCRIPT ({cat_id}) ===\n{}\n==================", out.text),
        Err(e) => {
            eprintln!("TRANSCRIBE FAILED: {e}");
            std::process::exit(6);
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
    let snap = args.get(1).cloned().unwrap_or_else(|| DEFAULT_SNAP.to_string());
    let n_mels = args.get(2).and_then(|s| s.parse::<usize>().ok()).unwrap_or(80);
    let lang = args.get(3).cloned().unwrap_or_else(|| "en".to_string());

    eprintln!("=== STT SPIKE ===");
    eprintln!("snapshot : {snap}");
    eprintln!("n_mels   : {n_mels}");
    eprintln!("language : {lang}");

    // ---- 1. load audio (raw f32le 16k mono) ----
    let audio_path = PathBuf::from("jfk_16k_mono.f32");
    let audio_path = if audio_path.exists() {
        audio_path
    } else {
        // when run from repo root / target dir, fall back to the absolute path
        PathBuf::from("E:/DL/Projects/WinSTT/app/src-tauri/jfk_16k_mono.f32")
    };
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
        providers: vec![Accelerator::Cpu],
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
    let t1 = Instant::now();
    match engine.transcribe(&audio, &opts) {
        Ok(out) => {
            eprintln!("transcribed in {:?}", t1.elapsed());
            println!("\n=== TRANSCRIPT ===\n{}\n==================", out.text);
        }
        Err(e) => {
            eprintln!("TRANSCRIBE FAILED: {e}");
            std::process::exit(3);
        }
    }
}
