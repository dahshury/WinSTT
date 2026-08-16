// TTS engine benchmark. Proves an engine loads + synthesizes end-to-end from cached HF
// files, reports latency/RTF + peak/rms/NaN, and writes an audible WAV.
//
//   cargo run --release --example tts_engine_bench -- kitten
//   cargo run --release --example tts_engine_bench -- kitten expr-voice-2-f "custom text"
//   cargo run --release --example tts_engine_bench -- piper
//   cargo run --release --example tts_engine_bench -- supertonic M3 en
//   cargo run --release --example tts_engine_bench -- supertonic M3 fr "Bonjour, ceci est une courte démonstration."
//   cargo run --release --example tts_engine_bench -- chatterbox
//   cargo run --release --example tts_engine_bench -- chatterbox chatterbox-turbo q4f16 default "text"
//   cargo run --release --example tts_engine_bench -- chatterbox chatterbox-nano q4f16 <ref.wav> "text"
//   cargo run --release --example tts_engine_bench -- qwen3 qwen3-tts-0.6b-customvoice int4 aiden "text"
//   cargo run --release --example tts_engine_bench -- neutts neutts-2e int8 emily-neutral "text"
//   cargo run --release --example tts_engine_bench -- neutts neutts-2e fp32 sophie-sad "text"
//   cargo run --release --example tts_engine_bench -- orpheus orpheus-3b q4 tara "text"
//   cargo run --release --example tts_engine_bench -- audio8 audio8-tts-0.6b <ref.wav> "ref transcript" "text"
//
// Model files live under  <repo>/.tts-cache/<catalog-id>/  (override WINSTT_TTS_CACHE),
// laid out exactly like the TtsDownloadManager manifest so this exercises the real load
// paths. The chatterbox/qwen3/neutts/orpheus/omnivoice modes drive the SHIPPING `TtsEngine`
// adapters (not the raw engines) so the catalog→graph-set→session wiring is under test too.
// espeak-ng is auto-pointed at the app-data runtime if it has been installed.

use std::path::{Path, PathBuf};
use std::time::Instant;

use winstt_app_lib::winstt::tts::kitten::{KITTEN_SAMPLE_RATE, KittenConfig, KittenEngine};
use winstt_app_lib::winstt::tts::local_engines::{
    Audio8LocalEngine, ChatterboxLocalEngine, NeuTtsLocalEngine, OmniVoiceLocalEngine,
    OrpheusLocalEngine, Qwen3TtsLocalEngine,
};
use winstt_app_lib::winstt::tts::piper::{PiperConfig, PiperEngine};
use winstt_app_lib::winstt::tts::qwen3_tts::Qwen3TtsVoiceMode;
use winstt_app_lib::winstt::tts::supertonic::{
    SUPERTONIC_SAMPLE_RATE, SupertonicConfig, SupertonicEngine,
};
use winstt_app_lib::winstt::tts::{SentenceAudio, TtsDevice, TtsEngine};

const DEFAULT_SENTENCE: &str = "The quick brown fox jumps over the lazy dog.";

fn cache_root() -> PathBuf {
    std::env::var("WINSTT_TTS_CACHE")
        .map_or_else(|_| PathBuf::from("<repo>/.tts-cache"), PathBuf::from)
}

fn ensure_espeak() {
    if std::env::var_os("ESPEAK_NG_LIBRARY").is_none()
        && let Some(lib) = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|local| {
                local
                    .join("winstt")
                    .join("tts")
                    .join("runtime")
                    .join("espeakng_loader")
                    .join("espeak-ng.dll")
            })
            .filter(|lib| lib.exists())
    {
        // SAFETY: this benchmark sets the default before initializing any TTS engine threads.
        unsafe { std::env::set_var("ESPEAK_NG_LIBRARY", lib) };
    }
    eprintln!(
        "espeak-ng: {}",
        std::env::var("ESPEAK_NG_LIBRARY").unwrap_or_else(|_| "<unset>".into())
    );
}

fn write_wav(path: &str, samples: &[f32], sample_rate: u32) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(path, spec).expect("create wav");
    for &s in samples {
        w.write_sample((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
            .expect("write");
    }
    w.finalize().expect("finalize");
}

/// The voice slot doubles as a reference-clip PATH for the cloning engines, so the raw
/// value can carry separators and a drive letter that `WavWriter::create` rejects. Reduce
/// it to the stem and keep only filename-safe bytes.
fn voice_slug(voice: &str) -> String {
    let stem = Path::new(voice)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(voice);
    let cleaned: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '-'
            }
        })
        .take(40)
        .collect();
    match cleaned.trim_matches('-') {
        "" => "voice".to_string(),
        trimmed => trimmed.to_string(),
    }
}

fn stats(samples: &[f32]) -> (f32, f32, usize) {
    let mut peak = 0.0f32;
    let mut sumsq = 0.0f64;
    let mut nan = 0usize;
    for &s in samples {
        if s.is_nan() {
            nan += 1;
            continue;
        }
        peak = peak.max(s.abs());
        sumsq += (s as f64) * (s as f64);
    }
    let rms = if samples.is_empty() {
        0.0
    } else {
        (sumsq / samples.len() as f64).sqrt() as f32
    };
    (peak, rms, nan)
}

fn report(
    engine: &str,
    voice: &str,
    label: &str,
    dt: std::time::Duration,
    samples: &[f32],
    sr: u32,
) {
    let dur = samples.len() as f32 / sr as f32;
    let (peak, rms, nan) = stats(samples);
    let rtf = if dur > 0.0 {
        dt.as_secs_f32() / dur
    } else {
        f32::INFINITY
    };
    let ok = !samples.is_empty() && nan == 0 && peak > 1e-4;
    eprintln!(
        "  [{label}] synth={:>7.1}ms  samples={}  dur={:.2}s  RTF={:.3}  peak={:.3} rms={:.4} nan={} ok={}",
        dt.as_secs_f32() * 1000.0,
        samples.len(),
        dur,
        rtf,
        peak,
        rms,
        nan,
        ok
    );
    if label == "warm" {
        let out = format!("tts_engine_bench_{engine}_{}.wav", voice_slug(voice));
        write_wav(&out, samples, sr);
        eprintln!("  wrote {out}");
    }
}

fn run_kitten(voice: &str, text: &str) {
    let cfg = KittenConfig {
        cache_dir: cache_root().join("kitten"),
        device: TtsDevice::Cpu,
        ..Default::default()
    };
    let engine = KittenEngine::new(cfg);
    eprintln!("\n=== KITTEN voice={voice} ===");
    for label in ["cold", "warm"] {
        let t = Instant::now();
        match engine.synthesize(text, voice, "en-us", 1.0) {
            Ok(s) => report("kitten", voice, label, t.elapsed(), &s, KITTEN_SAMPLE_RATE),
            Err(e) => {
                eprintln!("  [{label}] FAILED: {e}");
                std::process::exit(6);
            }
        }
    }
}

fn run_piper(text: &str) {
    let cfg = PiperConfig {
        cache_dir: cache_root().join("piper"),
        voice_stem: "en_US-lessac-medium".to_string(),
    };
    let engine = PiperEngine::new(cfg);
    eprintln!("\n=== PIPER voice=en_US-lessac-medium ===");
    for label in ["cold", "warm"] {
        let t = Instant::now();
        match engine.synthesize(text, 1.0) {
            Ok((s, sr)) => report("piper", "lessac-medium", label, t.elapsed(), &s, sr),
            Err(e) => {
                eprintln!("  [{label}] FAILED: {e}");
                std::process::exit(6);
            }
        }
    }
}

fn run_supertonic(voice: &str, lang: &str, text: &str) {
    let cfg = SupertonicConfig {
        cache_dir: cache_root().join("supertonic-3"),
    };
    let engine = SupertonicEngine::new(cfg);
    eprintln!("\n=== SUPERTONIC voice={voice} lang={lang} ===");
    for label in ["cold", "warm"] {
        let t = Instant::now();
        match engine.synthesize(text, voice, lang, 1.0) {
            Ok(s) => {
                report(
                    "supertonic",
                    voice,
                    label,
                    t.elapsed(),
                    &s,
                    SUPERTONIC_SAMPLE_RATE,
                );
            }
            Err(e) => {
                eprintln!("  [{label}] FAILED: {e}");
                std::process::exit(6);
            }
        }
    }
}

/// Cold+warm run of any `TtsEngine` adapter, reporting through the shared `report`.
fn run_adapter(engine: &dyn TtsEngine, tag: &str, voice: &str, lang: &str, text: &str) {
    for label in ["cold", "warm"] {
        let t = Instant::now();
        match engine.synthesize_sentence(text, voice, lang, 1.0) {
            Ok(SentenceAudio::F32le {
                samples,
                sample_rate,
            }) => report(tag, voice, label, t.elapsed(), &samples, sample_rate),
            Ok(SentenceAudio::Mp3 { .. }) => {
                eprintln!("  [{label}] FAILED: unexpected mp3 output from a local engine");
                std::process::exit(6);
            }
            Err(e) => {
                eprintln!("  [{label}] FAILED: {e}");
                std::process::exit(6);
            }
        }
    }
}

/// Chatterbox through the SHIPPING adapter, so the catalog id + quant drive the same
/// per-graph filename resolution the app uses. `voice` = "default" (bundled clip) or a
/// path to a reference WAV to clone.
fn run_chatterbox(model_id: &str, quant: &str, voice: &str, text: &str) {
    eprintln!("\n=== CHATTERBOX {model_id} quant={quant} voice={voice} ===");
    let engine = ChatterboxLocalEngine::new(cache_root().join(model_id), model_id, quant);
    let tag = model_id.replace("chatterbox-", "cb-");
    run_adapter(&engine, &tag, voice, "en", text);
}

/// Qwen3-TTS through the shipping adapter. `voice` is a preset timbre id on the
/// CustomVoice checkpoints and a design prompt on VoiceDesign.
fn run_qwen3(model_id: &str, quant: &str, voice: &str, text: &str) {
    eprintln!("\n=== QWEN3-TTS {model_id} quant={quant} voice={voice} ===");
    let mode = if model_id.contains("voicedesign") {
        Qwen3TtsVoiceMode::DesignPrompt
    } else {
        Qwen3TtsVoiceMode::PresetSpeaker
    };
    let engine = Qwen3TtsLocalEngine::new(cache_root().join(model_id), quant.to_string(), mode);
    let tag = model_id.replace("qwen3-tts-", "qwen3-");
    run_adapter(&engine, &tag, voice, "en", text);
}

/// NeuTTS-2e through the shipping adapter. `voice` is a `{speaker}-{emotion}` id
/// (e.g. `emily-happy`); `quant` picks the backbone AND the matching NeuCodec decoder.
fn run_neutts(model_id: &str, quant: &str, voice: &str, text: &str) {
    eprintln!("\n=== NEUTTS {model_id} quant={quant} voice={voice} ===");
    let engine = NeuTtsLocalEngine::new(cache_root().join(model_id), quant.to_string());
    run_adapter(&engine, &format!("neutts-{quant}"), voice, "en", text);
}

/// Orpheus through the shipping adapter. `voice` is one of the 8 fine-tuned English speaker
/// ids (tara, leah, …). The `quant` slot exists only for CLI symmetry with the other
/// multi-rung engines — `OrpheusLocalEngine` hardcodes the `onnx/model_q4.onnx` graph and the
/// catalog publishes exactly one rung — so anything but `q4` is rejected rather than silently
/// benchmarked as something it is not.
///
/// The sampler is seeded from the prompt (`fnv1a_seed`), so a given text+voice always draws
/// the same token stream: cold and warm render byte-identical audio and the RTF is a clean
/// like-for-like measure across runs.
fn run_orpheus(model_id: &str, quant: &str, voice: &str, text: &str) {
    if quant != "q4" {
        eprintln!("orpheus: only the q4 rung exists (got '{quant}')");
        std::process::exit(2);
    }
    eprintln!("\n=== ORPHEUS {model_id} quant={quant} voice={voice} ===");
    let engine = OrpheusLocalEngine::new(cache_root().join(model_id));
    run_adapter(&engine, "orpheus", voice, "en", text);
}

/// OmniVoice through the shipping adapter. `voice` is either the `default` sentinel or a
/// path to a reference clip; `ref_text` is that clip's transcript (the ZeroShotAudioText
/// contract) and is ignored on the no-reference path.
///
/// Expect a SLOW run: measured warm CPU RTF is 3.4x with no reference and 6.5x with a 3 s
/// clip, because every one of the 32 refinement steps is a full bidirectional forward pass.
fn run_omnivoice(model_id: &str, voice: &str, lang: &str, ref_text: &str, text: &str) {
    eprintln!("\n=== OMNIVOICE {model_id} voice={voice} lang={lang} ===");
    let engine = OmniVoiceLocalEngine::new(
        cache_root().join(model_id),
        ref_text.to_string(),
        std::env::var("WINSTT_TTS_INSTRUCT").unwrap_or_default(),
    );
    run_adapter(&engine, "omnivoice", voice, lang, text);
}

/// Audio8 through the shipping adapter. `voice` MUST be a path to a reference clip
/// (the DualAR prompt requires reference codes — there is no unconditioned path);
/// `ref_text` is that clip's exact transcript (the ZeroShotAudioText contract).
fn run_audio8(model_id: &str, voice: &str, ref_text: &str, text: &str) {
    eprintln!("\n=== AUDIO8 {model_id} voice={voice} ===");
    let engine = Audio8LocalEngine::new(cache_root().join(model_id), ref_text.to_string());
    run_adapter(&engine, "audio8", voice, "en", text);
}

fn main() {
    ensure_espeak();
    let args: Vec<String> = std::env::args().collect();
    let engine = args.get(1).map_or("kitten", |s| s.as_str());
    match engine {
        "kitten" => {
            let voice = args
                .get(2)
                .cloned()
                .unwrap_or_else(|| "expr-voice-5-m".into());
            let text = args
                .get(3)
                .cloned()
                .unwrap_or_else(|| DEFAULT_SENTENCE.into());
            run_kitten(&voice, &text);
        }
        "piper" => {
            let text = args
                .get(2)
                .cloned()
                .unwrap_or_else(|| DEFAULT_SENTENCE.into());
            run_piper(&text);
        }
        "supertonic" => {
            let voice = args.get(2).cloned().unwrap_or_else(|| "M3".into());
            let lang = args.get(3).cloned().unwrap_or_else(|| "en".into());
            let text = args
                .get(4)
                .cloned()
                .unwrap_or_else(|| DEFAULT_SENTENCE.into());
            run_supertonic(&voice, &lang, &text);
        }
        "chatterbox" => {
            let model_id = args
                .get(2)
                .cloned()
                .unwrap_or_else(|| "chatterbox-multilingual".into());
            let quant = args.get(3).cloned().unwrap_or_else(|| "q4".into());
            let voice = args.get(4).cloned().unwrap_or_else(|| "default".into());
            let text = args
                .get(5)
                .cloned()
                .unwrap_or_else(|| DEFAULT_SENTENCE.into());
            run_chatterbox(&model_id, &quant, &voice, &text);
        }
        "qwen3" => {
            let model_id = args
                .get(2)
                .cloned()
                .unwrap_or_else(|| "qwen3-tts-0.6b-customvoice".into());
            let quant = args.get(3).cloned().unwrap_or_else(|| "int4".into());
            let voice = args.get(4).cloned().unwrap_or_else(|| "aiden".into());
            let text = args
                .get(5)
                .cloned()
                .unwrap_or_else(|| DEFAULT_SENTENCE.into());
            run_qwen3(&model_id, &quant, &voice, &text);
        }
        "neutts" => {
            let model_id = args.get(2).cloned().unwrap_or_else(|| "neutts-2e".into());
            let quant = args.get(3).cloned().unwrap_or_else(|| "int8".into());
            let voice = args
                .get(4)
                .cloned()
                .unwrap_or_else(|| "emily-neutral".into());
            let text = args
                .get(5)
                .cloned()
                .unwrap_or_else(|| DEFAULT_SENTENCE.into());
            run_neutts(&model_id, &quant, &voice, &text);
        }
        "orpheus" => {
            let model_id = args.get(2).cloned().unwrap_or_else(|| "orpheus-3b".into());
            let quant = args.get(3).cloned().unwrap_or_else(|| "q4".into());
            let voice = args.get(4).cloned().unwrap_or_else(|| "tara".into());
            let text = args
                .get(5)
                .cloned()
                .unwrap_or_else(|| DEFAULT_SENTENCE.into());
            run_orpheus(&model_id, &quant, &voice, &text);
        }
        "omnivoice" => {
            let model_id = args
                .get(2)
                .cloned()
                .unwrap_or_else(|| "omnivoice-0.6b".into());
            let voice = args.get(3).cloned().unwrap_or_else(|| "default".into());
            let lang = args.get(4).cloned().unwrap_or_else(|| "en-us".into());
            let ref_text = args.get(5).cloned().unwrap_or_default();
            let text = args
                .get(6)
                .cloned()
                .unwrap_or_else(|| DEFAULT_SENTENCE.into());
            run_omnivoice(&model_id, &voice, &lang, &ref_text, &text);
        }
        "audio8" => {
            let model_id = args
                .get(2)
                .cloned()
                .unwrap_or_else(|| "audio8-tts-0.6b".into());
            let voice = args.get(3).cloned().unwrap_or_default();
            let ref_text = args.get(4).cloned().unwrap_or_default();
            let text = args
                .get(5)
                .cloned()
                .unwrap_or_else(|| DEFAULT_SENTENCE.into());
            run_audio8(&model_id, &voice, &ref_text, &text);
        }
        other => {
            eprintln!(
                "unknown engine '{other}' (use: kitten | piper | supertonic | chatterbox | qwen3 | neutts | orpheus | omnivoice | audio8)"
            );
            std::process::exit(2);
        }
    }
}
