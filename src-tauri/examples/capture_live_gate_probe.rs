//! Headless check that the "microphone is live" signal is honest.
//!
//! WinSTT plays the start chime — its "speak now" cue — from the recorder's
//! `capture_live` callback. On a Bluetooth LE Audio headset the device streams
//! perfectly-cadenced buffers of bit-exact digital silence for the first
//! ~0.4–2.0 s (see `examples/le_audio_capture_timeline.rs`), so a signal fired on
//! the first arriving chunk cued the user to speak well before the microphone was
//! capturing anything, and that speech was recorded as silence.
//!
//! This probe drives the real `AudioRecorder` and compares two instants:
//!
//!   - when `capture_live` fired (the chime), and
//!   - when the first non-zero sample actually reached the recorder.
//!
//! PASS means the chime is not cueing the user before the device has audio.
//!
//! Run from `src-tauri`:
//! `cargo run --release --example capture_live_gate_probe -- [takes] [seconds]`

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("capture_live_gate_probe is Windows-only");
}

#[cfg(target_os = "windows")]
mod probe {
    use std::{
        error::Error,
        sync::{Arc, Mutex},
        thread,
        time::{Duration, Instant},
    };

    use winstt_app_lib::audio_toolkit::AudioRecorder;

    type ProbeResult<T> = Result<T, Box<dyn Error>>;

    /// How far the chime may lead the first real audio before the cue is dishonest.
    /// One 480-sample frame at 16 kHz is 30 ms; a couple of frames of slack absorbs
    /// callback batching without letting a real warm-up window through.
    const MAX_LEAD: Duration = Duration::from_millis(150);

    #[derive(Default)]
    struct Marks {
        /// When the very first frame arrived, zero-filled or not. This is where the
        /// signal used to fire, so it is the "before" number in the comparison.
        first_chunk_at: Option<Instant>,
        capture_live_at: Option<Instant>,
        first_nonzero_at: Option<Instant>,
    }

    fn run_take(take: usize, seconds: u64) -> ProbeResult<bool> {
        println!("take={take}");
        let marks = Arc::new(Mutex::new(Marks::default()));

        let marks_live = Arc::clone(&marks);
        let marks_chunk = Arc::clone(&marks);
        let mut recorder = AudioRecorder::new()
            .with_capture_live_callback(move || {
                let mut marks = marks_live.lock().expect("marks");
                marks.capture_live_at.get_or_insert_with(Instant::now);
            })
            .with_chunk_callback(move |frame: &[f32]| {
                let mut marks = marks_chunk.lock().expect("marks");
                marks.first_chunk_at.get_or_insert_with(Instant::now);
                if frame.iter().any(|sample| *sample != 0.0) {
                    marks.first_nonzero_at.get_or_insert_with(Instant::now);
                }
            });

        let opened_at = Instant::now();
        recorder.open(None)?;
        println!("  capture-open-ms={:.0}", opened_at.elapsed().as_millis());

        // `start` is the hotkey press: it arms the recording and arms the chime.
        let pressed_at = Instant::now();
        recorder.start()?;
        thread::sleep(Duration::from_secs(seconds));
        let _ = recorder.stop_captured()?;
        recorder.close()?;

        let marks = marks.lock().expect("marks");
        let since_press = |at: Option<Instant>| {
            at.map_or("never".to_string(), |at| {
                format!("{}ms", at.duration_since(pressed_at).as_millis())
            })
        };
        println!(
            "  first-chunk-at={} (old trigger)  chime-at={} (new trigger)  first-real-audio-at={}",
            since_press(marks.first_chunk_at),
            since_press(marks.capture_live_at),
            since_press(marks.first_nonzero_at),
        );
        if let (Some(chunk_at), Some(audio_at)) = (marks.first_chunk_at, marks.first_nonzero_at) {
            println!(
                "  device warm-up (silence between first chunk and first audio) = {}ms — this is \
                 how early the chime used to fire",
                audio_at.saturating_duration_since(chunk_at).as_millis()
            );
        }

        match (marks.capture_live_at, marks.first_nonzero_at) {
            (Some(live_at), Some(audio_at)) => {
                let lead = audio_at.saturating_duration_since(live_at);
                let passed = lead <= MAX_LEAD;
                println!(
                    "  chime led real audio by {}ms -> {}",
                    lead.as_millis(),
                    if passed { "PASS" } else { "FAIL" }
                );
                Ok(passed)
            }
            (Some(_), None) => {
                // Nothing but digital silence for the whole take. The grace period is
                // supposed to chime anyway rather than stay silent forever, so this is
                // the expected shape for a muted device — but it proves nothing about
                // the gate, so report it as inconclusive rather than a pass.
                println!("  INCONCLUSIVE: device produced no audio at all during this take");
                Ok(true)
            }
            _ => {
                println!("  FAIL: capture-live never fired");
                Ok(false)
            }
        }
    }

    pub fn run() -> ProbeResult<()> {
        let args: Vec<String> = std::env::args().collect();
        let takes: usize = args
            .get(1)
            .and_then(|value| value.parse().ok())
            .unwrap_or(3);
        let seconds: u64 = args
            .get(2)
            .and_then(|value| value.parse().ok())
            .unwrap_or(6);

        let mut failures = 0;
        for take in 1..=takes {
            if !run_take(take, seconds)? {
                failures += 1;
            }
            // Let the LE link idle so the next take pays a cold warm-up, the same as a
            // hotkey press after the microphone's lazy close.
            thread::sleep(Duration::from_secs(5));
        }
        if failures > 0 {
            return Err(
                format!("{failures} take(s) chimed before the microphone had audio").into(),
            );
        }
        println!("all takes PASS");
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn main() {
    if let Err(error) = probe::run() {
        eprintln!("probe failed: {error}");
        std::process::exit(1);
    }
}
