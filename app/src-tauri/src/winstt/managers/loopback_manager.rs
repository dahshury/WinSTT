// PORT IMPL — drafted against real APIs, pending compile. Source: app/PORT/05_*.md (Loopback),
// server/src/stt_server/loopback.py (LoopbackCapture + slow-tracking AGC). Uses the `wasapi` crate.
//
// LoopbackManager captures the system render endpoint (WASAPI loopback) and feeds
// the 16 kHz mono f32 stream into the recording pipeline as a second producer
// (the existing consumer mpsc — option 1, no Handy edits), applying a
// slow-tracking AGC. cpal cannot capture system output on Windows; the `wasapi`
// crate wraps IAudioClient in loopback mode.
//
// The WASAPI capture loop is the heavy native bit (gated to the compile loop);
// the manager owns the start/stop lifecycle + AGC state + the resampler, which
// compile unconditionally.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::AppHandle;

/// Slow-tracking automatic gain control, ported from loopback.py. Tracks the
/// signal envelope with a long time-constant so quiet meeting audio is lifted
/// toward a target RMS without pumping on transients.
#[derive(Clone, Debug)]
pub struct SlowAgc {
    /// Current applied gain.
    gain: f32,
    /// Target RMS the AGC drives the signal toward.
    target_rms: f32,
    /// Smoothing factor per block (closer to 1 = slower tracking).
    attack: f32,
    /// Hard ceiling so a silent stretch doesn't blow up gain.
    max_gain: f32,
}

impl Default for SlowAgc {
    fn default() -> Self {
        Self {
            gain: 1.0,
            target_rms: 0.05,
            attack: 0.995,
            max_gain: 12.0,
        }
    }
}

impl SlowAgc {
    /// Apply AGC in place to one block, updating the tracked gain.
    pub fn process(&mut self, block: &mut [f32]) {
        if block.is_empty() {
            return;
        }
        let sum_sq: f32 = block.iter().map(|s| s * s).sum();
        let rms = (sum_sq / block.len() as f32).sqrt();
        if rms > 1e-6 {
            let desired = (self.target_rms / rms).clamp(0.0, self.max_gain);
            // Slow exponential approach to the desired gain.
            self.gain = self.attack * self.gain + (1.0 - self.attack) * desired;
        }
        for s in block.iter_mut() {
            *s = (*s * self.gain).clamp(-1.0, 1.0);
        }
    }

    pub fn gain(&self) -> f32 {
        self.gain
    }
}

pub struct LoopbackManager {
    app: AppHandle,
    /// True while loopback capture is running (listen mode active).
    capturing: AtomicBool,
    agc: Mutex<SlowAgc>,
    /// Signals the capture worker to stop.
    stop_flag: std::sync::Arc<AtomicBool>,
}

impl LoopbackManager {
    pub fn new(app: &AppHandle) -> Self {
        Self {
            app: app.clone(),
            capturing: AtomicBool::new(false),
            agc: Mutex::new(SlowAgc::default()),
            stop_flag: std::sync::Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn is_capturing(&self) -> bool {
        self.capturing.load(Ordering::Acquire)
    }

    /// Begin loopback capture, spawning the WASAPI worker. The worker pushes
    /// AGC'd 16 kHz mono f32 blocks into the recording consumer. Idempotent.
    pub fn start(&self) -> Result<(), String> {
        if self.is_capturing() {
            return Ok(());
        }
        self.stop_flag.store(false, Ordering::Release);
        if let Ok(mut agc) = self.agc.lock() {
            *agc = SlowAgc::default();
        }
        // SPIKE: open the WASAPI render endpoint in loopback mode (`wasapi` crate:
        // get_default_device(Direction::Render) → IAudioClient init_loopback →
        // capture loop), resample to 16 kHz mono, AGC, push into the existing
        // recording consumer mpsc as a 2nd producer. Until the native loop lands,
        // mark capturing so the lifecycle (stop / listen-mode gate) is consistent.
        self.capturing.store(true, Ordering::Release);
        Ok(())
    }

    /// Stop loopback capture. Idempotent.
    pub fn stop(&self) {
        self.stop_flag.store(true, Ordering::Release);
        self.capturing.store(false, Ordering::Release);
    }

    pub fn app(&self) -> &AppHandle {
        &self.app
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agc_lifts_quiet_signal_toward_target() {
        let mut agc = SlowAgc::default();
        // A quiet block (rms ~0.005) should drive gain upward over time.
        let start_gain = agc.gain();
        for _ in 0..200 {
            let mut block = vec![0.005f32; 256];
            agc.process(&mut block);
        }
        assert!(agc.gain() > start_gain);
        assert!(agc.gain() <= 12.0);
    }

    #[test]
    fn agc_noop_on_empty_block() {
        let mut agc = SlowAgc::default();
        let mut empty: Vec<f32> = Vec::new();
        agc.process(&mut empty);
        assert_eq!(agc.gain(), 1.0);
    }
}
