//! Manual probe: quantifies end-of-recording capture loss against the REAL default mic.
//!
//! Opens the app's `AudioRecorder` exactly like production (native device rate, resampler,
//! ungated buffer), records for a fixed wall-clock window, stops, and compares the captured
//! sample count against the wall-clock span from the FIRST delivered frame to the stop call.
//! A perfect capture yields `loss_ms ~= 0 (+/- one device buffer of jitter)`; a positive
//! `loss_ms` in the hundreds means the stop path is dropping the recording tail — the bug
//! being hunted. Run manually: `cargo run --example capture_tail_probe [take_ms] [takes]`.
//!
//! The first delivered chunk contains audio captured over the preceding device period, so
//! each measurement carries ~one-buffer (+/-10-30 ms) of jitter; run several takes and read
//! the median. No VAD is attached: the mask path only labels frames and cannot change the
//! sample count, so the probe measures the pure capture/stop/resample chain.

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use std::time::{Duration, Instant};

use winstt_app_lib::audio_toolkit::AudioRecorder;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let take_ms: u64 = args.get(1).and_then(|a| a.parse().ok()).unwrap_or(3000);
    let takes: usize = args.get(2).and_then(|a| a.parse().ok()).unwrap_or(5);

    let first_frame_at: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
    let chunk_frames = Arc::new(AtomicUsize::new(0));

    let ff = Arc::clone(&first_frame_at);
    let cf = Arc::clone(&chunk_frames);
    let mut rec = AudioRecorder::new()
        .with_capture_live_callback(move || {
            *ff.lock().unwrap() = Some(Instant::now());
        })
        .with_chunk_callback(move |frame: &[f32]| {
            cf.fetch_add(frame.len(), Ordering::Relaxed);
        });

    if let Err(err) = rec.open(None) {
        eprintln!("failed to open recorder: {err}");
        std::process::exit(1);
    }
    let device_name = {
        use cpal::traits::{DeviceTrait, HostTrait};
        cpal::default_host()
            .default_input_device()
            .and_then(|d| d.description().ok().map(|d| d.name().to_string()))
            .unwrap_or_else(|| "<unknown>".into())
    };
    println!(
        "recorder open on default device '{device_name}'; running {takes} takes of {take_ms} ms each"
    );

    let mut losses: Vec<f64> = Vec::new();
    for take in 0..takes {
        *first_frame_at.lock().unwrap() = None;
        let t_start_cmd = Instant::now();
        rec.start().expect("start");
        std::thread::sleep(Duration::from_millis(take_ms));
        let t_stop_call = Instant::now();
        let captured = rec.stop_captured().expect("stop");
        let stop_latency_ms = t_stop_call.elapsed().as_secs_f64() * 1000.0;

        let Some(t_first) = *first_frame_at.lock().unwrap() else {
            eprintln!("take {take}: no frame ever arrived (mic dead?)");
            continue;
        };
        let open_latency_ms = t_first.duration_since(t_start_cmd).as_secs_f64() * 1000.0;
        let wall_ms = t_stop_call.duration_since(t_first).as_secs_f64() * 1000.0;
        let captured_ms = captured.samples.len() as f64 / 16.0;
        let loss_ms = wall_ms - captured_ms;
        losses.push(loss_ms);
        println!(
            "take {take}: open_latency_ms={open_latency_ms:.1} wall_ms={wall_ms:.1} captured_ms={captured_ms:.1} \
             loss_ms={loss_ms:.1} stop_call_ms={stop_latency_ms:.1} samples={} mask_frames={}",
            captured.samples.len(),
            captured.speech_mask.len(),
        );
        std::thread::sleep(Duration::from_millis(300));
    }

    if !losses.is_empty() {
        losses.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let median = losses[losses.len() / 2];
        println!(
            "median_loss_ms={median:.1} min={:.1} max={:.1}",
            losses.first().unwrap(),
            losses.last().unwrap()
        );
    }
    let _ = rec.close();
}
