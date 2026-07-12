use crate::audio_toolkit::{
    AudioRecorder, CapturedAudio, CpalDeviceInfo, RealtimeAudioProgress, SileroVad,
    list_input_devices,
    vad::{SmoothedVad, VAD_SPEECH_THRESHOLD},
};
use crate::helpers::clamshell;
use crate::winstt::settings_schema::{MicrophoneRelease, RecordingMode, WinsttSettings};
use crate::winstt::settings_store::read_settings_raw;
use crate::winstt::sync_ext::MutexExt;
use log::{debug, error, info, warn};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;

const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const TOGGLE_SILENCE_STOP_MIN_SECONDS: f64 = 0.1;
const TOGGLE_SILENCE_STOP_MAX_SECONDS: f64 = 10.0;
const TOGGLE_SILENCE_STOP_DEFAULT_SECONDS: f64 = 0.7;
const TOGGLE_SILENCE_STOP_BINDING: &str = "transcribe";

/// A Toggle/Wakeword recording that never sees a smoothed-VAD speech ONSET is aborted after this
/// long and DISCARDED (no decode, no paste). Without an onset the offset-armed silence auto-stop
/// (`schedule_toggle_silence_stop`, which only arms on a speech-OFF transition) never arms, so an
/// untouched toggle session would otherwise record forever. PTT is exempt (its stop is the key
/// release). The first onset cancels this watchdog for the whole session.
const TOGGLE_NO_SPEECH_WATCHDOG: Duration = Duration::from_secs(15);

pub(crate) fn silence_auto_stop_delay(settings: &WinsttSettings) -> Option<Duration> {
    match settings.general.recording_mode {
        RecordingMode::Toggle if settings.general.manual_toggle_stop => return None,
        RecordingMode::Toggle | RecordingMode::Wakeword => {}
        _ => return None,
    }

    let raw_seconds = settings.audio.post_speech_silence_duration;
    let seconds = if raw_seconds.is_finite() {
        raw_seconds
    } else {
        TOGGLE_SILENCE_STOP_DEFAULT_SECONDS
    }
    .clamp(
        TOGGLE_SILENCE_STOP_MIN_SECONDS,
        TOGGLE_SILENCE_STOP_MAX_SECONDS,
    );

    Some(Duration::from_millis((seconds * 1000.0).round() as u64))
}

pub(crate) fn microphone_mode_from_settings(settings: &WinsttSettings) -> MicrophoneMode {
    match settings.audio.microphone_release {
        MicrophoneRelease::Always => MicrophoneMode::AlwaysOn,
        _ => MicrophoneMode::OnDemand,
    }
}

fn lazy_close_delay(settings: &WinsttSettings) -> Option<Duration> {
    match settings.audio.microphone_release {
        MicrophoneRelease::Sec30 => Some(Duration::from_secs(30)),
        MicrophoneRelease::Min1 => Some(Duration::from_secs(60)),
        MicrophoneRelease::Min5 => Some(Duration::from_secs(300)),
        MicrophoneRelease::Always | MicrophoneRelease::Immediate => None,
    }
}

fn schedule_toggle_silence_stop(
    app_handle: &tauri::AppHandle,
    speech_generation: Arc<AtomicU64>,
    speech_token: u64,
) {
    let settings = read_settings_raw(app_handle);
    let Some(delay) = silence_auto_stop_delay(&settings) else {
        return;
    };
    let Some(audio) = app_handle.try_state::<Arc<AudioRecordingManager>>() else {
        return;
    };
    if !audio.is_recording() {
        return;
    }
    let recording_generation = audio.recording_generation();
    let app = app_handle.clone();

    std::thread::spawn(move || {
        std::thread::sleep(delay);
        if speech_generation.load(Ordering::SeqCst) != speech_token {
            return;
        }

        let settings = read_settings_raw(&app);
        if silence_auto_stop_delay(&settings).is_none() {
            return;
        }

        let Some(audio) = app.try_state::<Arc<AudioRecordingManager>>() else {
            return;
        };
        if !audio.is_recording() || audio.recording_generation() != recording_generation {
            return;
        }

        if let Some(coordinator) = app.try_state::<crate::TranscriptionCoordinator>() {
            coordinator.request_silence_stop(TOGGLE_SILENCE_STOP_BINDING, recording_generation);
        }
    });
}

/// Whether the no-speech watchdog applies to a session under these settings: auto-stop Toggle and
/// Wakeword only (never PTT — its stop is the key release, and never Listen — loopback owns its own
/// lifecycle). `manual_toggle_stop` IS exempt: that mode has no silence auto-stop
/// ([`silence_auto_stop_delay`] returns `None`), so by design the user controls stop timing and may
/// deliberately pause well past the 15 s window before speaking; the watchdog's "no onset means it
/// records forever" rationale does not apply because the user must stop it explicitly anyway.
/// Pure so the gate is unit-testable.
pub(crate) fn toggle_no_speech_watchdog_enabled(settings: &WinsttSettings) -> bool {
    match settings.general.recording_mode {
        RecordingMode::Toggle if settings.general.manual_toggle_stop => false,
        RecordingMode::Toggle | RecordingMode::Wakeword => true,
        _ => false,
    }
}

/// Arm the no-speech watchdog for a freshly-started Toggle/Wakeword recording. After
/// [`TOGGLE_NO_SPEECH_WATCHDOG`], if THIS recording (`recording_generation`) is still active and
/// has seen NO smoothed-VAD speech onset, the whole dictation operation is cancelled and the audio
/// discarded (no decode/paste) via the shared cancel path — resetting the pill/tray exactly like
/// Escape. Reuses the recording-generation token so a stale watchdog can never kill a newer
/// recording. A no-op for PTT/Listen, or if the settings say the watchdog does not apply.
fn schedule_toggle_no_speech_watchdog(app_handle: &tauri::AppHandle, recording_generation: u64) {
    if !toggle_no_speech_watchdog_enabled(&read_settings_raw(app_handle)) {
        return;
    }
    let app = app_handle.clone();
    std::thread::spawn(move || {
        std::thread::sleep(TOGGLE_NO_SPEECH_WATCHDOG);

        let Some(audio) = app.try_state::<Arc<AudioRecordingManager>>() else {
            return;
        };
        // Stale guard: a newer recording (or none) already superseded this token.
        if audio.recording_generation() != recording_generation || !audio.is_recording() {
            return;
        }
        // First onset cancels the watchdog for the whole session.
        if audio.speech_seen_since_recording_start() {
            return;
        }
        // The user may have switched to PTT/Listen after starting; re-check.
        if !toggle_no_speech_watchdog_enabled(&read_settings_raw(&app)) {
            return;
        }
        warn!(
            "[audio] toggle/wakeword recording (generation {recording_generation}) saw no speech within {}s; discarding",
            TOGGLE_NO_SPEECH_WATCHDOG.as_secs()
        );
        // Mirror Escape: stops the recorder, resets tray/overlay, and notifies the coordinator so
        // its stage returns to Idle — the audio is dropped without a decode or paste.
        crate::utils::cancel_current_operation(&app);
    });
}

/// Logs a `set_mute` COM/HRESULT failure at most once per process so a system where
/// muting never works is diagnosable without flooding the log on every dictation.
#[cfg(target_os = "windows")]
fn warn_set_mute_failed_once(step: &str, err: &windows::core::Error) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static LOGGED: AtomicBool = AtomicBool::new(false);
    if !LOGGED.swap(true, Ordering::Relaxed) {
        warn!(
            "[audio] set_mute failed at {step}: {err} (muting unavailable on this system; subsequent failures suppressed)"
        );
    }
}

fn set_mute(mute: bool) {
    // Expected behavior:
    // - Windows: works on most systems using standard audio drivers.
    // - Linux: works on many systems (PipeWire, PulseAudio, ALSA),
    //   but some distros may lack the tools used.
    // - macOS: works on most standard setups via AppleScript.
    // If unsupported, fails silently.

    #[cfg(target_os = "windows")]
    {
        // SAFETY: The COM objects are created and used on this thread only, all calls check
        // their HRESULTs through `unwrap_or_return!`, and no raw pointers are retained.
        unsafe {
            use windows::Win32::{
                Media::Audio::{
                    Endpoints::IAudioEndpointVolume, IMMDeviceEnumerator, MMDeviceEnumerator,
                    eMultimedia, eRender,
                },
                System::Com::{CLSCTX_ALL, CoCreateInstance},
            };

            // Surface persistent COM/HRESULT failures once (rate-limited) so a system
            // where muting never works is diagnosable, without spamming the log on every
            // dictation. Behavior is unchanged: we still fail soft and return.
            macro_rules! unwrap_or_return {
                ($expr:expr_2021, $what:expr_2021) => {
                    match $expr {
                        Ok(val) => val,
                        Err(err) => {
                            warn_set_mute_failed_once($what, &err);
                            return;
                        }
                    }
                };
            }

            let _com = crate::windows_com::ComApartment::init_multithreaded();

            let all_devices: IMMDeviceEnumerator = unwrap_or_return!(
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL),
                "CoCreateInstance(MMDeviceEnumerator)"
            );
            let default_device = unwrap_or_return!(
                all_devices.GetDefaultAudioEndpoint(eRender, eMultimedia),
                "GetDefaultAudioEndpoint"
            );
            let volume_interface = unwrap_or_return!(
                default_device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None),
                "IAudioEndpointVolume::Activate"
            );

            if let Err(err) = volume_interface.SetMute(mute, std::ptr::null()) {
                warn_set_mute_failed_once("IAudioEndpointVolume::SetMute", &err);
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        use std::process::Command;

        let mute_val = if mute { "1" } else { "0" };
        let amixer_state = if mute { "mute" } else { "unmute" };

        // Try multiple backends to increase compatibility
        // 1. PipeWire (wpctl)
        if Command::new("wpctl")
            .args(["set-mute", "@DEFAULT_AUDIO_SINK@", mute_val])
            .output()
            .is_ok_and(|o| o.status.success())
        {
            return;
        }

        // 2. PulseAudio (pactl)
        if Command::new("pactl")
            .args(["set-sink-mute", "@DEFAULT_SINK@", mute_val])
            .output()
            .is_ok_and(|o| o.status.success())
        {
            return;
        }

        // 3. ALSA (amixer)
        let _ = Command::new("amixer")
            .args(["set", "Master", amixer_state])
            .output();
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let script = format!(
            "set volume output muted {}",
            if mute { "true" } else { "false" }
        );
        let _ = Command::new("osascript").args(["-e", &script]).output();
    }
}

/* ──────────────────────────────────────────────────────────────── */

#[derive(Clone, Debug)]
pub enum RecordingState {
    Idle,
    Recording { binding_id: String },
    Stopping,
}

#[derive(Clone, Debug)]
pub enum MicrophoneMode {
    AlwaysOn,
    OnDemand,
}

/* ──────────────────────────────────────────────────────────────── */

fn create_audio_recorder(
    vad_path: &str,
    app_handle: &tauri::AppHandle,
    speech_seen: Arc<AtomicBool>,
    realtime_audio_signal: Arc<(Mutex<RealtimeAudioProgress>, Condvar)>,
) -> Result<AudioRecorder, anyhow::Error> {
    let silero = SileroVad::new(vad_path, VAD_SPEECH_THRESHOLD)
        .map_err(|e| anyhow::anyhow!("Failed to create SileroVad: {}", e))?;
    let smoothed_vad = SmoothedVad::new(Box::new(silero), 15, 15, 2);

    // Recorder with VAD plus a spectrum-level callback that forwards updates to
    // the frontend.
    let recorder = AudioRecorder::new()
        .with_realtime_audio_signal(realtime_audio_signal)
        .with_vad(Box::new(smoothed_vad))
        .with_level_callback({
            let app_handle = app_handle.clone();
            move |level| {
                // WinSTT scalar level for the reused renderer's audio visualizer.
                // useVisualizerSync (onAudioLevel) reads `{ level: number }` (a
                // single 0..1 peak-across-vocal-bands amplitude) and feeds the rAF bar loop.
                crate::winstt::commands::dictation::SttEvents::audio_level(&app_handle, level);
                // DIAGNOSTIC: log the peak level ~once/sec so we can see whether the
                // mic is actually delivering audio (a silent/virtual default device
                // reads ~0.00 here → flat visualizer). Callback fires ~94 Hz.
                {
                    static LEVEL_LOG_TICK: AtomicU64 = AtomicU64::new(0);
                    if LEVEL_LOG_TICK
                        .fetch_add(1, Ordering::Relaxed)
                        .is_multiple_of(90)
                    {
                        log::debug!("[audio] mic peak level = {level:.3}");
                    }
                }
            }
        })
        .with_capture_live_callback({
            // Fires once per recording on the FIRST captured frame — the mic is confirmed
            // open and delivering audio. Surfaced as `stt:capture-active` so the renderer's
            // hotkey badge flips from "opening mic…" to a real recording state instead of
            // lighting up on the keypress (before WASAPI has opened an asleep device).
            //
            // The start chime ALSO fires here, not at hotkey press: a cold on-demand open
            // (`microphone_release = Immediate`, Bluetooth/USB headsets especially) delivers
            // its first frame up to ~1 s after the press — a chime at press invites the user
            // to speak into a mic that is not capturing yet, and everything said before this
            // callback is physically unrecoverable. Chiming on the first real frame makes the
            // chime the honest "speak now" signal; on a warm stream the first frame arrives
            // within one device period, so the timing is indistinguishable from chiming at
            // press. `duck_then_play_recording_chime` self-gates on settings and its
            // generation check, and does its work on a worker thread (non-blocking here).
            let app_handle = app_handle.clone();
            move || {
                crate::winstt::commands::dictation::SttEvents::capture_active(&app_handle);
                if let Some(rm) = app_handle.try_state::<std::sync::Arc<AudioRecordingManager>>() {
                    crate::winstt::commands::sound::duck_then_play_recording_chime(
                        &app_handle,
                        rm.recording_generation(),
                    );
                }
            }
        })
        .with_chunk_callback({
            // Wakeword tap: feed every 16k frame to the WakeWordManager. feed_chunk is
            // internally gated (no-op unless armed + a detector is built), so this is free
            // when wakeword mode is off. On a hit, the manager emits `wake_word_detected`.
            let app_handle = app_handle.clone();
            move |frame: &[f32]| {
                if let Some(wm) = app_handle
                    .try_state::<std::sync::Arc<crate::winstt::managers::WakeWordManager>>()
                {
                    let _ = wm.feed_chunk(frame);
                }
            }
        })
        .with_speech_callback({
            // Surface the recorder's REAL smoothed-Silero VAD as stt:vad-start /
            // stt:vad-stop so the renderer's `isSpeaking` tracks actual speech onset
            // (~one onset window after the user starts talking) instead of being faked
            // from the recording window. Drives the overlay-pill reveal + breathing glow.
            let app_handle = app_handle.clone();
            let speech_generation = Arc::new(AtomicU64::new(0));
            let speech_seen = Arc::clone(&speech_seen);
            move |speaking: bool| {
                let speech_token = speech_generation.fetch_add(1, Ordering::SeqCst) + 1;
                if speaking {
                    speech_seen.store(true, Ordering::SeqCst);
                    crate::winstt::commands::dictation::SttEvents::vad_start(&app_handle);
                } else {
                    crate::winstt::commands::dictation::SttEvents::vad_stop(&app_handle);
                    schedule_toggle_silence_stop(
                        &app_handle,
                        Arc::clone(&speech_generation),
                        speech_token,
                    );
                }
            }
        });

    Ok(recorder)
}

/* ──────────────────────────────────────────────────────────────── */

#[derive(Clone)]
pub struct AudioRecordingManager {
    state: Arc<Mutex<RecordingState>>,
    mode: Arc<Mutex<MicrophoneMode>>,
    app_handle: tauri::AppHandle,

    recorder: Arc<Mutex<Option<AudioRecorder>>>,
    is_open: Arc<Mutex<bool>>,
    is_recording: Arc<Mutex<bool>>,
    did_mute: Arc<Mutex<bool>>,
    close_generation: Arc<AtomicU64>,
    speech_seen: Arc<AtomicBool>,
    /// Monotonic counter bumped on every successful `try_start_recording`. The
    /// realtime worker keys its per-recording reset + emit guard on this so a
    /// quick press→release→press (where it never observes the idle gap between
    /// the two recordings) still starts the new utterance with a clean watermark
    /// and never emits the previous one's in-flight realtime text.
    recording_generation: Arc<AtomicU64>,
    /// Recorder progress signal for native realtime streaming. The recorder updates this whenever
    /// the (ungated) live mirror grows or resets, so native streaming can sleep on audio events
    /// instead of polling the mirror.
    realtime_audio_signal: Arc<(Mutex<RealtimeAudioProgress>, Condvar)>,
}

/// Position of the first entry in `priority` (mic NAMES, highest-priority
/// first — the drag-sorted order from the device pickers) that is present in
/// `names`, the freshly enumerated input-device names. Matching mirrors the
/// renderer's dedup key: trimmed, case-insensitive.
fn choose_priority_device_position(names: &[&str], priority: &[String]) -> Option<usize> {
    priority.iter().find_map(|wanted| {
        let key = wanted.trim().to_lowercase();
        names
            .iter()
            .position(|name| name.trim().to_lowercase() == key)
    })
}

impl AudioRecordingManager {
    /* ---------- construction ------------------------------------------------ */

    pub fn new(app: &tauri::AppHandle) -> Result<Self, anyhow::Error> {
        let settings = read_settings_raw(app);
        let mode = microphone_mode_from_settings(&settings);

        let manager = Self {
            state: Arc::new(Mutex::new(RecordingState::Idle)),
            mode: Arc::new(Mutex::new(mode.clone())),
            app_handle: app.clone(),

            recorder: Arc::new(Mutex::new(None)),
            is_open: Arc::new(Mutex::new(false)),
            is_recording: Arc::new(Mutex::new(false)),
            did_mute: Arc::new(Mutex::new(false)),
            close_generation: Arc::new(AtomicU64::new(0)),
            speech_seen: Arc::new(AtomicBool::new(false)),
            recording_generation: Arc::new(AtomicU64::new(0)),
            realtime_audio_signal: Arc::new((
                Mutex::new(RealtimeAudioProgress::default()),
                Condvar::new(),
            )),
        };

        // Always-on? Open immediately unless onboarding owns the launch. The
        // post-onboarding activation path re-applies the saved microphone policy.
        if matches!(mode, MicrophoneMode::AlwaysOn) {
            if crate::winstt::commands::onboarding::is_onboarding_active() {
                debug!("Deferring always-on microphone stream until onboarding completes");
            } else {
                manager.start_microphone_stream()?;
            }
        }

        Ok(manager)
    }

    /* ---------- helper methods --------------------------------------------- */

    fn get_effective_microphone_device(&self) -> Option<cpal::Device> {
        // Some Windows hosts expose SILENT virtual/loopback inputs ("WO Mic",
        // "Stereo Mix", "Voicemeeter", …). When "Default" is selected we honor the OS
        // default input first; only if THAT is one of these known-silent virtual
        // endpoints do we fall through to the first real physical input (level=0.00 on
        // a silent default → a dead visualizer + no captured audio).
        //
        // The blocklist matches WHOLE WORDS / identities, not bare substrings: a naked
        // "cable" / "aggregate" substring rejected legitimate products (e.g. a USB
        // device whose name contains "Cable") and every macOS "Aggregate Device", so
        // those two are matched as standalone tokens (or known full product names)
        // rather than anywhere-in-the-string.
        fn is_likely_virtual(name: &str) -> bool {
            let lower = name.to_lowercase();
            // Phrase markers that are unambiguous as substrings (no false positives on
            // real hardware names).
            const SUBSTRING_MARKERS: &[&str] = &[
                "stereo mix",
                "what u hear",
                "wo mic",
                "loopback",
                "wavetable",
                "stereo out",
                "mono mix",
                "voicemeeter",
                "vb-audio",
                "vb-cable",
            ];
            if SUBSTRING_MARKERS.iter().any(|p| lower.contains(p)) {
                return true;
            }
            // Whole-word markers: split on non-alphanumeric so "cable" / "aggregate" /
            // "virtual" only match as standalone tokens, not as a slice of a larger
            // word inside a real product name.
            const WORD_MARKERS: &[&str] = &["cable", "aggregate", "virtual"];
            lower
                .split(|c: char| !c.is_alphanumeric())
                .any(|tok| WORD_MARKERS.contains(&tok))
        }

        fn device_matches_index(device: &CpalDeviceInfo, selected_index: i64) -> bool {
            selected_index >= 0 && device.index.parse::<i64>().ok() == Some(selected_index)
        }

        fn choose_default_device(devices: &[CpalDeviceInfo]) -> Option<usize> {
            devices
                .iter()
                .position(|d| d.is_default && !is_likely_virtual(&d.name))
                .or_else(|| devices.iter().position(|d| !is_likely_virtual(&d.name)))
                .or_else(|| devices.iter().position(|d| d.is_default))
                .or_else(|| (!devices.is_empty()).then_some(0usize))
        }

        // Device selection is canonical in the WinSTT store (`settings.audio.*`),
        // which holds device INDICES. The legacy `AppSettings` name-based mirror
        // (`selected_microphone` / `clamshell_microphone`) was removed; `None`
        // index means "system default".
        let settings = read_settings_raw(&self.app_handle);
        let use_clamshell_mic = clamshell::is_clamshell().unwrap_or(false)
            && settings.audio.clamshell_microphone.is_some();

        let selected_index = if use_clamshell_mic {
            settings.audio.clamshell_microphone
        } else {
            settings.audio.input_device_index
        };

        match list_input_devices() {
            Ok(devices) => {
                // Preference order (drag-sorted in the pickers) wins when set: the
                // highest-priority CONNECTED name is used even if `input_device_index`
                // still points at a lower entry. Resolved fresh on every stream open,
                // so replugging a preferred mic takes effect on the next recording.
                // Clamshell mode keeps precedence over the preference order.
                let priority_pick = if use_clamshell_mic {
                    None
                } else {
                    let names: Vec<&str> = devices.iter().map(|d| d.name.as_str()).collect();
                    choose_priority_device_position(&names, &settings.audio.input_device_priority)
                };
                let chosen = if let Some(position) = priority_pick {
                    Some(position)
                } else if let Some(index) = selected_index {
                    let found = devices
                        .iter()
                        .position(|device| device_matches_index(device, index));
                    if found.is_none() {
                        warn!(
                            "[audio] selected microphone index {index} is unavailable; falling back to default input"
                        );
                        // Tell the renderer the queued index couldn't be opened so it
                        // reverts the UI selection to "System default" and toasts. We
                        // report fallback_index=None: the chosen fallback re-resolves
                        // the OS default on every open, so pinning today's concrete
                        // index would lie on the next device reshuffle.
                        crate::winstt::commands::listen_events::emit_device_switch_failed(
                            &self.app_handle,
                            index,
                            &format!("device #{index} is no longer available"),
                            None,
                        );
                    }
                    found.or_else(|| choose_default_device(&devices))
                } else {
                    // "Default" selected → honor the OS default input first…
                    devices
                        .iter()
                        .position(|d| d.is_default && !is_likely_virtual(&d.name))
                        // …only if the OS default is a known-silent virtual device do we
                        // fall through to the first real physical input…
                        .or_else(|| devices.iter().position(|d| !is_likely_virtual(&d.name)))
                        // …and last resort: the OS default even if virtual (better than
                        // nothing — keeps parity with cpal's own default fallback).
                        .or_else(|| devices.iter().position(|d| d.is_default))
                        .or_else(|| (!devices.is_empty()).then_some(0usize))
                };
                chosen
                    .and_then(|i| devices.into_iter().nth(i))
                    .map(|d| d.device)
            }
            Err(e) => {
                debug!("Failed to list devices, using default: {}", e);
                None
            }
        }
    }

    fn schedule_close_when_idle(&self, delay: Duration) {
        let app = self.app_handle.clone();
        let generation = self.close_generation.fetch_add(1, Ordering::SeqCst) + 1;
        std::thread::spawn(move || {
            if delay > Duration::from_millis(0) {
                std::thread::sleep(delay);
            }
            let rm = app.state::<Arc<AudioRecordingManager>>();
            // Hold state lock across the check AND close to serialize against
            // try_start_recording, preventing a race where the stream is closed
            // under an active recording.
            let state = rm.state.lock_recover();
            if rm.close_generation.load(Ordering::SeqCst) == generation
                && matches!(*state, RecordingState::Idle)
                && !rm.wakeword_mode_active()
            {
                // stop_microphone_stream does not acquire the state lock,
                // so holding it here is safe (no deadlock).
                if delay > Duration::from_millis(0) {
                    info!("Closing idle microphone stream after {:?}", delay);
                } else {
                    info!("Closing idle microphone stream after recording stop");
                }
                rm.stop_microphone_stream();
            }
        });
    }

    fn schedule_lazy_close(&self) {
        let delay =
            lazy_close_delay(&read_settings_raw(&self.app_handle)).unwrap_or(STREAM_IDLE_TIMEOUT);
        self.schedule_close_when_idle(delay);
    }

    fn schedule_release_after_stop(&self) {
        let delay = lazy_close_delay(&read_settings_raw(&self.app_handle)).unwrap_or_default();
        self.schedule_close_when_idle(delay);
    }

    /* ---------- microphone life-cycle -------------------------------------- */

    /// Applies mute if mute_while_recording is enabled and stream is open
    pub fn apply_mute(&self) {
        let settings = read_settings_raw(&self.app_handle).core;
        let mut did_mute_guard = self.did_mute.lock_recover();

        if settings.mute_while_recording && *self.is_open.lock_recover() {
            set_mute(true);
            *did_mute_guard = true;
            debug!("Mute applied");
        }
    }

    /// Removes mute if it was applied
    pub fn remove_mute(&self) {
        let mut did_mute_guard = self.did_mute.lock_recover();
        if *did_mute_guard {
            set_mute(false);
            *did_mute_guard = false;
            debug!("Mute removed");
        }
    }

    pub fn preload_vad(&self) -> Result<(), anyhow::Error> {
        if crate::winstt::commands::onboarding::is_onboarding_active() {
            debug!("VAD preload skipped while onboarding is active");
            return Ok(());
        }

        let mut recorder_opt = self.recorder.lock_recover();
        if recorder_opt.is_none() {
            let vad_path = self
                .app_handle
                .path()
                .resolve(
                    "resources/models/silero_vad_v4.onnx",
                    tauri::path::BaseDirectory::Resource,
                )
                .map_err(|e| anyhow::anyhow!("Failed to resolve VAD path: {}", e))?;
            let vad_str = vad_path.to_str().ok_or_else(|| {
                anyhow::anyhow!("VAD path is not valid UTF-8: {}", vad_path.display())
            })?;
            *recorder_opt = Some(create_audio_recorder(
                vad_str,
                &self.app_handle,
                Arc::clone(&self.speech_seen),
                Arc::clone(&self.realtime_audio_signal),
            )?);
        }
        Ok(())
    }

    fn wakeword_mode_active(&self) -> bool {
        read_settings_raw(&self.app_handle).general.recording_mode == RecordingMode::Wakeword
    }

    pub fn ensure_wakeword_listening_stream(&self) -> Result<(), anyhow::Error> {
        self.close_generation.fetch_add(1, Ordering::SeqCst);
        self.start_microphone_stream()
    }

    pub fn stop_wakeword_listening_stream_if_idle(&self) {
        if self.is_recording() {
            return;
        }
        if matches!(*self.mode.lock_recover(), MicrophoneMode::OnDemand) {
            self.close_generation.fetch_add(1, Ordering::SeqCst);
            self.stop_microphone_stream();
        }
    }

    pub fn start_microphone_stream(&self) -> Result<(), anyhow::Error> {
        if crate::winstt::commands::onboarding::is_onboarding_active() {
            debug!("Microphone stream start skipped while onboarding is active");
            return Ok(());
        }

        let mut open_flag = self.is_open.lock_recover();
        if *open_flag {
            debug!("Microphone stream already active");
            return Ok(());
        }

        let start_time = Instant::now();

        // Don't mute immediately - caller will handle muting after audio feedback
        let mut did_mute_guard = self.did_mute.lock_recover();
        *did_mute_guard = false;

        // Get the selected device from settings, considering clamshell mode
        let selected_device = self.get_effective_microphone_device();

        // Pre-flight check: if no device was selected/configured AND no devices
        // exist at all, fail early with a clear error instead of letting cpal
        // produce a cryptic backend-specific message.
        if selected_device.is_none() {
            let has_any_device = list_input_devices().is_ok_and(|devices| !devices.is_empty());
            if !has_any_device {
                return Err(anyhow::anyhow!("No input device found"));
            }
        }

        // Ensure VAD is loaded if it wasn't for whatever reason
        self.preload_vad()?;

        let mut recorder_opt = self.recorder.lock_recover();
        if let Some(rec) = recorder_opt.as_mut() {
            rec.open(selected_device)
                .map_err(|e| anyhow::anyhow!("Failed to open recorder: {}", e))?;
        }

        *open_flag = true;
        // This timing covers through cpal's stream.play() returning — i.e. the
        // point cpal surfaces as "stream running." It does NOT guarantee the
        // host audio device is producing samples yet; the first input callback
        // fires asynchronously one buffer period later (hardware dependent,
        // typically ~10–200ms on macOS, longer on Bluetooth/USB).
        info!(
            "Microphone stream initialized in {:?}",
            start_time.elapsed()
        );
        Ok(())
    }

    pub fn stop_microphone_stream(&self) {
        let mut open_flag = self.is_open.lock_recover();
        if !*open_flag {
            return;
        }

        let mut did_mute_guard = self.did_mute.lock_recover();
        if *did_mute_guard {
            set_mute(false);
        }
        *did_mute_guard = false;

        if let Some(rec) = self.recorder.lock_recover().as_mut() {
            // If still recording, stop first.
            if *self.is_recording.lock_recover() {
                let _ = rec.stop();
                *self.is_recording.lock_recover() = false;
            }
            let _ = rec.close();
        }

        *open_flag = false;
        debug!("Microphone stream stopped");
    }

    /* ---------- mode switching --------------------------------------------- */

    pub fn update_mode(&self, new_mode: MicrophoneMode) -> Result<(), anyhow::Error> {
        if crate::winstt::commands::onboarding::is_onboarding_active() {
            {
                *self.mode.lock_recover() = new_mode;
            }
            self.close_generation.fetch_add(1, Ordering::SeqCst);
            self.stop_microphone_stream();
            return Ok(());
        }

        let cur_mode = self.mode.lock_recover().clone();

        match (cur_mode, &new_mode) {
            (MicrophoneMode::AlwaysOn, MicrophoneMode::OnDemand) => {
                if matches!(*self.state.lock_recover(), RecordingState::Idle)
                    && !self.wakeword_mode_active()
                {
                    self.close_generation.fetch_add(1, Ordering::SeqCst);
                    self.stop_microphone_stream();
                }
            }
            (MicrophoneMode::OnDemand, MicrophoneMode::AlwaysOn) => {
                self.close_generation.fetch_add(1, Ordering::SeqCst);
                self.start_microphone_stream()?;
            }
            _ => {}
        }

        *self.mode.lock_recover() = new_mode;
        Ok(())
    }

    pub fn sync_microphone_mode_from_settings(&self) -> Result<(), anyhow::Error> {
        let settings = read_settings_raw(&self.app_handle);
        let mode = microphone_mode_from_settings(&settings);
        self.update_mode(mode.clone())?;
        let is_open = *self.is_open.lock_recover();
        if matches!(mode, MicrophoneMode::AlwaysOn) && !is_open {
            self.start_microphone_stream()?;
        }
        Ok(())
    }

    /* ---------- recording --------------------------------------------------- */

    pub fn try_start_recording(&self, binding_id: &str) -> Result<(), String> {
        if crate::winstt::commands::onboarding::is_onboarding_active() {
            return Err("Onboarding is active; recording is disabled".to_string());
        }

        let mut state = self.state.lock_recover();

        if let RecordingState::Idle = *state {
            // Ensure microphone is open in on-demand mode
            if matches!(*self.mode.lock_recover(), MicrophoneMode::OnDemand) {
                // Cancel any pending lazy close
                self.close_generation.fetch_add(1, Ordering::SeqCst);
                if let Err(e) = self.start_microphone_stream() {
                    let msg = format!("{e}");
                    error!("Failed to open microphone stream: {msg}");
                    return Err(msg);
                }
            }

            if let Some(rec) = self.recorder.lock_recover().as_ref() {
                self.speech_seen.store(false, Ordering::SeqCst);
                if rec.start().is_ok() {
                    *self.is_recording.lock_recover() = true;
                    // Bump the recording generation so the realtime worker treats
                    // this as a fresh utterance even when the previous one ended
                    // moments ago (press→release→press) and it never saw the gap.
                    let generation = self.recording_generation.fetch_add(1, Ordering::SeqCst) + 1;
                    *state = RecordingState::Recording {
                        binding_id: binding_id.to_string(),
                    };
                    // Arm the no-speech watchdog for Toggle/Wakeword: with no onset ever, the
                    // offset-armed silence auto-stop never arms, so an untouched session would
                    // record forever. Keyed on this generation so it can't kill a newer take.
                    schedule_toggle_no_speech_watchdog(&self.app_handle, generation);
                    debug!("Recording started for binding {binding_id}");
                    return Ok(());
                }
            }
            Err("Recorder not available".to_string())
        } else {
            Err("Already recording".to_string())
        }
    }

    pub fn update_selected_device(&self) -> Result<(), anyhow::Error> {
        // If currently open, restart the microphone stream to use the new device
        if *self.is_open.lock_recover() {
            self.close_generation.fetch_add(1, Ordering::SeqCst);
            self.stop_microphone_stream();
            self.start_microphone_stream()?;
        }
        Ok(())
    }

    pub fn stop_recording(&self, binding_id: &str) -> Option<CapturedAudio> {
        let mut state = self.state.lock_recover();

        match *state {
            RecordingState::Recording {
                binding_id: ref active,
            } if active == binding_id => {
                *state = RecordingState::Stopping;
                // Stop the live-preview mirror at the recording boundary. The final
                // paste path owns the model from here; letting realtime start one
                // more preview decode during key-up can delay the final transcript.
                self.set_realtime_enabled(false);
                drop(state);

                // The FULL capture — every sample plus the per-frame speech mask. Capture is
                // ungated (no VAD cropping); silence is cut downstream via the mask.
                let captured = if let Some(rec) = self.recorder.lock_recover().as_ref() {
                    match rec.stop_captured() {
                        Ok(cap) => cap,
                        Err(e) => {
                            error!("stop_captured() failed: {e}");
                            CapturedAudio::default()
                        }
                    }
                } else {
                    error!("Recorder not available");
                    CapturedAudio::default()
                };

                *self.is_recording.lock_recover() = false;

                let should_release_stream =
                    matches!(*self.mode.lock_recover(), MicrophoneMode::OnDemand)
                        && !self.wakeword_mode_active();
                *self.state.lock_recover() = RecordingState::Idle;

                // In on-demand mode, close the mic according to the release policy,
                // but do it off the stop->transcribe hot path. We already have the
                // finalized samples; waiting for CPAL thread teardown here delays
                // paste without improving transcription correctness.
                if should_release_stream {
                    self.schedule_release_after_stop();
                }

                // NO short-clip pad here: the capture layer must never lengthen audio. A
                // degenerately short clip is rejected by the mask-aware silence gate when it
                // carries no speech, and padded to a family minimum at the decode layer only
                // where a front-end demonstrably needs it (see backend.rs).
                Some(captured)
            }
            _ => None,
        }
    }
    pub fn is_recording(&self) -> bool {
        matches!(*self.state.lock_recover(), RecordingState::Recording { .. })
    }

    /// Monotonic recording-start counter (see the field doc). The realtime worker
    /// reads this once per active tick to detect a new utterance and to guard its
    /// emit against a decode that belongs to a recording that has since ended.
    pub fn recording_generation(&self) -> u64 {
        self.recording_generation.load(Ordering::SeqCst)
    }

    pub fn is_active_recording_generation(&self, generation: u64) -> bool {
        generation != 0
            && self.recording_generation.load(Ordering::SeqCst) == generation
            && matches!(*self.state.lock_recover(), RecordingState::Recording { .. })
    }

    pub fn speech_seen_since_recording_start(&self) -> bool {
        self.speech_seen.load(Ordering::SeqCst)
    }

    /// Snapshot the in-flight 16 kHz mono recording buffer (a clone of the recorder's live
    /// mirror) for the realtime worker's growing-window decode. Returns an empty Vec when no
    /// recorder is open. Side-effect-free: reads the mirror, never touches the batch buffer.
    /// O(N) — prefer `snapshot_audio_from` on the hot per-tick path.
    pub fn snapshot_audio(&self) -> Vec<f32> {
        self.recorder
            .lock_recover()
            .as_ref()
            .map(|rec| rec.snapshot_recorded())
            .unwrap_or_default()
    }

    /// Snapshot only the recording-mirror tail past `offset` samples, plus the current total
    /// length: `(total_len, tail)` where `tail == mirror[offset..]`. The realtime worker passes
    /// its committed-frame watermark so each tick clones O(new samples) instead of O(N) (kills
    /// the O(N²)-per-utterance full-buffer clone). Returns `(0, empty)` when no recorder is open.
    pub fn snapshot_audio_from(&self, offset: usize) -> (usize, Vec<f32>) {
        self.recorder
            .lock_recover()
            .as_ref()
            .map_or((0, Vec::new()), |rec| rec.snapshot_from(offset))
    }

    /// Block until the realtime mirror grows past `offset`, or until a recording-boundary reset
    /// wakes the waiter. Returns true only when new audio is available for `snapshot_audio_from`.
    pub fn wait_for_realtime_audio_after(&self, offset: usize, timeout: Duration) -> bool {
        let (lock, cvar) = &*self.realtime_audio_signal;
        let progress = lock.lock_recover();
        if progress.len > offset {
            return true;
        }
        let start_version = progress.version;
        let result = cvar.wait_timeout_while(progress, timeout, |progress| {
            progress.len <= offset && progress.version == start_version
        });
        let (progress, _) = match result {
            Ok(waited) => waited,
            Err(poisoned) => poisoned.into_inner(),
        };
        progress.len > offset
    }

    /// Enable/disable the recorder's realtime `live_audio` mirror. When disabled, the recorder
    /// skips the per-chunk second-copy extend entirely. The realtime worker flips this per
    /// recording based on `effective_realtime` so plain dictation never pays the mirror cost.
    /// No-op when no recorder is open (the gate is re-applied on the next worker tick).
    pub fn set_realtime_enabled(&self, enabled: bool) {
        if let Some(rec) = self.recorder.lock_recover().as_ref() {
            rec.set_realtime_enabled(enabled);
        }
    }

    /// Cancel any ongoing recording without returning audio samples
    pub fn cancel_recording(&self) {
        let mut state = self.state.lock_recover();

        match *state {
            RecordingState::Recording { .. } => {
                *state = RecordingState::Idle;
                drop(state);

                if let Some(rec) = self.recorder.lock_recover().as_ref() {
                    let _ = rec.stop(); // Discard the result
                }

                *self.is_recording.lock_recover() = false;

                // In on-demand mode, close the mic (lazily if the setting is enabled)
                if matches!(*self.mode.lock_recover(), MicrophoneMode::OnDemand)
                    && !self.wakeword_mode_active()
                {
                    if lazy_close_delay(&read_settings_raw(&self.app_handle)).is_some() {
                        self.schedule_lazy_close();
                    } else {
                        self.stop_microphone_stream();
                    }
                }
            }
            RecordingState::Stopping => {
                // A normal stop is already finalizing the captured buffer. Session
                // cancellation suppresses the eventual paste without racing a second stop.
            }
            RecordingState::Idle => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::winstt::settings_schema::{RecordingMode, WinsttSettings};

    fn settings_with(
        recording_mode: RecordingMode,
        manual_toggle_stop: bool,
        post_speech_silence_duration: f64,
    ) -> WinsttSettings {
        let mut settings = WinsttSettings::default();
        settings.general.recording_mode = recording_mode;
        settings.general.manual_toggle_stop = manual_toggle_stop;
        settings.audio.post_speech_silence_duration = post_speech_silence_duration;
        settings
    }

    #[test]
    fn priority_picks_first_connected_entry() {
        let names = ["Realtek Mic Array", "USB Blue Yeti", "Webcam C920"];
        let priority = vec!["AirPods Pro".to_string(), "USB Blue Yeti".to_string()];

        // "AirPods Pro" is not connected → the next entry wins.
        assert_eq!(choose_priority_device_position(&names, &priority), Some(1));
    }

    #[test]
    fn priority_matches_names_trimmed_and_case_insensitively() {
        let names = ["  USB Blue Yeti "];
        let priority = vec!["usb blue yeti".to_string()];

        assert_eq!(choose_priority_device_position(&names, &priority), Some(0));
    }

    #[test]
    fn priority_returns_none_when_empty_or_nothing_connected() {
        let names = ["Realtek Mic Array"];

        assert_eq!(choose_priority_device_position(&names, &[]), None);
        assert_eq!(
            choose_priority_device_position(&names, &["Gone Mic".to_string()]),
            None
        );
        assert_eq!(
            choose_priority_device_position(&[], &["Gone Mic".to_string()]),
            None
        );
    }

    #[test]
    fn toggle_auto_stop_uses_post_speech_silence_duration() {
        let settings = settings_with(RecordingMode::Toggle, false, 1.4);

        assert_eq!(
            silence_auto_stop_delay(&settings),
            Some(Duration::from_millis(1400))
        );
    }

    #[test]
    fn toggle_manual_stop_disables_silence_auto_stop() {
        let settings = settings_with(RecordingMode::Toggle, true, 1.4);

        assert_eq!(silence_auto_stop_delay(&settings), None);
    }

    #[test]
    fn ptt_does_not_auto_stop_on_silence() {
        let settings = settings_with(RecordingMode::Ptt, false, 1.4);

        assert_eq!(silence_auto_stop_delay(&settings), None);
    }

    #[test]
    fn wakeword_auto_stop_uses_post_speech_silence_duration() {
        let settings = settings_with(RecordingMode::Wakeword, true, 1.4);

        assert_eq!(
            silence_auto_stop_delay(&settings),
            Some(Duration::from_millis(1400))
        );
    }

    #[test]
    fn silence_auto_stop_delay_is_clamped_to_slider_bounds() {
        let too_low = settings_with(RecordingMode::Toggle, false, -1.0);
        let too_high = settings_with(RecordingMode::Toggle, false, 99.0);

        assert_eq!(
            silence_auto_stop_delay(&too_low),
            Some(Duration::from_millis(100))
        );
        assert_eq!(
            silence_auto_stop_delay(&too_high),
            Some(Duration::from_secs(10))
        );
    }

    #[test]
    fn no_speech_watchdog_applies_to_toggle_and_wakeword_only() {
        // Toggle and Wakeword arm the watchdog…
        assert!(toggle_no_speech_watchdog_enabled(&settings_with(
            RecordingMode::Toggle,
            false,
            0.7
        )));
        assert!(toggle_no_speech_watchdog_enabled(&settings_with(
            RecordingMode::Wakeword,
            false,
            0.7
        )));
        // …but a MANUAL-stop toggle is EXEMPT: that mode has no silence auto-stop, so the user may
        // pause past the window before speaking and must stop it explicitly anyway.
        assert!(!toggle_no_speech_watchdog_enabled(&settings_with(
            RecordingMode::Toggle,
            true,
            0.7
        )));
        // PTT and Listen never arm it (PTT stops on release; Listen owns its own lifecycle).
        assert!(!toggle_no_speech_watchdog_enabled(&settings_with(
            RecordingMode::Ptt,
            false,
            0.7
        )));
        assert!(!toggle_no_speech_watchdog_enabled(&settings_with(
            RecordingMode::Listen,
            false,
            0.7
        )));
    }
}
