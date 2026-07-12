// Linux (PipeWire / PulseAudio) system-audio loopback for Listen mode.
//
// cpal cannot capture the render endpoint on Linux any more than it can on
// Windows, so — mirroring the WASAPI render-loopback trick — we capture the
// DEFAULT SINK MONITOR through a child process:
//
//   * `pw-record` (the PipeWire capture tool) is preferred. Its default record
//     target is the default SOURCE (the mic), so we only use it when we can name
//     the monitor node (`<default-sink>.monitor`), passing it via `--target`.
//   * `parec` (the PulseAudio-compat tool, still present on PipeWire systems via
//     `pipewire-pulse`) is the fallback. It resolves the default sink monitor
//     with the special `@DEFAULT_MONITOR@` device token, so it works even when we
//     cannot enumerate the monitor node name.
//
// The child is asked for raw signed-16-bit little-endian mono PCM at a fixed
// capture rate. A reader thread parses whole i16 frames off the child's stdout,
// runs the SAME slow-tracking AGC (int16 domain, Python parity) as the Windows
// path, converts to f32, resamples to 16 kHz mono in 30 ms frames, and pushes
// them onto the manager's `sink` — byte-for-byte the same downstream contract.
//
// `stop()` kills the child (so stdout hits EOF), joins the reader thread, and the
// reader dropping `sink` closes the channel the consumer loop drains.

use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::thread::JoinHandle;
use std::time::Duration;

use super::{DeviceInfo, LoopbackDeviceInfo, LoopbackError, SlowTrackingAgc, i16_to_f32};
use crate::audio_toolkit::audio::FrameResampler;
use crate::audio_toolkit::constants::WHISPER_SAMPLE_RATE;

/// Capture rate requested from the monitor. PipeWire/PulseAudio convert the
/// monitor's native format to this; we then resample to 16 kHz for the model.
/// 48 kHz is the near-universal desktop-audio rate, so the request is a no-op
/// resample on most systems and the AGC still runs at device rate (Python parity).
const CAPTURE_RATE: u32 = 48_000;
/// Resampler frame size (matches the recorder's 30 ms emit cadence so the
/// downstream Silero VAD receives whole 30 ms / 480-sample frames).
const RESAMPLER_FRAME_MS: u64 = 30;
/// PulseAudio special device token for the default sink's monitor source.
const DEFAULT_MONITOR_TOKEN: &str = "@DEFAULT_MONITOR@";

/// A live Linux capture session: the child process plus its reader thread.
pub(super) struct LinuxSession {
    child: Child,
    stop: Arc<AtomicBool>,
    reader: Option<JoinHandle<()>>,
}

impl LinuxSession {
    /// Kill the child (stdout EOF unblocks the reader) and join the reader thread.
    /// The reader dropping `sink` on exit closes the consumer channel.
    pub(super) fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

impl Drop for LinuxSession {
    fn drop(&mut self) {
        // Safety net if the session is dropped without an explicit stop() (e.g.
        // LoopbackCapture::drop). Kill + detach; the reader exits on EOF.
        self.stop.store(true, Ordering::SeqCst);
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

/// Resolve the default sink's monitor node name via `pactl get-default-sink`
/// (its monitor source is `<sink>.monitor`). `None` if pactl is missing/failed.
fn default_monitor_name() -> Option<String> {
    let out = Command::new("pactl")
        .arg("get-default-sink")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let sink = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if sink.is_empty() {
        return None;
    }
    Some(format!("{sink}.monitor"))
}

fn spawn_pw_record(target: &str) -> std::io::Result<Child> {
    Command::new("pw-record")
        .arg("--target")
        .arg(target)
        .arg(format!("--rate={CAPTURE_RATE}"))
        .arg("--channels=1")
        .arg("--format=s16")
        .arg("--raw")
        .arg("-") // write raw PCM to stdout
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
}

fn spawn_parec(device: &str) -> std::io::Result<Child> {
    Command::new("parec")
        .arg("--format=s16le")
        .arg(format!("--rate={CAPTURE_RATE}"))
        .arg("--channels=1")
        .arg(format!("--device={device}"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
}

/// Open the default sink monitor (or `device_id` if given) and start streaming.
pub(super) fn start(
    device_id: Option<String>,
    sink: Sender<Vec<f32>>,
) -> Result<(DeviceInfo, LinuxSession), LoopbackError> {
    // Explicit selection wins; otherwise resolve the default sink monitor.
    let monitor = device_id
        .filter(|s| !s.is_empty() && s != DEFAULT_MONITOR_TOKEN)
        .or_else(default_monitor_name);

    // Prefer pw-record when we have a concrete monitor node to target (its
    // default target is the mic, not the monitor). Fall back to parec, which can
    // resolve the default monitor itself via @DEFAULT_MONITOR@.
    let mut spawned: Option<(Child, String)> = None;
    if let Some(target) = monitor.as_deref() {
        match spawn_pw_record(target) {
            Ok(child) => spawned = Some((child, target.to_string())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                log::info!("[loopback] pw-record not found; falling back to parec");
            }
            Err(e) => {
                log::warn!("[loopback] pw-record spawn failed ({e}); falling back to parec");
            }
        }
    }

    if spawned.is_none() {
        let device = monitor.unwrap_or_else(|| DEFAULT_MONITOR_TOKEN.to_string());
        match spawn_parec(&device) {
            Ok(child) => spawned = Some((child, device)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(LoopbackError::Backend(
                    "no PipeWire/PulseAudio capture tool found: install `pw-record` (pipewire) \
                     or `parec` (pulseaudio-utils) for system-audio Listen mode"
                        .to_string(),
                ));
            }
            Err(e) => {
                return Err(LoopbackError::Backend(format!(
                    "failed to spawn parec: {e}"
                )));
            }
        }
    }

    let (mut child, target_name) = spawned.expect("a child was spawned or we returned early");
    let stdout = match child.stdout.take() {
        Some(out) => out,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(LoopbackError::Backend(
                "capture child produced no stdout pipe".to_string(),
            ));
        }
    };

    let stop = Arc::new(AtomicBool::new(false));
    let reader_stop = stop.clone();
    let reader = std::thread::Builder::new()
        .name("loopback-capture-linux".to_string())
        .spawn(move || reader_loop(stdout, sink, reader_stop))
        .map_err(|e| {
            let _ = child.kill();
            let _ = child.wait();
            LoopbackError::Backend(format!("spawn capture reader thread: {e}"))
        })?;

    let info = DeviceInfo {
        id: target_name.clone(),
        name: target_name,
        sample_rate: CAPTURE_RATE,
        channels: 1,
    };
    Ok((
        info,
        LinuxSession {
            child,
            stop,
            reader: Some(reader),
        },
    ))
}

/// Reader thread: parse s16le mono PCM off the child stdout, AGC, resample to
/// 16 kHz, and forward 30 ms f32 frames to `sink`. Exits on EOF, stop, or a
/// closed consumer; flushes the resampler tail before returning.
fn reader_loop<R: Read>(mut stdout: R, sink: Sender<Vec<f32>>, stop: Arc<AtomicBool>) {
    let mut agc = SlowTrackingAgc::new();
    let mut resampler = match FrameResampler::try_new(
        CAPTURE_RATE as usize,
        WHISPER_SAMPLE_RATE as usize,
        Duration::from_millis(RESAMPLER_FRAME_MS),
    ) {
        Ok(r) => r,
        Err(e) => {
            log::error!("[loopback] failed to build resampler: {e}");
            return;
        }
    };

    let mut buf = [0u8; 8192];
    // Carries a trailing odd byte between reads so i16 frames never split.
    let mut pending: Vec<u8> = Vec::new();
    let mut send_closed = false;

    while !stop.load(Ordering::SeqCst) {
        let n = match stdout.read(&mut buf) {
            Ok(0) => break, // EOF: child exited (or was killed by stop()).
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };

        pending.extend_from_slice(&buf[..n]);
        let usable = pending.len() & !1; // whole i16 samples only
        if usable == 0 {
            continue;
        }

        let mut mono: Vec<i16> = pending[..usable]
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]))
            .collect();
        pending.drain(0..usable);

        // AGC at capture rate, int16 domain (Python parity), then f32 + resample.
        agc.process(&mut mono);
        let device_f32 = i16_to_f32(&mono);
        resampler.push(&device_f32, |frame: &[f32]| {
            if send_closed {
                return;
            }
            if sink.send(frame.to_vec()).is_err() {
                send_closed = true;
            }
        });
        if send_closed {
            break; // consumer gone
        }
    }

    // Flush the resampler's buffered tail before the sink drops.
    resampler.finish(|frame: &[f32]| {
        let _ = sink.send(frame.to_vec());
    });
    // `sink` drops here → the consumer channel closes.
}

/// Enumerate monitor sources via `pactl list short sources`, marking the default
/// sink's monitor. Falls back to a single synthetic default-monitor entry so
/// Listen mode is always selectable even when enumeration is unavailable.
pub(super) fn list_devices() -> Result<Vec<LoopbackDeviceInfo>, LoopbackError> {
    let default_monitor = default_monitor_name();
    let mut out = Vec::new();

    if let Ok(output) = Command::new("pactl")
        .arg("list")
        .arg("short")
        .arg("sources")
        .output()
        && output.status.success()
    {
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            // Columns: INDEX \t NAME \t DRIVER \t SAMPLE_SPEC \t STATE
            let mut cols = line.split('\t');
            let _index = cols.next();
            if let Some(name) = cols.next() {
                let name = name.trim();
                if name.contains(".monitor") {
                    let is_default = default_monitor.as_deref() == Some(name);
                    out.push(LoopbackDeviceInfo {
                        id: name.to_string(),
                        name: name.to_string(),
                        is_default,
                    });
                }
            }
        }
    }

    if out.is_empty() {
        // At minimum expose the default monitor so the mode stays selectable.
        if let Some(name) = default_monitor {
            out.push(LoopbackDeviceInfo {
                id: name.clone(),
                name,
                is_default: true,
            });
        } else {
            out.push(LoopbackDeviceInfo {
                id: DEFAULT_MONITOR_TOKEN.to_string(),
                name: "System Audio (default monitor)".to_string(),
                is_default: true,
            });
        }
    }

    Ok(out)
}
