// Orpheus decode-runaway probe — why `leah` never emits AUDIO_EOS, and whether the other
// seven voices do the same.
//
//   cargo run --release --example orpheus_loop_probe
//   cargo run --release --example orpheus_loop_probe -- "custom sentence"
//   ORPHEUS_PROBE_VOICES=tara,leah  restrict the sweep (default: all 8)
//   ORPHEUS_PROBE_TEMP=0            decode greedy instead of the shipped 0.6
//
// Loads the q4 graph + SNAC decoder ONCE and sweeps all 8 voices twice: penalty OFF (1.0 —
// the configuration this port shipped with) and penalty ON (1.1 — what upstream states is
// "required for stable generations"). For each render it reports the stop reason, the token
// count, and a per-second RMS envelope, because a degenerate loop shows up as an envelope
// pinned to one value for many seconds while a healthy render varies continuously.
//
// The engine's loop detector stays ARMED in both arms. Grinding a known runaway all the way
// to the 2,800-token cap costs ~25 minutes per voice and proves nothing the cut does not:
// the cut fires at the loop onset and reports the cycle period, so "voice X loops" is
// measured directly. `leah`'s uncut cap behaviour (2,800 tokens / 34.05 s / RTF 43.73) is
// already recorded in tts/catalog.rs.
//
// Model files live under <repo>/.tts-cache/orpheus-3b/ (override WINSTT_TTS_CACHE), the same
// layout the download manifest produces.

use std::path::PathBuf;
use std::time::Instant;

use winstt_app_lib::winstt::tts::orpheus::{
    ORPHEUS_SAMPLE_RATE, ORPHEUS_VOICES, OrpheusEngine, OrpheusStop,
};

const SENTENCE: &str =
    "The quick brown fox jumps over the lazy dog, and honestly, it never gets old.";

fn cache_root() -> PathBuf {
    std::env::var("WINSTT_TTS_CACHE").map_or_else(|_| PathBuf::from("../.tts-cache"), PathBuf::from)
}

/// Per-second RMS. A healthy render varies continuously; a degenerate cycle pins this to one
/// value (the reported `leah` runaway sat at exactly 0.112 for 28 s).
fn rms_envelope(pcm: &[f32], sr: usize) -> Vec<f32> {
    pcm.chunks(sr)
        .map(|w| (w.iter().map(|x| x * x).sum::<f32>() / w.len().max(1) as f32).sqrt())
        .collect()
}

/// How many of the per-second RMS buckets repeat a value already seen (to 3 dp). High counts
/// mean the signal is stuck.
fn pinned_seconds(env: &[f32]) -> usize {
    let mut seen = std::collections::HashSet::new();
    env.iter()
        .filter(|&&v| !seen.insert((v * 1000.0).round() as i32))
        .count()
}

fn main() {
    let sentence = std::env::args().nth(1).unwrap_or_else(|| SENTENCE.into());
    // ORPHEUS_PROBE_TEMP=0 forces greedy. Useful for splitting a bad render between the
    // sampler and the weights: argmax removes every stochastic degree of freedom, so garbled
    // greedy output indicts the q4 graph rather than the draw.
    let temperature: f32 = std::env::var("ORPHEUS_PROBE_TEMP")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0.6);
    // ORPHEUS_PROBE_VOICES=tara,leah restricts the sweep; default is all 8.
    let voices: Vec<&str> = match std::env::var("ORPHEUS_PROBE_VOICES") {
        Ok(list) => ORPHEUS_VOICES
            .iter()
            .copied()
            .filter(|v| list.split(',').any(|w| w.trim() == *v))
            .collect(),
        Err(_) => ORPHEUS_VOICES.to_vec(),
    };
    let dir = cache_root().join("orpheus-3b");
    eprintln!("cache: {}", dir.display());
    eprintln!("text : {sentence:?}");
    eprintln!("temp : {temperature}\n");

    let mut eng = OrpheusEngine::load(
        &dir.join("onnx/model_q4.onnx"),
        &dir.join("snac/decoder_model.onnx"),
        &dir.join("tokenizer.json"),
    )
    .expect("load orpheus");

    for penalty in [1.0_f64, 1.1] {
        eng.set_repetition_penalty(penalty);
        eprintln!("======== repetition_penalty = {penalty} ========");
        eprintln!(
            "{:<6} {:>7} {:>8} {:>7} {:>7} {:>6}  {:<22} envelope",
            "voice", "tokens", "dur(s)", "RTF", "rms", "pin", "stop"
        );
        for &voice in &voices {
            let t = Instant::now();
            let out = match eng.synthesize(&sentence, voice, temperature) {
                Ok(o) => o,
                Err(e) => {
                    eprintln!("{voice:<6} FAILED: {e}");
                    continue;
                }
            };
            let dt = t.elapsed().as_secs_f32();
            let dur = out.samples.len() as f32 / ORPHEUS_SAMPLE_RATE as f32;
            let rms = (out.samples.iter().map(|x| x * x).sum::<f32>()
                / out.samples.len().max(1) as f32)
                .sqrt();
            let env = rms_envelope(&out.samples, ORPHEUS_SAMPLE_RATE as usize);
            let shown: Vec<String> = env.iter().take(12).map(|v| format!("{v:.3}")).collect();
            let stop = match out.stop {
                OrpheusStop::Eos => "Eos".to_string(),
                OrpheusStop::LoopCut { frames, dropped } => {
                    format!("LoopCut{{{frames}f,-{dropped}}}")
                }
                OrpheusStop::Cap => "Cap".to_string(),
            };
            eprintln!(
                "{voice:<6} {:>7} {dur:>8.2} {:>7.2} {rms:>7.4} {:>6}  {stop:<22} {}{}",
                out.tokens,
                dt / dur.max(1e-6),
                pinned_seconds(&env),
                shown.join(" "),
                if env.len() > 12 { " …" } else { "" }
            );
            let tag = if penalty > 1.0 { "pen" } else { "raw" };
            write_wav(
                &format!("orpheus_probe_{tag}_{voice}.wav"),
                &out.samples,
                ORPHEUS_SAMPLE_RATE,
            );
        }
        eprintln!();
    }
}

fn write_wav(path: &str, pcm: &[f32], sr: u32) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: sr,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(path, spec).expect("create wav");
    for &s in pcm {
        w.write_sample((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
            .expect("write");
    }
    w.finalize().expect("finalize");
}
