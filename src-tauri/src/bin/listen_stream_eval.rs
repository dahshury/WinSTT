use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use winstt_app_lib::winstt::catalog;
use winstt_app_lib::winstt::stt::cache_probe::engine_kind_for;
use winstt_app_lib::winstt::stt::resolver::{resolve, ResolveRequest};
use winstt_app_lib::winstt::stt::{
    build_engine, providers_for_accelerator, Accelerator, EngineConfig, Quantization,
    TranscribeOptions, Transcriber,
};

const SAMPLE_RATE: usize = 16_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Batch,
    Stream,
}

#[derive(Debug)]
struct Args {
    audio: PathBuf,
    chunk_ms: usize,
    final_pad_ms: usize,
    mode: Mode,
    model: String,
    provider: Accelerator,
    quant: Option<Quantization>,
}

fn main() -> Result<()> {
    std::thread::Builder::new()
        .name("listen-stream-eval".to_string())
        .stack_size(128 * 1024 * 1024)
        .spawn(run)?
        .join()
        .map_err(|_| anyhow!("listen-stream-eval thread panicked"))?
}

fn run() -> Result<()> {
    let args = parse_args()?;
    let samples = read_mono_16k_wav(&args.audio)?;
    let audio_ms = samples.len() * 1000 / SAMPLE_RATE;
    let mut engine = load_engine(&args.model, args.quant, args.provider)?;
    println!("providers={:?}", engine.active_providers());

    match args.mode {
        Mode::Batch => {
            let started = Instant::now();
            let out = engine
                .transcribe(&samples, &TranscribeOptions::default())
                .map_err(|e| anyhow!("batch transcribe failed: {e}"))?;
            report("batch", &args.model, audio_ms, started.elapsed(), &out.text);
        }
        Mode::Stream => {
            if !engine.supports_native_streaming() {
                return Err(anyhow!(
                    "model {} does not support native streaming",
                    args.model
                ));
            }
            let chunk_samples = (args.chunk_ms * SAMPLE_RATE / 1000).max(1);
            let mut updates = 0usize;
            let mut changed_updates = 0usize;
            let mut last_text = String::new();
            let mut decode_time = Duration::ZERO;
            let started = Instant::now();

            engine.stream_reset();
            for chunk in samples.chunks(chunk_samples) {
                let decode_started = Instant::now();
                let update = engine
                    .stream_accept(chunk)
                    .map_err(|e| anyhow!("stream accept failed: {e}"))?;
                decode_time += decode_started.elapsed();
                updates += 1;
                if update.text != last_text {
                    changed_updates += 1;
                    last_text = update.text;
                }
            }

            if args.final_pad_ms > 0 {
                let pad = vec![0.0f32; args.final_pad_ms * SAMPLE_RATE / 1000];
                let decode_started = Instant::now();
                let update = engine
                    .stream_accept(&pad)
                    .map_err(|e| anyhow!("stream final pad failed: {e}"))?;
                decode_time += decode_started.elapsed();
                updates += 1;
                if update.text != last_text {
                    changed_updates += 1;
                    last_text = update.text;
                }
            }

            let decode_started = Instant::now();
            let final_text = engine
                .stream_finalize()
                .map_err(|e| anyhow!("stream finalize failed: {e}"))?;
            decode_time += decode_started.elapsed();
            let text = if final_text.trim().is_empty() {
                last_text
            } else {
                final_text
            };
            println!(
                "stream_updates={} changed_updates={} chunk_ms={} decode_ms={}",
                updates,
                changed_updates,
                args.chunk_ms,
                decode_time.as_millis()
            );
            report("stream", &args.model, audio_ms, started.elapsed(), &text);
        }
    }

    Ok(())
}

fn parse_args() -> Result<Args> {
    let mut audio = None;
    let mut chunk_ms = 1120usize;
    let mut final_pad_ms = 2000usize;
    let mut mode = Mode::Stream;
    let mut model = "streaming-nemotron-en-1120ms-int8".to_string();
    let mut provider = Accelerator::Cpu;
    let mut quant = None;

    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--audio" => audio = Some(PathBuf::from(next_value(&mut it, "--audio")?)),
            "--chunk-ms" => {
                chunk_ms = next_value(&mut it, "--chunk-ms")?
                    .parse()
                    .context("--chunk-ms must be an integer")?
            }
            "--final-pad-ms" => {
                final_pad_ms = next_value(&mut it, "--final-pad-ms")?
                    .parse()
                    .context("--final-pad-ms must be an integer")?
            }
            "--mode" => {
                mode = match next_value(&mut it, "--mode")?.as_str() {
                    "batch" => Mode::Batch,
                    "stream" => Mode::Stream,
                    other => return Err(anyhow!("unsupported --mode {other}")),
                }
            }
            "--model" => model = next_value(&mut it, "--model")?,
            "--provider" => {
                provider = match next_value(&mut it, "--provider")?.as_str() {
                    "cpu" => Accelerator::Cpu,
                    "directml" | "dml" => Accelerator::DirectMl,
                    "cuda" => Accelerator::Cuda,
                    other => return Err(anyhow!("unsupported --provider {other}")),
                }
            }
            "--quant" => {
                let raw = next_value(&mut it, "--quant")?;
                quant = Quantization::parse(&raw);
                if quant.is_none() {
                    return Err(anyhow!("unsupported --quant {raw}"));
                }
            }
            "--help" | "-h" => {
                println!(
                    "usage: listen_stream_eval --audio file.wav [--mode stream|batch] [--model id] [--provider cpu|directml|cuda] [--quant int8] [--chunk-ms 1120] [--final-pad-ms 2000]"
                );
                std::process::exit(0);
            }
            other => return Err(anyhow!("unknown argument {other}")),
        }
    }

    let audio = audio.ok_or_else(|| anyhow!("--audio is required"))?;
    Ok(Args {
        audio,
        chunk_ms,
        final_pad_ms,
        mode,
        model,
        provider,
        quant,
    })
}

fn next_value(it: &mut impl Iterator<Item = String>, name: &str) -> Result<String> {
    it.next().ok_or_else(|| anyhow!("{name} requires a value"))
}

fn load_engine(
    model_id: &str,
    requested_quant: Option<Quantization>,
    provider: Accelerator,
) -> Result<Box<dyn Transcriber>> {
    let entry =
        catalog::find(model_id).ok_or_else(|| anyhow!("unknown catalog model {model_id}"))?;
    let kind = engine_kind_for(entry.id, entry.family.as_str(), entry.onnx_model_name);
    let quant = requested_quant.unwrap_or_else(|| {
        if entry.id.contains("int8") || entry.onnx_model_name.contains("int8") {
            Quantization::Int8
        } else {
            Quantization::Default
        }
    });
    let req = ResolveRequest {
        model_id: entry.onnx_model_name.to_string(),
        kind,
        effective_quant: quant,
        local_dir: None,
        local_files_only: true,
    };
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("create tokio runtime")?;
    let resolved = rt
        .block_on(resolve(&req))
        .map_err(|e| anyhow!("resolve cached model {}: {e}", entry.onnx_model_name))?;
    let cfg = EngineConfig {
        model_name: entry.id.to_string(),
        family: entry.family.as_str().to_string(),
        kind,
        resolved,
        providers: providers_for_accelerator(provider),
        whisper_fp16_workaround: false,
    };
    build_engine(cfg).map_err(|e| anyhow!("build engine {}: {e}", entry.id))
}

fn read_mono_16k_wav(path: &Path) -> Result<Vec<f32>> {
    let mut reader =
        hound::WavReader::open(path).with_context(|| format!("open wav {}", path.display()))?;
    let spec = reader.spec();
    if spec.sample_rate != SAMPLE_RATE as u32 {
        return Err(anyhow!(
            "expected 16 kHz wav, got {} Hz in {}",
            spec.sample_rate,
            path.display()
        ));
    }
    if spec.channels != 1 {
        return Err(anyhow!(
            "expected mono wav, got {} channels in {}",
            spec.channels,
            path.display()
        ));
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
        (hound::SampleFormat::Int, bits) if bits <= 32 => {
            let denom = ((1i64 << (bits - 1)) - 1) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.map(|v| v as f32 / denom))
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(Into::into)
        }
        _ => Err(anyhow!(
            "unsupported wav format {:?} {} bits",
            spec.sample_format,
            spec.bits_per_sample
        )),
    }
}

fn report(mode: &str, model: &str, audio_ms: usize, elapsed: Duration, text: &str) {
    let words = text.split_whitespace().count();
    let chars = text.chars().count();
    let elapsed_ms = elapsed.as_millis().max(1);
    let realtime_x = audio_ms as f64 / elapsed_ms as f64;
    println!(
        "mode={} model={} audio_ms={} elapsed_ms={} realtime_x={:.2} words={} chars={}",
        mode, model, audio_ms, elapsed_ms, realtime_x, words, chars
    );
    println!("--- transcript ---");
    println!("{}", text.trim());
}
