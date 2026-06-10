use crate::audio_toolkit::{
    list_input_devices, vad::SmoothedVad, AudioRecorder, CpalDeviceInfo, RealtimeAudioProgress,
    SileroVad,
};
use crate::helpers::clamshell;
use crate::settings::get_settings;
use crate::winstt::commands::settings::read_settings_raw;
use crate::winstt::settings_schema::{MicrophoneRelease, RecordingMode, WinsttSettings};
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

fn set_mute(mute: bool) {
    // Expected behavior:
    // - Windows: works on most systems using standard audio drivers.
    // - Linux: works on many systems (PipeWire, PulseAudio, ALSA),
    //   but some distros may lack the tools used.
    // - macOS: works on most standard setups via AppleScript.
    // If unsupported, fails silently.

    #[cfg(target_os = "windows")]
    {
        unsafe {
            use windows::Win32::{
                Media::Audio::{
                    eMultimedia, eRender, Endpoints::IAudioEndpointVolume, IMMDeviceEnumerator,
                    MMDeviceEnumerator,
                },
                System::Com::{CoCreateInstance, CLSCTX_ALL},
            };

            macro_rules! unwrap_or_return {
                ($expr:expr) => {
                    match $expr {
                        Ok(val) => val,
                        Err(_) => return,
                    }
                };
            }

            let _com = crate::windows_com::ComApartment::init_multithreaded();

            let all_devices: IMMDeviceEnumerator =
                unwrap_or_return!(CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL));
            let default_device =
                unwrap_or_return!(all_devices.GetDefaultAudioEndpoint(eRender, eMultimedia));
            let volume_interface = unwrap_or_return!(
                default_device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
            );

            let _ = volume_interface.SetMute(mute, std::ptr::null());
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
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            return;
        }

        // 2. PulseAudio (pactl)
        if Command::new("pactl")
            .args(["set-sink-mute", "@DEFAULT_SINK@", mute_val])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
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

const WHISPER_SAMPLE_RATE: usize = 16000;

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
    let silero = SileroVad::new(vad_path, 0.3)
        .map_err(|e| anyhow::anyhow!("Failed to create SileroVad: {}", e))?;
    let smoothed_vad = SmoothedVad::new(Box::new(silero), 15, 15, 2);

    // Recorder with VAD plus a spectrum-level callback that forwards updates to
    // the frontend.
    let recorder = AudioRecorder::new()
        .map_err(|e| anyhow::anyhow!("Failed to create AudioRecorder: {}", e))?
        .with_realtime_audio_signal(realtime_audio_signal)
        .with_vad(Box::new(smoothed_vad))
        .with_level_callback({
            let app_handle = app_handle.clone();
            move |levels| {
                // WinSTT scalar level for the reused renderer's audio visualizer.
                // useVisualizerSync (onAudioLevel) reads `{ level: number }` (a
                // single 0..1 RMS-ish amplitude) and feeds the rAF bar loop. The
                // multiband callback gives a per-band magnitude vector; collapse it
                // to one representative level via peak-across-bands so the bars
                // react to the loudest band (what the eye tracks). Clamped to 0..1.
                let level = levels
                    .iter()
                    .copied()
                    .fold(0.0_f32, f32::max)
                    .clamp(0.0, 1.0);
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
                        log::debug!(
                            "[audio] mic peak level = {level:.3} ({} bands)",
                            levels.len()
                        );
                    }
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
    /// the VAD-filtered live mirror grows or resets, so native streaming can sleep on audio events
    /// instead of polling the mirror.
    realtime_audio_signal: Arc<(Mutex<RealtimeAudioProgress>, Condvar)>,
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

        // Always-on?  Open immediately.
        if matches!(mode, MicrophoneMode::AlwaysOn) {
            manager.start_microphone_stream()?;
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

        let settings = read_settings_raw(&self.app_handle);
        let legacy_settings = get_settings(&self.app_handle);
        let use_clamshell_mic = clamshell::is_clamshell().unwrap_or(false)
            && (settings.audio.clamshell_microphone.is_some()
                || legacy_settings.clamshell_microphone.is_some());

        let selected_index = if use_clamshell_mic {
            settings.audio.clamshell_microphone
        } else {
            settings.audio.input_device_index
        };

        let device_name: Option<&String> = if selected_index.is_some() {
            None
        } else if use_clamshell_mic {
            legacy_settings.clamshell_microphone.as_ref()
        } else {
            legacy_settings.selected_microphone.as_ref()
        };

        match list_input_devices() {
            Ok(devices) => {
                let chosen = if let Some(index) = selected_index {
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
                } else if let Some(name) = device_name {
                    // Explicit by-name selection ALWAYS wins — even if it looks virtual,
                    // the user picked it deliberately.
                    let found = devices.iter().position(|d| d.name == *name);
                    if found.is_none() {
                        warn!(
                            "[audio] selected microphone '{name}' is unavailable; falling back to default input"
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

    fn schedule_lazy_close(&self) {
        let app = self.app_handle.clone();
        let delay = lazy_close_delay(&read_settings_raw(&app)).unwrap_or(STREAM_IDLE_TIMEOUT);
        let gen = self.close_generation.fetch_add(1, Ordering::SeqCst) + 1;
        std::thread::spawn(move || {
            std::thread::sleep(delay);
            let rm = app.state::<Arc<AudioRecordingManager>>();
            // Hold state lock across the check AND close to serialize against
            // try_start_recording, preventing a race where the stream is closed
            // under an active recording.
            let state = rm.state.lock_recover();
            if rm.close_generation.load(Ordering::SeqCst) == gen
                && matches!(*state, RecordingState::Idle)
                && !rm.wakeword_mode_active()
            {
                // stop_microphone_stream does not acquire the state lock,
                // so holding it here is safe (no deadlock).
                info!("Closing idle microphone stream after {:?}", delay);
                rm.stop_microphone_stream();
            }
        });
    }

    /* ---------- microphone life-cycle -------------------------------------- */

    /// Applies mute if mute_while_recording is enabled and stream is open
    pub fn apply_mute(&self) {
        let settings = get_settings(&self.app_handle);
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
            let has_any_device = list_input_devices()
                .map(|devices| !devices.is_empty())
                .unwrap_or(false);
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

    /* ---------- recording --------------------------------------------------- */

    pub fn try_start_recording(&self, binding_id: &str) -> Result<(), String> {
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
                    self.recording_generation.fetch_add(1, Ordering::SeqCst);
                    *state = RecordingState::Recording {
                        binding_id: binding_id.to_string(),
                    };
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

    pub fn stop_recording(&self, binding_id: &str) -> Option<Vec<f32>> {
        let mut state = self.state.lock_recover();

        match *state {
            RecordingState::Recording {
                binding_id: ref active,
            } if active == binding_id => {
                *state = RecordingState::Stopping;
                drop(state);

                let samples = if let Some(rec) = self.recorder.lock_recover().as_ref() {
                    match rec.stop() {
                        Ok(buf) => buf,
                        Err(e) => {
                            error!("stop() failed: {e}");
                            Vec::new()
                        }
                    }
                } else {
                    error!("Recorder not available");
                    Vec::new()
                };

                *self.is_recording.lock_recover() = false;

                // In on-demand mode, close the mic (lazily if the setting is enabled)
                if matches!(*self.mode.lock_recover(), MicrophoneMode::OnDemand)
                    && !self.wakeword_mode_active()
                {
                    self.stop_microphone_stream();
                }
                *self.state.lock_recover() = RecordingState::Idle;

                // Pad if very short
                let s_len = samples.len();
                // debug!("Got {} samples", s_len);
                if s_len < WHISPER_SAMPLE_RATE && s_len > 0 {
                    let mut padded = samples;
                    padded.resize(WHISPER_SAMPLE_RATE * 5 / 4, 0.0);
                    Some(padded)
                } else {
                    Some(samples)
                }
            }
            _ => None,
        }
    }
    pub fn is_recording(&self) -> bool {
        matches!(
            *self.state.lock_recover(),
            RecordingState::Recording { .. } | RecordingState::Stopping
        )
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
            .map(|rec| rec.snapshot_from(offset))
            .unwrap_or((0, Vec::new()))
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
                // A normal stop is already draining the release tail. Session cancellation
                // suppresses the eventual paste; interrupting the drain here can drop the same
                // trailing audio this path is meant to preserve.
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
}
