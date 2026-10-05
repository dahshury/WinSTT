//! Offline probe: runs the REAL VAD code paths over audio files and prints, per file, one JSON
//! line with every pipeline's per-30 ms-frame speech mask plus timing — so a VAD model or
//! threshold change can be diffed against a reference (e.g. a Python port of the previous model).
//!
//! Pipelines (all at the production constants):
//!   * `raw`      — bare `SileroVad` at `VAD_SPEECH_THRESHOLD` (the long-form segmentation sweep);
//!   * `mic`      — `SmoothedVad(LiveVad(SileroVad), 15, 15, 2)` with the default runtime config
//!     (sensitivity 0.7, WebRTC energy pre-gate 3), labeled API incl. retro pre-roll flips;
//!   * `loopback` — `SmoothedVad(SileroVad @ loopback threshold, 15, 15, 2)`;
//!   * `compacted_samples` — length after `compact_for_transcription` (Silero-driven compaction).
//!
//! Usage: `cargo run --release --example vad_segments_probe -- [--loopback-threshold T] <file.wav|file.f32>...`
//! (`.f32` = raw little-endian 16 kHz mono f32; `.wav` must already be 16 kHz mono).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use winstt_app_lib::audio_toolkit::vad::{
    LiveVad, SILERO_VAD_RESOURCE, SileroVad, SmoothedVad, VAD_FRAME_SAMPLES, VAD_SPEECH_THRESHOLD,
    VadRuntimeConfig, VoiceActivityDetector,
};
use winstt_app_lib::winstt::stt::vad_segment::compact_for_transcription;

fn load(path: &Path) -> Vec<f32> {
    if path.extension().is_some_and(|e| e == "f32") {
        let bytes = std::fs::read(path).expect("read f32");
        return bytes
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
    }
    let mut reader = hound::WavReader::open(path).expect("open wav");
    let spec = reader.spec();
    assert_eq!(spec.sample_rate, 16_000, "{}: need 16 kHz", path.display());
    let ch = spec.channels as usize;
    let mono: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().map(Result::unwrap).collect(),
        hound::SampleFormat::Int => {
            let scale = (1u64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.unwrap() as f32 / scale)
                .collect()
        }
    };
    mono.chunks_exact(ch)
        .map(|c| c.iter().sum::<f32>() / ch as f32)
        .collect()
}

fn mask_string(mask: &[bool]) -> String {
    mask.iter().map(|&b| if b { '1' } else { '0' }).collect()
}

fn labeled(vad: &mut dyn VoiceActivityDetector, audio: &[f32]) -> Vec<bool> {
    let mut mask = Vec::new();
    for frame in audio.chunks_exact(VAD_FRAME_SAMPLES) {
        let label = vad.push_frame_labeled(frame).expect("vad");
        let n = mask.len();
        for m in &mut mask[n.saturating_sub(label.retro_frames)..] {
            *m = true;
        }
        mask.push(label.is_speech);
    }
    mask
}

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut loopback_threshold = 0.02f32; // LOOPBACK_VAD_SPEECH_THRESHOLD (loopback_manager.rs)
    if let Some(i) = args.iter().position(|a| a == "--loopback-threshold") {
        loopback_threshold = args[i + 1].parse().expect("threshold");
        args.drain(i..=i + 1);
    }
    let model = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(SILERO_VAD_RESOURCE);

    for file in &args {
        let audio = load(Path::new(file));
        let frames = audio.len() / VAD_FRAME_SAMPLES;

        // raw (segmentation sweep), timed
        let mut raw_vad = SileroVad::new(&model, VAD_SPEECH_THRESHOLD).expect("vad");
        let t = Instant::now();
        let raw: Vec<bool> = audio
            .chunks_exact(VAD_FRAME_SAMPLES)
            .map(|f| raw_vad.is_voice(f).expect("vad"))
            .collect();
        let us_per_frame = t.elapsed().as_secs_f64() * 1e6 / frames.max(1) as f64;

        let config = Arc::new(VadRuntimeConfig::new(true, 0.7, 3));
        let mut mic = SmoothedVad::new(
            Box::new(LiveVad::new(
                SileroVad::new(&model, VAD_SPEECH_THRESHOLD).expect("vad"),
                config,
            )),
            15,
            15,
            2,
        );
        let mic_mask = labeled(&mut mic, &audio);

        let mut lb = SmoothedVad::new(
            Box::new(SileroVad::new(&model, loopback_threshold).expect("vad")),
            15,
            15,
            2,
        );
        let lb_mask = labeled(&mut lb, &audio);

        let mut seg_vad = SileroVad::new(&model, VAD_SPEECH_THRESHOLD).expect("vad");
        let compacted = compact_for_transcription(&audio, &mut seg_vad).len();

        println!(
            "{}",
            serde_json::json!({
                "file": file,
                "secs": audio.len() as f64 / 16_000.0,
                "us_per_frame": us_per_frame,
                "raw": mask_string(&raw),
                "mic": mask_string(&mic_mask),
                "loopback": mask_string(&lb_mask),
                "compacted_samples": compacted,
                "samples": audio.len(),
            })
        );
    }
}
