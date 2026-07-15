// Repro harness for the "500 by 1500" encoder Add-broadcast failure on
// `onnx-community/whisper-tiny` (the "OpenAI tiny" picker entry). NOT shipped —
// `cargo run --example whisper_dynlen_fallback_repro [-- <model_id>]`.
//
// The onnx-community exports declare `input_features` dim 2 (mel frames)
// SYMBOLICALLY while the graph's positional embedding is still the fixed
// 1500-frame constant, so the dynlen capability probe in WhisperEngine::load
// misdetects them as dynlen-capable. A short clip then encodes a 1000-frame
// bucket (→ 500 encoder frames) and the pos-emb Add broadcast fails with
// "500 by 1500". This harness transcribes the 3 s JFK clip — short enough to
// pick the 1000-frame bucket — and must produce text via the static-window
// fallback, printing the `[WARN] ... pinning static 30 s encode` line once.

use std::path::PathBuf;

use winstt_app_lib::winstt::stt::{
    self, Accelerator, EngineConfig, EngineKind, Quantization, TranscribeOptions,
};

struct StderrLogger;
impl log::Log for StderrLogger {
    fn enabled(&self, m: &log::Metadata<'_>) -> bool {
        m.level() <= log::max_level()
    }
    fn log(&self, r: &log::Record<'_>) {
        if self.enabled(r.metadata()) {
            eprintln!("[{}] {}", r.level(), r.args());
        }
    }
    fn flush(&self) {}
}
static LOGGER: StderrLogger = StderrLogger;

fn load_short_clip() -> Vec<f32> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let path = manifest_dir.parent().map_or_else(
        || PathBuf::from("tools/bench/audio/jfk_short_3s.f32"),
        |repo| repo.join("tools/bench/audio/jfk_short_3s.f32"),
    );
    let bytes = std::fs::read(&path).expect("read jfk_short_3s.f32");
    bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect()
}

fn main() {
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(log::LevelFilter::Debug);

    let model_id = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "onnx-community/whisper-tiny".to_string());

    let audio = load_short_clip();
    eprintln!(
        "audio: {} samples = {:.1}s (must bucket to 1000 mel frames)",
        audio.len(),
        audio.len() as f32 / 16_000.0
    );

    let req = stt::resolver::ResolveRequest {
        model_id: model_id.clone(),
        kind: EngineKind::WhisperHf,
        effective_quant: Quantization::Default,
        local_dir: None,
        local_files_only: true,
    };
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let resolved = rt.block_on(stt::resolver::resolve(&req)).expect("resolve");
    let cfg = EngineConfig {
        model_name: model_id,
        family: "whisper".to_string(),
        kind: EngineKind::WhisperHf,
        resolved,
        providers: vec![Accelerator::Cpu],
        whisper_fp16_workaround: false,
        language: None,
    };
    let mut engine = stt::build_engine(cfg).expect("build engine");

    let opts = TranscribeOptions::default();
    match engine.transcribe(&audio, &opts) {
        Ok(t) => println!("TRANSCRIPT: {}", t.text),
        Err(e) => {
            eprintln!("FAILED (bug still present): {e}");
            std::process::exit(1);
        }
    }
}
