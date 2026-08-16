// Smoke harness for the CrisperWhisper 2.0 ONNX export (Masterx re-export of
// nyralabs/CrisperWhisper2.0_large). NOT shipped —
//   cargo run --example crisper2_smoke -- <local_export_dir> [quant] [wav]
//
// Drives the REAL WhisperEngine over the local export dir (resolver local_dir
// path, no HF): verbatim mode tags in the prompt, extended-vocab decode, and —
// when the export carries cross_attentions outputs — the word-timestamp DTW
// path with CrisperWhisper 2.0's supervised alignment heads.

use std::path::PathBuf;

use winstt_app_lib::winstt::stt::{
    self, Accelerator, EngineConfig, EngineKind, Quantization, TranscribeOptions,
};

fn load_wav(path: &PathBuf) -> Vec<f32> {
    let mut reader = hound::WavReader::open(path).expect("open wav");
    let spec = reader.spec();
    assert_eq!(spec.sample_rate, 16_000, "expected 16 kHz");
    assert_eq!(spec.channels, 1, "expected mono");
    match spec.sample_format {
        hound::SampleFormat::Int => reader
            .samples::<i16>()
            .map(|s| f32::from(s.expect("sample")) / 32768.0)
            .collect(),
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .map(|s| s.expect("sample"))
            .collect(),
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let local_dir = PathBuf::from(
        args.next()
            .unwrap_or_else(|| "E:/DL/Projects/crisper2-export/out".to_string()),
    );
    let quant = match args.next().as_deref() {
        None | Some("") | Some("fp32") => Quantization::Default,
        Some("fp16") => Quantization::Fp16,
        Some("q4") => Quantization::Q4,
        Some(other) => panic!("unsupported quant '{other}'"),
    };
    let wav = args.next().map_or_else(
        || {
            let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            manifest_dir
                .parent()
                .expect("repo root")
                .join("tools/bench/audio/jfk_16k_mono.wav")
        },
        PathBuf::from,
    );

    let audio = load_wav(&wav);
    eprintln!(
        "audio: {} samples = {:.1}s | export: {} | quant {:?}",
        audio.len(),
        audio.len() as f32 / 16_000.0,
        local_dir.display(),
        quant,
    );

    let req = stt::resolver::ResolveRequest {
        model_id: "crisper-whisper".to_string(),
        kind: EngineKind::WhisperHf,
        effective_quant: quant,
        local_dir: Some(local_dir),
        local_files_only: true,
    };
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let resolved = rt.block_on(stt::resolver::resolve(&req)).expect("resolve");
    eprintln!("resolved files:");
    for (k, v) in &resolved.files {
        eprintln!("  {k} -> {}", v.display());
    }

    let cfg = EngineConfig {
        model_name: "crisper-whisper".to_string(),
        family: "whisper".to_string(),
        kind: EngineKind::WhisperHf,
        resolved,
        providers: vec![Accelerator::Cpu],
        // Mirror backend.rs: the fp16 whisper tier always loads with the If-subgraph
        // dtype repair (the defect is inherent to fp16 merged-decoder exports).
        whisper_fp16_workaround: quant == Quantization::Fp16,
        language: None,
    };
    let mut engine = stt::build_engine(cfg).expect("build engine");

    // 1. Plain verbatim transcription (auto language detect).
    let opts = TranscribeOptions::default();
    let t = engine.transcribe(&audio, &opts).expect("transcribe");
    println!("VERBATIM: {}", t.text);
    assert!(!t.text.trim().is_empty(), "empty transcript");
    assert!(
        !t.text.contains("[verbatim"),
        "mode tags leaked into transcript: {}",
        t.text
    );

    // 2. Word timestamps via the cross-attention DTW path (if the export carries it).
    if engine.supports_word_timestamps() {
        let opts = TranscribeOptions {
            return_word_timestamps: true,
            language: Some("en".to_string()),
            ..Default::default()
        };
        let t = engine.transcribe(&audio, &opts).expect("word timestamps");
        let words = t.words.unwrap_or_default();
        println!("WORDS ({}):", words.len());
        for w in words.iter().take(12) {
            println!("  {:6.2}-{:6.2}  {}", w.start, w.end, w.text);
        }
        assert!(!words.is_empty(), "word-timestamp path produced no words");
    } else {
        println!("NOTE: export has no cross_attentions outputs; word timestamps unavailable");
    }

    // 3. Hotword biasing path (the <htx> channel replaces <|startofprev|>).
    let opts = TranscribeOptions {
        initial_prompt_text: Some("Berlin".to_string()),
        ..Default::default()
    };
    let t = engine
        .transcribe(&audio, &opts)
        .expect("hotword transcribe");
    println!("WITH-HOTWORD: {}", t.text);
    assert!(
        !t.text.to_lowercase().contains("htx"),
        "hotword markers leaked: {}",
        t.text
    );
}
