//! Minimal raw-CPAL capture sanity check.
//!
//! `le_audio_transition_probe` reports per-frame RMS from the production
//! `AudioRecorder` (downmix + resample + VAD). When that reads exactly zero it is
//! ambiguous: the device could be delivering digital silence, or WinSTT's own
//! capture pipeline could be zeroing it. This example bypasses the pipeline
//! entirely and prints raw min/max/RMS straight from the CPAL input callback, so
//! the two cases can be told apart before any transition measurement is trusted.
//!
//! Run from `src-tauri`:
//! `cargo run --release --example raw_capture_probe -- [seconds]`

use std::{
    error::Error,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

#[derive(Default)]
struct Stats {
    frames: usize,
    samples: usize,
    min: f32,
    max: f32,
    sum_squares: f64,
    nonzero: usize,
}

fn main() -> Result<(), Box<dyn Error>> {
    let seconds: u64 = std::env::args()
        .nth(1)
        .and_then(|value| value.parse().ok())
        .unwrap_or(4);

    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("no default input device")?;
    let name = device.description().map_or_else(
        |_| "<unknown>".to_string(),
        |description| description.name().to_string(),
    );
    let config = device.default_input_config()?;
    println!(
        "device={name:?} sample_rate={} channels={} format={:?}",
        config.sample_rate(),
        config.channels(),
        config.sample_format()
    );

    let stats = Arc::new(Mutex::new(Stats::default()));
    let callbacks = Arc::new(AtomicUsize::new(0));
    let stats_cb = Arc::clone(&stats);
    let callbacks_cb = Arc::clone(&callbacks);

    let stream = device.build_input_stream(
        &config.into(),
        move |data: &[f32], _: &cpal::InputCallbackInfo| {
            callbacks_cb.fetch_add(1, Ordering::Relaxed);
            let mut stats = stats_cb.lock().expect("stats mutex");
            stats.frames += 1;
            stats.samples += data.len();
            for &sample in data {
                stats.min = stats.min.min(sample);
                stats.max = stats.max.max(sample);
                stats.sum_squares += f64::from(sample) * f64::from(sample);
                if sample != 0.0 {
                    stats.nonzero += 1;
                }
            }
        },
        |error| eprintln!("stream error: {error}"),
        None,
    )?;
    stream.play()?;
    println!("capturing for {seconds}s — make some noise into the microphone...");

    for elapsed in 1..=seconds {
        thread::sleep(Duration::from_secs(1));
        let stats = stats.lock().expect("stats mutex");
        let rms = if stats.samples == 0 {
            0.0
        } else {
            (stats.sum_squares / stats.samples as f64).sqrt()
        };
        println!(
            "  t={elapsed}s callbacks={} samples={} nonzero={} min={:.6} max={:.6} rms={rms:.6}",
            stats.frames, stats.samples, stats.nonzero, stats.min, stats.max
        );
    }

    drop(stream);
    let stats = stats.lock().expect("stats mutex");
    if stats.nonzero == 0 {
        println!(
            "VERDICT: device delivered {} samples of EXACT digital silence — the endpoint is not \
             producing audio, so any transition measurement taken against it is meaningless.",
            stats.samples
        );
    } else {
        let ratio = stats.nonzero as f64 / stats.samples.max(1) as f64;
        println!(
            "VERDICT: device is live ({:.1}% non-zero samples, peak {:.4}).",
            ratio * 100.0,
            stats.max.abs().max(stats.min.abs())
        );
    }
    Ok(())
}
