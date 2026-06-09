// Tier-1 TTS engine de-risk spike. Proves Kitten / Piper / Supertonic load + synthesize
// end-to-end from cached HF files, reports latency/RTF, and writes an audible WAV.
//
//   cargo run --release --example tts_engine_spike -- kitten
//   cargo run --release --example tts_engine_spike -- kitten expr-voice-2-f "custom text"
//   cargo run --release --example tts_engine_spike -- piper
//   cargo run --release --example tts_engine_spike -- supertonic M3 en
//   cargo run --release --example tts_engine_spike -- supertonic M3 fr "Bonjour, ceci est une courte démonstration."
//
// Model files live under  E:/DL/Projects/WinSTT/.tts-cache/<engine>/  (override WINSTT_TTS_CACHE).
// espeak-ng is auto-pointed at the app-data runtime if it has been installed.

use std::path::PathBuf;
use std::time::Instant;

use winstt_app_lib::winstt::tts::chatterbox::{
    ChatterboxConfig, ChatterboxEngine, CHATTERBOX_SAMPLE_RATE,
};
use winstt_app_lib::winstt::tts::kitten::{
    KittenConfig, KittenDevice, KittenEngine, KITTEN_SAMPLE_RATE,
};
use winstt_app_lib::winstt::tts::piper::{PiperConfig, PiperEngine};
use winstt_app_lib::winstt::tts::supertonic::{
    SupertonicConfig, SupertonicEngine, SUPERTONIC_SAMPLE_RATE,
};

const DEFAULT_SENTENCE: &str = "The quick brown fox jumps over the lazy dog.";

fn cache_root() -> PathBuf {
    std::env::var("WINSTT_TTS_CACHE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("E:/DL/Projects/WinSTT/.tts-cache"))
}

fn ensure_espeak() {
    if std::env::var_os("ESPEAK_NG_LIBRARY").is_none() {
        if let Some(lib) = std::env::var_os("LOCALAPPDATA")
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
            std::env::set_var("ESPEAK_NG_LIBRARY", lib);
        }
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
        let out = format!("tts_spike_{engine}_{voice}.wav");
        write_wav(&out, samples, sr);
        eprintln!("  wrote {out}");
    }
}

fn run_kitten(voice: &str, text: &str) {
    let cfg = KittenConfig {
        cache_dir: cache_root().join("kitten"),
        device: KittenDevice::Cpu,
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

fn run_chatterbox(text: &str) {
    let cfg = ChatterboxConfig {
        cache_dir: cache_root().join("chatterbox-multilingual"),
        ..Default::default()
    };
    let engine = ChatterboxEngine::new(cfg);
    eprintln!("\n=== CHATTERBOX (default voice, zero-shot clone) ===");
    for label in ["cold", "warm"] {
        let t = Instant::now();
        match engine.synthesize(text, None, 0.5) {
            Ok(s) => {
                report(
                    "chatterbox",
                    "default",
                    label,
                    t.elapsed(),
                    &s,
                    CHATTERBOX_SAMPLE_RATE,
                );
            }
            Err(e) => {
                eprintln!("  [{label}] FAILED: {e}");
                std::process::exit(6);
            }
        }
    }
}

fn main() {
    ensure_espeak();
    let args: Vec<String> = std::env::args().collect();
    let engine = args.get(1).map(|s| s.as_str()).unwrap_or("kitten");
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
            let text = args
                .get(2)
                .cloned()
                .unwrap_or_else(|| DEFAULT_SENTENCE.into());
            run_chatterbox(&text);
        }
        other => {
            eprintln!("unknown engine '{other}' (use: kitten | piper | supertonic | chatterbox)");
            std::process::exit(2);
        }
    }
}
