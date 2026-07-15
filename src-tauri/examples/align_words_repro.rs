// Repro harness for the history word-alignment path on LONG recordings.
// NOT shipped — `cargo run --release --example align_words_repro -- <wav> [known_text_file]`.
//
// Mirrors managers::WordAligner::align_words WITHOUT an AppHandle:
//   resolver → build_engine(whisper-tiny_timestamped, CPU) → vad_segment_align_words (>28 s)
//   → map_timings_to_text against the known transcript (when given).
// Prints per-stage timings, word counts, and the first/last timed words so a
// truncation or empty result is immediately visible.

use std::time::Instant;

use winstt_app_lib::audio_toolkit::read_wav_samples;
use winstt_app_lib::audio_toolkit::vad::{SileroVad, VAD_SPEECH_THRESHOLD};
use winstt_app_lib::winstt::stt::{
    self, Accelerator, EngineConfig, EngineKind, Quantization, TranscribeOptions,
};
use winstt_app_lib::winstt::word_timestamps::{self, WordTiming};

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

fn main() {
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(log::LevelFilter::Debug);

    let mut args = std::env::args().skip(1);
    let wav = args
        .next()
        .expect("usage: align_words_repro <wav> [known_text_file]");
    let known_text = args
        .next()
        .map(|p| std::fs::read_to_string(p).expect("read known text"))
        .unwrap_or_default();

    let audio = read_wav_samples(&wav).expect("read wav");
    eprintln!(
        "audio: {} samples = {:.1}s",
        audio.len(),
        audio.len() as f32 / 16_000.0
    );

    // --- resolve + build the aligner engine (same request as WordAligner::try_load_engine) ---
    let req = stt::resolver::ResolveRequest {
        model_id: "onnx-community/whisper-tiny_timestamped".to_string(),
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
        model_name: "onnx-community/whisper-tiny_timestamped".to_string(),
        family: "whisper".to_string(),
        kind: EngineKind::WhisperHf,
        resolved,
        providers: vec![Accelerator::Cpu],
        whisper_fp16_workaround: false,
        language: None,
    };
    let build_started = Instant::now();
    let mut engine = stt::build_engine(cfg).expect("build engine");
    eprintln!(
        "engine built in {:?}; supports_word_timestamps={}",
        build_started.elapsed(),
        engine.supports_word_timestamps()
    );

    let opts = TranscribeOptions {
        return_word_timestamps: true,
        ..Default::default()
    };

    // --- the long-audio align path (same constants as WordAligner) ---
    const MAX_ALIGN_CHUNK_S: f32 = 28.0;
    let vad_path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/resources/models/silero_vad_v4.onnx"
    );
    let mut vad =
        SileroVad::new(std::path::Path::new(vad_path), VAD_SPEECH_THRESHOLD).expect("vad");

    let align_started = Instant::now();
    let timed = if audio.len() > (MAX_ALIGN_CHUNK_S * 16_000.0) as usize {
        eprintln!("LONG path: vad_segment_align_words");
        stt::vad_segment::vad_segment_align_words(
            &mut *engine,
            &audio,
            MAX_ALIGN_CHUNK_S,
            &mut vad,
            &opts,
        )
        .expect("align")
    } else {
        eprintln!("SHORT path: single transcribe");
        engine
            .transcribe(&audio, &opts)
            .expect("transcribe")
            .words
            .unwrap_or_default()
    };
    eprintln!(
        "aligned {} timed words in {:?}",
        timed.len(),
        align_started.elapsed()
    );
    if let (Some(first), Some(last)) = (timed.first(), timed.last()) {
        eprintln!(
            "  first: {:?} @ {:.2}s   last: {:?} @ {:.2}s",
            first.text, first.start, last.text, last.end
        );
    }

    // --- use-our-words mapping (same as WordAligner::map_timings_to_known_text) ---
    if !known_text.trim().is_empty() {
        let known_words: Vec<String> = known_text.split_whitespace().map(str::to_string).collect();
        let timings: Vec<WordTiming> = timed
            .iter()
            .map(|w| WordTiming {
                word: w.text.clone(),
                start: w.start as f64,
                end: w.end as f64,
                tokens: Vec::new(),
            })
            .collect();
        let map_started = Instant::now();
        let mapped = word_timestamps::map_timings_to_text(&timings, &known_words);
        eprintln!(
            "mapped {} known words in {:?}",
            mapped.len(),
            map_started.elapsed()
        );
        if let (Some(first), Some(last)) = (mapped.first(), mapped.last()) {
            eprintln!(
                "  first: {:?} @ {:.2}s   last: {:?} @ {:.2}s",
                first.text, first.start, last.text, last.end
            );
        }
        // Zero-timed tail = the truncation symptom (words past the mel window with no timing).
        let zero_tail = mapped
            .iter()
            .rev()
            .take_while(|w| w.start == 0.0 && w.end == 0.0)
            .count();
        eprintln!("  zero-timed tail words: {zero_tail}");
    }
}
