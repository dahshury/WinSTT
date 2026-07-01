// STT decode benchmark (PORT/03 §11). Proves the unified ort-ONNX Whisper engine
// transcribes a real cached model end-to-end. NOT shipped — a `cargo run --example stt_decode_bench`
// harness only.
//
//   cargo run --release --example stt_decode_bench            # default: whisper-tiny.en, CPU
//   cargo run --release --example stt_decode_bench -- <hf_snapshot_dir> [n_mels] [lang]
//   STT_BENCH_PROVIDER=dml cargo run --release --example stt_decode_bench   # measure the DirectML/GPU path
//
// Audio: tools/bench/audio/jfk_short_3s.f32 (raw f32le 16 kHz mono, pre-decoded from
//   examples/faster-whisper/tests/data/jfk.flac via ffmpeg). Expected transcript:
//   "And so my fellow Americans, ask not what your country can do for you, ask what
//    you can do for your country."

use std::collections::BTreeMap;
use std::io::{self, Write};
use std::path::PathBuf;
use std::time::Instant;

use log::{LevelFilter, Metadata, Record};
use winstt_app_lib::audio_toolkit::vad::{SileroVad, VAD_SPEECH_THRESHOLD};
use winstt_app_lib::winstt::stt::{
    Accelerator, EngineConfig, EngineKind, Quantization, ResolvedModel, SttError,
    TranscribeOptions, Transcriber, WhisperEngine,
};

struct BenchLogger;

static STT_BENCH_LOGGER: BenchLogger = BenchLogger;

impl log::Log for BenchLogger {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        metadata.level() <= log::max_level()
    }

    fn log(&self, record: &Record<'_>) {
        if self.enabled(record.metadata()) {
            eprintln!("[{}] {}", record.level(), record.args());
        }
    }

    fn flush(&self) {}
}

fn init_bench_logger() {
    let level = std::env::var("STT_BENCH_LOG")
        .or_else(|_| std::env::var("RUST_LOG"))
        .ok()
        .and_then(|level| match level.trim().to_ascii_lowercase().as_str() {
            "off" => Some(LevelFilter::Off),
            "error" => Some(LevelFilter::Error),
            "warn" | "warning" => Some(LevelFilter::Warn),
            "info" => Some(LevelFilter::Info),
            "debug" => Some(LevelFilter::Debug),
            "trace" => Some(LevelFilter::Trace),
            _ => None,
        })
        .unwrap_or(LevelFilter::Warn);
    if log::set_logger(&STT_BENCH_LOGGER).is_ok() {
        log::set_max_level(level);
    }
}

/// Default snapshot: the whisper-tiny.en hf-hub cache dir on this machine.
/// Derived from `HF_HOME`/`HF_HUB_CACHE` (or `$HOME/.cache/huggingface/hub`)
/// instead of a hardcoded absolute path so the benchmark isn't pinned to one
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
        let first_dir = entries.flatten().map(|e| e.path()).find(|p| p.is_dir());
        if let Some(dir) = first_dir {
            return dir.to_string_lossy().into_owned();
        }
    }
    snapshots
        .join("<snapshot-hash>")
        .to_string_lossy()
        .into_owned()
}

/// Provider selection for the benchmark, via `STT_BENCH_PROVIDER` (cpu|dml|cuda; default cpu).
/// DirectML/CUDA fall back to CPU inside `execution_providers()` if the EP isn't present,
/// so the benchmark still runs; the active-providers print tells you what actually bound.
fn providers_from_env() -> Vec<Accelerator> {
    match std::env::var("STT_BENCH_PROVIDER")
        .unwrap_or_default()
        .to_lowercase()
        .as_str()
    {
        "dml" | "directml" => vec![Accelerator::DirectMl, Accelerator::Cpu],
        "cuda" => vec![Accelerator::Cuda, Accelerator::Cpu],
        _ => vec![Accelerator::Cpu],
    }
}

fn bench_passes(default: usize) -> usize {
    std::env::var("STT_BENCH_PASSES")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(default)
}

/// Locate the pre-decoded test audio. Prefers an explicit `STT_BENCH_AUDIO`, then
/// the repo benchmark fixture so the benchmark works regardless of where it's
/// launched from — no machine-specific absolute path.
fn audio_path() -> PathBuf {
    // BENCH override: `STT_BENCH_AUDIO` points at any raw f32le 16 kHz mono clip (short/
    // long/varied) so the same harness can stress the engine on real long-form audio.
    if let Ok(p) = std::env::var("STT_BENCH_AUDIO") {
        return PathBuf::from(p);
    }
    let cwd = PathBuf::from("tools/bench/audio/jfk_short_3s.f32");
    if cwd.exists() {
        cwd
    } else {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        manifest_dir.parent().map_or_else(
            || manifest_dir.join("jfk_short_3s.f32"),
            |repo| repo.join("tools/bench/audio/jfk_short_3s.f32"),
        )
    }
}

fn load_audio() -> Vec<f32> {
    let audio_path = audio_path();
    let bytes = std::fs::read(&audio_path).expect("read benchmark audio");
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

fn resolved_from_snapshot_dir(
    dir: PathBuf,
    kind: EngineKind,
    effective_quant: Quantization,
) -> Result<ResolvedModel, String> {
    fn quantized_path(dir: &std::path::Path, stem: &str, effective_quant: Quantization) -> PathBuf {
        match effective_quant {
            Quantization::Default => dir.join(format!("{stem}.onnx")),
            quant => dir.join(format!("{stem}.{}.onnx", quant.suffix())),
        }
    }

    fn insert_existing(
        files: &mut BTreeMap<String, PathBuf>,
        key: &str,
        path: PathBuf,
    ) -> Result<(), String> {
        if !path.exists() {
            return Err(format!(
                "snapshot file for key '{key}' not found: {}",
                path.display()
            ));
        }
        files.insert(key.to_string(), path);
        Ok(())
    }

    let mut files = BTreeMap::new();
    match kind {
        EngineKind::NemoRnnt | EngineKind::NemoTdt => {
            insert_existing(
                &mut files,
                "encoder",
                quantized_path(&dir, "encoder-model", effective_quant),
            )?;
            insert_existing(
                &mut files,
                "decoder_joint",
                quantized_path(&dir, "decoder_joint-model", effective_quant),
            )?;
            insert_existing(&mut files, "vocab", dir.join("vocab.txt"))?;
            let config = dir.join("config.json");
            if config.exists() {
                files.insert("config".to_string(), config);
            }
        }
        _ => {
            return Err(format!(
                "STT_BENCH_SNAPSHOT_DIR override is not wired for {kind:?}; use the resolver path"
            ));
        }
    }

    Ok(ResolvedModel {
        files,
        effective_quantization: effective_quant,
    })
}

/// Catalog `Family` → the policy slug the engine helpers key on.
fn family_slug_of(family: winstt_app_lib::winstt::catalog::Family) -> &'static str {
    use winstt_app_lib::winstt::catalog::Family;
    match family {
        Family::Whisper => "whisper",
        Family::Moonshine => "moonshine",
        Family::Cohere => "cohere",
        Family::Granite => "granite",
        Family::Nemo => "nemo",
        Family::SenseVoice => "sense_voice",
        Family::GigaAm => "gigaam",
        Family::Kaldi => "kaldi",
        Family::TOne => "t-one",
        Family::Dolphin => "dolphin",
        Family::Qwen3 => "qwen3",
        Family::Custom => "custom",
    }
}

/// Catalog mode — exercises the EXACT path `TranscriptionManager::load_winstt_model` uses:
/// `catalog::find(id)` → `resolver::resolve` (cache-only) → `build_engine` → `transcribe`.
/// Proves the resolver wires the right files (incl. config-derived n_mels) for a real catalog id.
fn run_catalog_mode(cat_id: &str) {
    use winstt_app_lib::winstt::catalog;
    use winstt_app_lib::winstt::stt::build_engine;
    use winstt_app_lib::winstt::stt::resolver::{self, ResolveRequest};

    let entry = catalog::find(cat_id).unwrap_or_else(|| panic!("catalog id '{cat_id}' not found"));
    let family_slug = family_slug_of(entry.family);
    let kind = winstt_app_lib::winstt::stt::cache_probe::engine_kind_for(
        entry.id,
        family_slug,
        entry.onnx_model_name,
    );
    eprintln!("=== CATALOG MODE ===");
    eprintln!("catalog id : {cat_id}");
    eprintln!(
        "repo       : {} (family {:?} -> {:?})",
        entry.onnx_model_name, entry.family, kind
    );

    // Download if not cached (family models often aren't pre-cached); cache-first when present.
    let local_files_only = std::env::var("STT_BENCH_CACHE_ONLY").is_ok();
    // STT_BENCH_QUANT overrides the resolved quantization so we can A/B fp32 vs int8 (and match the
    // prod Auto→int8 path the app actually loads for NeMo/Cohere/etc.). Default = fp32 ("").
    let effective_quant = match std::env::var("STT_BENCH_QUANT")
        .unwrap_or_default()
        .to_lowercase()
        .as_str()
    {
        "int8" => Quantization::Int8,
        "fp16" => Quantization::Fp16,
        "fp16w" => Quantization::Fp16w,
        "q4" => Quantization::Q4,
        "q4f16" => Quantization::Q4f16,
        "bnb4" => Quantization::Bnb4,
        "uint8" => Quantization::Uint8,
        _ => Quantization::Default,
    };
    eprintln!("quant      : {effective_quant:?} (STT_BENCH_QUANT env)");
    let resolved = if let Ok(snapshot_dir) = std::env::var("STT_BENCH_SNAPSHOT_DIR") {
        let snapshot_dir = PathBuf::from(snapshot_dir);
        eprintln!("snapshot  : {}", snapshot_dir.display());
        match resolved_from_snapshot_dir(snapshot_dir, kind, effective_quant) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("SNAPSHOT RESOLVE FAILED: {e}");
                std::process::exit(4);
            }
        }
    } else {
        let req = ResolveRequest {
            model_id: entry.onnx_model_name.to_string(),
            kind,
            effective_quant,
            local_dir: None,
            local_files_only,
        };
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        match rt.block_on(resolver::resolve(&req)) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("RESOLVE FAILED: {e}");
                std::process::exit(4);
            }
        }
    };
    let mut keys: Vec<&String> = resolved.files.keys().collect();
    keys.sort();
    eprintln!("resolved   : {} files {:?}", resolved.files.len(), keys);

    // Mirror prod (backend.rs): the fp16 ORT_ENABLE_EXTENDED downgrade is gated on the whisper
    // family AND fp16. Without it, fp16 whisper encoders fail to commit (graph-fusion error), so
    // catalog-mode fp16 A/B runs couldn't load at all.
    let whisper_fp16_workaround = family_slug == "whisper" && effective_quant == Quantization::Fp16;
    let cfg = EngineConfig {
        model_name: cat_id.to_string(),
        family: family_slug.to_string(),
        kind,
        resolved,
        providers: providers_from_env(),
        whisper_fp16_workaround,
    };
    let build_started = Instant::now();
    let mut engine = match build_engine(cfg) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("BUILD FAILED: {e}");
            std::process::exit(5);
        }
    };
    eprintln!(
        "engine    : built in {} ms active_providers={:?}",
        build_started.elapsed().as_millis(),
        engine.active_providers()
    );
    let audio = load_audio();
    eprintln!(
        "audio      : {} samples ({:.2}s)",
        audio.len(),
        audio.len() as f32 / 16_000.0
    );
    let segment = std::env::var("STT_BENCH_SEGMENT").is_ok();
    let segment_max_s = std::env::var("STT_BENCH_SEGMENT_MAX")
        .ok()
        .and_then(|s| s.parse::<f32>().ok())
        .filter(|&s| s > 0.0)
        .unwrap_or(28.0);
    if segment {
        eprintln!("segment   : vad max_chunk_s={segment_max_s:.1}");
    }
    let segment_prior = std::env::var("STT_BENCH_SEGMENT_PRIOR").map_or_else(
        |_| kind.needs_past_context(),
        |s| {
            !matches!(
                s.trim().to_ascii_lowercase().as_str(),
                "0" | "false" | "off"
            )
        },
    );
    if segment {
        eprintln!("prior     : {segment_prior}");
    }
    let profile_only = std::env::var("STT_BENCH_PROFILE_ONLY").is_ok();
    let mut segment_vad = if segment {
        let vad_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("models")
            .join("silero_vad_v4.onnx");
        let started = Instant::now();
        match SileroVad::new(&vad_path, VAD_SPEECH_THRESHOLD) {
            Ok(vad) => {
                eprintln!("vad        : built in {} ms", started.elapsed().as_millis());
                Some(vad)
            }
            Err(e) => {
                eprintln!("VAD LOAD FAILED {}: {e}", vad_path.display());
                std::process::exit(5);
            }
        }
    } else {
        None
    };
    // cold pass (DML compiles kernels on first inference), then warm passes (steady-state).
    for pass in 0..bench_passes(2) {
        let label = match pass {
            0 => "cold".to_string(),
            1 => "warm".to_string(),
            n => format!("warm{n}"),
        };
        let t = Instant::now();
        let opts = TranscribeOptions::default();
        eprintln!("pass_start : pass={pass} label={label}");
        let text = if segment {
            match segment_vad.as_mut() {
                Some(vad) => winstt_app_lib::winstt::stt::vad_segment::vad_segment_decode(
                    engine.as_mut(),
                    &audio,
                    segment_max_s,
                    segment_prior,
                    vad,
                    &opts,
                    &format!("stt-bench-{pass}"),
                ),
                None => Err(SttError::Inference("segmentation VAD was not built".into())),
            }
        } else {
            engine.transcribe(&audio, &opts).map(|out| out.text)
        };
        match text {
            Ok(text) => {
                let elapsed = t.elapsed();
                println!(
                    "PROFILE pass={pass} label={label} elapsed_ms={} audio_ms={} chars={} words={}",
                    elapsed.as_millis(),
                    audio.len() * 1000 / 16_000,
                    text.chars().count(),
                    text.split_whitespace().count()
                );
                let _ = io::stdout().flush();
                if !profile_only {
                    println!(
                        "\n=== CATALOG TRANSCRIPT ({cat_id}, {label} {elapsed:?}) ===\n{text}\n=================="
                    );
                }
            }
            Err(e) => {
                eprintln!("TRANSCRIBE FAILED: {e}");
                std::process::exit(6);
            }
        }
    }
}

fn real_main() {
    let args: Vec<String> = std::env::args().collect();

    // Catalog mode: `stt_decode_bench --catalog <catalog_id>` (verifies the resolver→engine path).
    if args.get(1).is_some_and(|s| s == "--catalog") {
        let cat_id = args
            .get(2)
            .cloned()
            .unwrap_or_else(|| "tiny.en".to_string());
        run_catalog_mode(&cat_id);
        return;
    }
    let snap = args.get(1).cloned().unwrap_or_else(default_snap);
    let n_mels = args
        .get(2)
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(80);
    let lang = args.get(3).cloned().unwrap_or_else(|| "en".to_string());

    eprintln!("=== STT DECODE BENCH ===");
    eprintln!("snapshot : {snap}");
    eprintln!("n_mels   : {n_mels}");
    eprintln!("language : {lang}");

    // ---- 1. load audio (raw f32le 16k mono) ----
    let audio_path = audio_path();
    let bytes = std::fs::read(&audio_path).expect("read benchmark audio");
    let mut audio: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    eprintln!(
        "audio    : {} samples ({:.2}s)",
        audio.len(),
        audio.len() as f32 / 16_000.0
    );

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
    files.insert(
        "encoder".into(),
        PathBuf::from(format!("{snap}/onnx/encoder_model.onnx")),
    );
    files.insert(
        "decoder".into(),
        PathBuf::from(format!("{snap}/onnx/decoder_model_merged.onnx")),
    );
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
        model_name: snap,
        family: "whisper".into(),
        kind: EngineKind::WhisperHf,
        resolved: ResolvedModel {
            files,
            effective_quantization: Quantization::Default,
        },
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
    eprintln!(
        "loaded in {:?}; providers={:?}",
        t0.elapsed(),
        engine.active_providers()
    );
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
                println!(
                    "\n=== TRANSCRIPT ({label}) ===\n{}\n==================",
                    out.text
                );
            }
            Err(e) => {
                eprintln!("TRANSCRIBE FAILED: {e}");
                std::process::exit(3);
            }
        }
    }
}

fn main() {
    init_bench_logger();
    let handle = std::thread::Builder::new()
        .name("stt-bench-large-stack".to_string())
        .stack_size(64 * 1024 * 1024)
        .spawn(real_main)
        .expect("spawn STT bench worker");
    handle.join().expect("STT bench worker panicked");
}
