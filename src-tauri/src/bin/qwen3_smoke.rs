// Standalone smoke test for the Qwen3-ASR engine. Points `build_engine` at an already-downloaded
// ONNX export directory (the int4 set) and transcribes one 16 kHz mono wav — bypassing the network
// resolver so the engine logic can be verified against local files.
//
// Usage: cargo run --bin qwen3_smoke -- <model_dir> <wav> [encoder.int4.onnx]
//   model_dir must contain: encoder[.int4].onnx, decoder_init[.int4].onnx, decoder_step[.int4].onnx,
//   decoder_weights[.int4].data (beside the graphs), embed_tokens.bin, tokenizer.json, config.json.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use winstt_app_lib::winstt::stt::{
    build_engine, providers_for_accelerator, Accelerator, EngineConfig, EngineKind, Quantization,
    ResolvedModel, TranscribeOptions,
};

const SAMPLE_RATE: u32 = 16_000;

fn main() -> Result<()> {
    std::thread::Builder::new()
        .name("qwen3-smoke".into())
        .stack_size(128 * 1024 * 1024)
        .spawn(run)?
        .join()
        .map_err(|_| anyhow!("qwen3-smoke thread panicked"))?
}

fn run() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let dir = PathBuf::from(
        args.next()
            .ok_or_else(|| anyhow!("usage: <model_dir> <wav>"))?,
    );
    let wav = PathBuf::from(
        args.next()
            .ok_or_else(|| anyhow!("usage: <model_dir> <wav>"))?,
    );
    // int4 export uses `.int4.onnx`; allow a plain `.onnx` override via a suffix arg.
    let suffix = if dir.join("encoder.int4.onnx").exists() {
        ".int4"
    } else {
        ""
    };
    let g = |stem: &str, ext: &str| dir.join(format!("{stem}{suffix}{ext}"));

    let mut files: BTreeMap<String, PathBuf> = BTreeMap::new();
    files.insert("encoder".into(), g("encoder", ".onnx"));
    files.insert("decoder_init".into(), g("decoder_init", ".onnx"));
    files.insert("decoder_step".into(), g("decoder_step", ".onnx"));
    files.insert("embed_tokens".into(), dir.join("embed_tokens.bin"));
    files.insert("tokenizer".into(), dir.join("tokenizer.json"));
    files.insert("config".into(), dir.join("config.json"));
    for (k, p) in &files {
        if !p.exists() {
            return Err(anyhow!("missing {k}: {}", p.display()));
        }
    }

    let resolved = ResolvedModel {
        files,
        effective_quantization: Quantization::Int4,
    };
    let cfg = EngineConfig {
        model_name: "qwen3-asr-0.6b".into(),
        family: "qwen3".into(),
        kind: EngineKind::Qwen3Asr,
        resolved,
        providers: providers_for_accelerator(Accelerator::Cpu),
        whisper_fp16_workaround: false,
    };

    let load_started = std::time::Instant::now();
    let mut engine = build_engine(cfg).map_err(|e| anyhow!("build engine: {e}"))?;
    eprintln!(
        "loaded in {:?}, providers={:?}",
        load_started.elapsed(),
        engine.active_providers()
    );

    let samples = read_mono_16k_wav(&wav)?;
    eprintln!(
        "audio samples={} ({}s)",
        samples.len(),
        samples.len() as f32 / SAMPLE_RATE as f32
    );
    let started = std::time::Instant::now();
    let out = engine
        .transcribe(&samples, &TranscribeOptions::default())
        .map_err(|e| anyhow!("transcribe: {e}"))?;
    eprintln!("transcribed in {:?}", started.elapsed());
    println!("TEXT: {}", out.text);
    Ok(())
}

fn read_mono_16k_wav(path: &Path) -> Result<Vec<f32>> {
    let mut reader =
        hound::WavReader::open(path).with_context(|| format!("open wav {}", path.display()))?;
    let spec = reader.spec();
    if spec.sample_rate != SAMPLE_RATE {
        return Err(anyhow!("expected 16 kHz wav, got {} Hz", spec.sample_rate));
    }
    if spec.channels != 1 {
        return Err(anyhow!("expected mono wav, got {} channels", spec.channels));
    }
    match (spec.sample_format, spec.bits_per_sample) {
        (hound::SampleFormat::Float, 32) => reader
            .samples::<f32>()
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into),
        (hound::SampleFormat::Int, bits) if bits <= 16 => reader
            .samples::<i16>()
            .map(|s| s.map(|v| v as f32 / i16::MAX as f32))
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into),
        _ => Err(anyhow!("unsupported wav sample format")),
    }
}
