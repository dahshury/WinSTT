// Smoke harness for the icefall zipformer2 streaming CTC engine (`EngineKind::KaldiCtc`,
// Muno459/zipformer_p-arabic-v2). NOT shipped — a `cargo run --example zipformer_ar_ctc_smoke`
// harness only.
//
//   cargo run --release --example zipformer_ar_ctc_smoke -- <model.onnx> <tokens.txt> <audio.wav>
//
// Runs BOTH the batch `transcribe()` path and the incremental `stream_accept` path over the same
// clip and prints the decoded phoneme strings; exits non-zero if either decode comes back empty
// or the two paths disagree.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Instant;

use winstt_app_lib::winstt::stt::{
    Accelerator, EngineConfig, EngineKind, Quantization, ResolvedModel, build_engine,
};

fn read_wav_16k_mono(path: &str) -> Vec<f32> {
    let mut reader = hound::WavReader::open(path).expect("open wav");
    let spec = reader.spec();
    assert_eq!(spec.sample_rate, 16_000, "expected 16 kHz audio");
    assert_eq!(spec.channels, 1, "expected mono audio");
    match spec.sample_format {
        hound::SampleFormat::Int => {
            let denom = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.expect("sample") as f32 / denom)
                .collect()
        }
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .map(|s| s.expect("sample"))
            .collect(),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [model, tokens, wav] = args.as_slice() else {
        eprintln!("usage: zipformer_ar_ctc_smoke <model.onnx> <tokens.txt> <audio.wav>");
        std::process::exit(2);
    };

    let mut audio = read_wav_16k_mono(wav);
    // Match the coordinator's contract: peak-normalize to 0.95.
    let peak = audio.iter().fold(0.0f32, |m, &s| m.max(s.abs()));
    if peak > 0.0 {
        let g = 0.95 / peak;
        for s in &mut audio {
            *s *= g;
        }
    }
    println!(
        "audio: {} samples ({:.2}s)",
        audio.len(),
        audio.len() as f32 / 16000.0
    );

    let mut files = BTreeMap::new();
    files.insert("model".to_string(), PathBuf::from(model));
    files.insert("vocab".to_string(), PathBuf::from(tokens));
    let cfg = EngineConfig {
        model_name: "zipformer-ar-ctc".into(),
        family: "kaldi".into(),
        kind: EngineKind::KaldiCtc,
        resolved: ResolvedModel {
            files,
            effective_quantization: Quantization::Default,
        },
        providers: vec![Accelerator::Cpu],
        whisper_fp16_workaround: false,
        language: None,
    };

    let load_start = Instant::now();
    let mut engine = build_engine(cfg).expect("engine load");
    println!(
        "engine loaded in {:.0} ms",
        load_start.elapsed().as_secs_f64() * 1000.0
    );
    assert!(
        engine.supports_native_streaming(),
        "must be native streaming"
    );

    // Batch path.
    let t = Instant::now();
    let batch = engine
        .transcribe(&audio, &Default::default())
        .expect("batch transcribe");
    println!(
        "batch   ({:.0} ms): {}",
        t.elapsed().as_secs_f64() * 1000.0,
        batch.text
    );

    // Incremental path: feed 100 ms ticks like the realtime worker.
    engine.stream_reset();
    let t = Instant::now();
    for chunk in audio.chunks(1600) {
        engine.stream_accept(chunk).expect("stream accept");
    }
    let streamed = engine.stream_finalize().expect("stream finalize");
    println!(
        "stream  ({:.0} ms): {}",
        t.elapsed().as_secs_f64() * 1000.0,
        streamed
    );

    assert!(
        !batch.text.trim().is_empty(),
        "batch decode came back empty"
    );
    assert!(
        !streamed.trim().is_empty(),
        "streamed decode came back empty"
    );
    assert_eq!(
        batch.text, streamed,
        "batch and incremental decodes disagree"
    );
    println!(
        "OK: batch == streamed, {} chars",
        batch.text.chars().count()
    );
}
