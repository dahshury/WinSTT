// TTS de-risking spike (mirrors stt_spike.rs). Proves the in-process Kokoro-82M
// ONNX engine + espeak-ng FFI phonemizer synthesize a real cached voice
// end-to-end. NOT shipped — a `cargo run --example tts_spike` harness only.
//
//   cargo run --release --example tts_spike                       # af_heart, en-us, default sentence
//   cargo run --release --example tts_spike -- am_michael         # pick a voice (lang inferred from catalog)
//   cargo run --release --example tts_spike -- af_heart "custom text here"
//   cargo run --release --example tts_spike -- --multi            # synth a representative voice per language
//   SPIKE_TTS_DEVICE=dml cargo run --release --example tts_spike  # measure the DirectML/GPU path
//
// Model files (auto-detected, override with WINSTT_KOKORO_DIR):
//   %LOCALAPPDATA%/winstt/tts/kokoro/{kokoro-v1.0.fp16.onnx, voices-v1.0.bin}
//
// Output: writes a 24 kHz mono WAV per synthesis to the CWD (tts_spike_<voice>.wav)
//   so the audio can be auditioned, and prints: token count, synth time,
//   output samples/duration, RTF (synth_time / audio_duration).

use std::path::PathBuf;
use std::time::Instant;

use winstt_app_lib::winstt::tts::kokoro::{
    KokoroConfig, KokoroDevice, KokoroEngine, KOKORO_SAMPLE_RATE,
};
use winstt_app_lib::winstt::tts::phonemize::{default_phonemizer, resolve_espeak_lib};
use winstt_app_lib::winstt::tts::{voice_by_id, KOKORO_VOICE_CATALOG};

const DEFAULT_SENTENCE: &str = "The quick brown fox jumps over the lazy dog.";

/// Resolve the Kokoro cache dir (holds kokoro-v1.0.fp16.onnx + voices-v1.0.bin).
fn kokoro_cache_dir() -> PathBuf {
    if let Ok(d) = std::env::var("WINSTT_KOKORO_DIR") {
        return PathBuf::from(d);
    }
    // Fall back to %USERPROFILE%\AppData\Local (or $HOME) rather than a
    // machine-specific absolute path, so the spike isn't pinned to one layout.
    let local = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let home = std::env::var("USERPROFILE")
                .or_else(|_| std::env::var("HOME"))
                .unwrap_or_default();
            PathBuf::from(home).join("AppData/Local")
        });
    local.join("winstt/tts/kokoro-82m")
}

fn device_from_env() -> KokoroDevice {
    match std::env::var("SPIKE_TTS_DEVICE")
        .unwrap_or_default()
        .to_lowercase()
        .as_str()
    {
        "dml" | "directml" => KokoroDevice::DirectMl,
        "cpu" => KokoroDevice::Cpu,
        _ => KokoroDevice::Cpu, // CPU default → comparable to the reference CPU path
    }
}

/// Write mono f32 samples to a 16-bit PCM WAV so they can be auditioned.
fn write_wav(path: &str, samples: &[f32], sample_rate: u32) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).expect("create wav");
    for &s in samples {
        let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        writer.write_sample(v).expect("write sample");
    }
    writer.finalize().expect("finalize wav");
}

/// Quick audio sanity stats: peak, RMS, NaN count, leading/trailing silence.
fn audio_stats(samples: &[f32]) -> (f32, f32, usize) {
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

fn build_engine() -> KokoroEngine {
    let cache_dir = kokoro_cache_dir();
    eprintln!("kokoro cache dir : {}", cache_dir.display());
    let model = cache_dir.join("onnx").join("model_fp16.onnx");
    let voices = cache_dir.join("voices").join("af_heart.bin");
    if !model.exists() || !voices.exists() {
        eprintln!(
            "FATAL: kokoro model not cached (onnx-community layout).\n  model:  {} (exists={})\n  voices: {} (exists={})\n\
             Run the app once to download, or set WINSTT_KOKORO_DIR.",
            model.display(),
            model.exists(),
            voices.display(),
            voices.exists()
        );
        std::process::exit(2);
    }
    let cfg = KokoroConfig {
        cache_dir,
        model_filename: "model_fp16.onnx".to_string(),
        voices_dir: "voices".to_string(),
        device: device_from_env(),
    };
    KokoroEngine::new(cfg)
}

/// Synthesize one voice and print the parity/timing report. Returns the synth
/// time in ms for the warm pass.
fn synth_one(engine: &KokoroEngine, voice: &str, lang: &str, text: &str) {
    // Phoneme/token visibility: run the phonemizer standalone so we can print
    // the token count + a sample of the IPA stream (sanity vs the Python path).
    let phon = default_phonemizer();
    let ipa = phon.phonemize(text, lang).unwrap_or_else(|e| {
        eprintln!("  [phonemize WARN] {e}");
        String::new()
    });
    let tokens = phon.tokenize(&ipa).unwrap_or_default();
    eprintln!("\n--- voice={voice} lang={lang} ---");
    eprintln!("  text     : {text:?}");
    eprintln!("  phonemes : {ipa:?}");
    eprintln!(
        "  n_tokens : {} (incl. pad +2 → {})",
        tokens.len(),
        tokens.len() + 2
    );

    // Cold pass (session create + first inference) then warm pass (steady-state).
    for label in ["cold", "warm"] {
        let t = Instant::now();
        match engine.synthesize(text, voice, lang, 1.0) {
            Ok(samples) => {
                let dt = t.elapsed();
                let dur = samples.len() as f32 / KOKORO_SAMPLE_RATE as f32;
                let (peak, rms, nan) = audio_stats(&samples);
                let rtf = if dur > 0.0 {
                    dt.as_secs_f32() / dur
                } else {
                    f32::INFINITY
                };
                let ok = !samples.is_empty() && nan == 0 && peak > 1e-4;
                eprintln!(
                    "  [{label}] synth={:>7.1}ms  samples={}  dur={:.2}s  RTF={:.3}  peak={:.3} rms={:.4} nan={}  audio_ok={}",
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
                    let out = format!("tts_spike_{voice}.wav");
                    write_wav(&out, &samples, KOKORO_SAMPLE_RATE);
                    eprintln!("  wrote {out}");
                }
            }
            Err(e) => {
                eprintln!("  [{label}] SYNTH FAILED: {e}");
                std::process::exit(6);
            }
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    eprintln!("=== TTS SPIKE ===");
    eprintln!("device   : {:?}", device_from_env());
    match resolve_espeak_lib() {
        Some((lib, data)) => eprintln!("espeak-ng: {} (data {:?})", lib.display(), data),
        None => eprintln!("espeak-ng: NOT FOUND → degraded NullPhonemizer fallback"),
    }

    let engine = build_engine();

    // --multi: one representative voice per language in the catalog.
    if args.get(1).map(|s| s == "--multi").unwrap_or(false) {
        let mut seen: Vec<&str> = Vec::new();
        for v in KOKORO_VOICE_CATALOG {
            if seen.contains(&v.language) {
                continue;
            }
            seen.push(v.language);
            synth_one(&engine, v.id, v.language, DEFAULT_SENTENCE);
        }
        return;
    }

    let voice = args
        .get(1)
        .cloned()
        .unwrap_or_else(|| "af_heart".to_string());
    let lang = voice_by_id(&voice)
        .map(|v| v.language.to_string())
        .unwrap_or_else(|| "en-us".to_string());
    let text = args
        .get(2)
        .cloned()
        .unwrap_or_else(|| DEFAULT_SENTENCE.to_string());

    synth_one(&engine, &voice, &lang, &text);
}
