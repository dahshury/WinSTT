use cpal::traits::HostTrait;
use log::{debug, warn};
use rodio::{DeviceSinkBuilder, MixerDeviceSink};
#[cfg(target_os = "windows")]
use std::collections::VecDeque;
use std::fs::File;
use std::io::BufReader;
#[cfg(target_os = "windows")]
use std::num::{NonZeroU16, NonZeroU32};
#[cfg(target_os = "windows")]
use std::sync::mpsc;
#[cfg(target_os = "windows")]
use std::sync::{LazyLock, Mutex};

/// A Communications render stream added after the matching on-demand capture
/// client opens and retained for the full recording. Keeping this stream alive
/// lets the recording chime reuse the combined Bluetooth LE topology instead of
/// creating a playback-only client after the first microphone frame.
#[cfg(target_os = "windows")]
struct PreparedAudioOutput {
    selected_device: Option<String>,
    sample_rate: u32,
    channels: u16,
    commands: mpsc::Sender<CommunicationOutputCommand>,
    completion: mpsc::Receiver<()>,
}

#[cfg(target_os = "windows")]
impl PreparedAudioOutput {
    /// True while the render worker is still running its stream. The worker sends
    /// on `completion` exactly once, as it exits; anything other than "still empty"
    /// means the WASAPI client is gone and this entry can no longer accept a chime.
    fn is_alive(&self) -> bool {
        matches!(self.completion.try_recv(), Err(mpsc::TryRecvError::Empty))
    }
}

#[cfg(target_os = "windows")]
enum CommunicationOutputCommand {
    Play(Vec<f32>),
    Shutdown,
}

#[cfg(target_os = "windows")]
static PREPARED_AUDIO_OUTPUT: LazyLock<Mutex<Option<PreparedAudioOutput>>> =
    LazyLock::new(|| Mutex::new(None));

/// Completion receiver for the renderer most recently asked to shut down. A
/// Bluetooth endpoint can take hundreds of milliseconds to tear down. Serializing
/// the next open behind this bounded receiver prevents two Communications clients
/// racing the same topology transition without ever joining a stuck driver thread.
#[cfg(target_os = "windows")]
static PENDING_RENDER_CLEANUP: LazyLock<Mutex<Option<mpsc::Receiver<()>>>> =
    LazyLock::new(|| Mutex::new(None));

#[cfg(target_os = "windows")]
const RENDER_OPEN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);
#[cfg(target_os = "windows")]
const RENDER_CLEANUP_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(800);

/// Failures from resolving an output device, opening the rodio stream, reading
/// the sound file, or queuing it for playback. Replaces the previous
/// erased error boundary so the error has a real type and `From` conversions
/// instead of an opaque trait object.
#[derive(Debug, thiserror::Error)]
pub enum AudioFeedbackError {
    #[error("failed to enumerate output devices: {0}")]
    Devices(#[from] cpal::DevicesError),

    #[error("failed to read output device name: {0}")]
    DeviceName(#[from] cpal::DeviceNameError),

    #[error("failed to open output stream: {0}")]
    Stream(#[from] rodio::DeviceSinkError),

    #[error("failed to open sound file: {0}")]
    Io(#[from] std::io::Error),

    #[error("failed to play sound: {0}")]
    Play(#[from] rodio::PlayError),

    #[error("failed to decode sound: {0}")]
    Decode(#[from] rodio::decoder::DecoderError),

    #[error("failed to manage communications audio: {0}")]
    Communication(String),
}

/// Low-level rodio playback helper shared by the winstt recording-sound system
/// (`winstt::commands::sound`). Plays `path` synchronously (blocks until the sink
/// drains) on `selected_device` (cpal name, or the system default when `None`) at
/// `volume`. Takes its routing/volume as parameters — it reads no settings, so
/// every sound the app produces flows through the one winstt sound pathway.
fn normalize_selected_device(selected_device: Option<String>) -> Option<String> {
    selected_device.filter(|name| name != "Default")
}

fn open_audio_output(selected_device: Option<&str>) -> Result<MixerDeviceSink, AudioFeedbackError> {
    let stream_builder = if let Some(device_name) = selected_device {
        if device_name == "Default" {
            debug!("Using default device");
            DeviceSinkBuilder::from_default_device()?
        } else {
            let host = crate::audio_toolkit::get_cpal_host();
            let devices = host.output_devices()?;

            let mut found_device = None;
            for device in devices {
                if crate::audio_toolkit::audio::device_display_name(&device)? == device_name {
                    found_device = Some(device);
                    break;
                }
            }

            match found_device {
                Some(device) => DeviceSinkBuilder::from_device(device)?,
                None => {
                    warn!("Device '{}' not found, using default device", device_name);
                    DeviceSinkBuilder::from_default_device()?
                }
            }
        }
    } else {
        debug!("Using default device");
        DeviceSinkBuilder::from_default_device()?
    };

    let mut device_sink = stream_builder.open_stream()?;
    device_sink.log_on_drop(false);
    Ok(device_sink)
}

fn play_audio_file_on_output(
    device_sink: &MixerDeviceSink,
    path: &std::path::Path,
    volume: f32,
) -> Result<(), AudioFeedbackError> {
    let mixer = device_sink.mixer();

    let file = File::open(path)?;
    let buf_reader = BufReader::new(file);

    let sink = rodio::play(mixer, buf_reader)?;
    sink.set_volume(volume);
    sink.sleep_until_end();

    // `sleep_until_end` returns once rodio has handed the last samples to the
    // CPAL/WASAPI output callback — NOT once they have reached the speaker. One
    // device-buffer worth of audio (~10-30 ms on WASAPI shared mode) is still in
    // the OS ring buffer at this point. Returning here drops `device_sink`, closes
    // the stream, and discards that trailing buffer. On a long clip this is
    // inaudible; on a very short chime (the ~70 ms recording sound) it clips a
    // large fraction of the tail, which is why the native chime sounded thinner /
    // "different" than the persistent-AudioContext Web Audio preview. Let the
    // device buffer drain before tearing the stream down. The margin is silent
    // (playback already finished) so it adds no perceptible latency.
    std::thread::sleep(std::time::Duration::from_millis(200));

    Ok(())
}

/// Open a silent Communications-category renderer after matching capture is
/// active and retain it for the entire recording. It is ready before recording
/// is armed, so the first-frame chime never creates or replaces an audio client
/// underneath the running microphone.
#[cfg(target_os = "windows")]
pub(crate) fn prepare_audio_output(
    selected_device: Option<String>,
) -> Result<(), AudioFeedbackError> {
    let selected_device = normalize_selected_device(selected_device);

    // Reuse a renderer that is already running on this device rather than closing
    // one and opening another. Each open/close pair is a Bluetooth LE topology
    // transition that interrupts capture, so back-to-back dictations inside the
    // microphone's lazy-close window must not pay for one on every hotkey press.
    // `stop_microphone_stream` is what retires the renderer, which ties its lifetime
    // to the microphone's.
    {
        let prepared = PREPARED_AUDIO_OUTPUT
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if prepared.as_ref().is_some_and(|existing| {
            existing.selected_device == selected_device && existing.is_alive()
        }) {
            debug!("Reusing the live Communications render stream for this recording");
            return Ok(());
        }
    }

    release_prepared_audio_output();

    let previous_cleanup = PENDING_RENDER_CLEANUP
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    if let Some(completion) = previous_cleanup {
        match completion.recv_timeout(RENDER_CLEANUP_TIMEOUT) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {
                *PENDING_RENDER_CLEANUP
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(completion);
                return Err(AudioFeedbackError::Communication(
                    "previous communications renderer is still closing; skipping this chime"
                        .to_string(),
                ));
            }
        }
    }

    let (commands, command_rx) = mpsc::channel();
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let (completion_tx, completion_rx) = mpsc::sync_channel(1);
    let worker_device = selected_device.clone();
    let worker = std::thread::Builder::new()
        .name("winstt-communications-render".to_string())
        .spawn(move || {
            let result = run_communications_output(worker_device, command_rx, ready_tx);
            if let Err(error) = result {
                log::error!("Communications render stream stopped: {error}");
            }
            let _ = completion_tx.send(());
        })
        .map_err(|error| AudioFeedbackError::Communication(error.to_string()))?;

    let (sample_rate, channels) = match ready_rx.recv_timeout(RENDER_OPEN_TIMEOUT) {
        Ok(Ok(format)) => format,
        Ok(Err(error)) => {
            drop(worker);
            return Err(AudioFeedbackError::Communication(error));
        }
        Err(error) => {
            let _ = commands.send(CommunicationOutputCommand::Shutdown);
            *PENDING_RENDER_CLEANUP
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(completion_rx);
            drop(worker);
            return Err(AudioFeedbackError::Communication(format!(
                "timed out opening communications render stream: {error}"
            )));
        }
    };

    *PREPARED_AUDIO_OUTPUT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(PreparedAudioOutput {
        selected_device,
        sample_rate,
        channels,
        commands,
        completion: completion_rx,
    });
    // A JoinHandle is intentionally not retained. Some Bluetooth endpoint
    // drivers can block IAudioClient::Stop while changing topology; waiting for
    // that worker from the recording-stop path would hang the whole app. The
    // command channel gives it an orderly shutdown without coupling lifetimes.
    drop(worker);
    log::info!(
        "Prepared persistent Communications render stream ({sample_rate} Hz, {channels} channels)"
    );
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn prepare_audio_output(
    _selected_device: Option<String>,
) -> Result<(), AudioFeedbackError> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn run_communications_output(
    selected_device: Option<String>,
    commands: mpsc::Receiver<CommunicationOutputCommand>,
    ready: mpsc::SyncSender<Result<(u32, u16), String>>,
) -> Result<(), String> {
    use wasapi::{
        AudioClientProperties, Direction, SampleType, StreamCategory, StreamMode, WaveFormat,
        initialize_mta,
    };

    initialize_mta()
        .ok()
        .map_err(|error| format!("COM initialization failed: {error}"))?;
    let enumerator = wasapi::DeviceEnumerator::new().map_err(|error| error.to_string())?;
    let device = if let Some(name) = selected_device.as_deref() {
        match enumerator
            .get_device_collection(&Direction::Render)
            .and_then(|devices| devices.get_device_with_name(name))
        {
            Ok(device) => device,
            Err(error) => {
                warn!("Output device '{name}' was not found by WASAPI ({error}); using default");
                enumerator
                    .get_default_device(&Direction::Render)
                    .map_err(|error| error.to_string())?
            }
        }
    } else {
        enumerator
            .get_default_device(&Direction::Render)
            .map_err(|error| error.to_string())?
    };

    let device_name = device
        .get_friendlyname()
        .unwrap_or_else(|_| "unknown output".to_string());
    let mut audio_client = device
        .get_iaudioclient()
        .map_err(|error| error.to_string())?;
    audio_client
        .set_properties(AudioClientProperties::new().set_category(StreamCategory::Communications))
        .map_err(|error| error.to_string())?;

    let mix_format = audio_client
        .get_mixformat()
        .map_err(|error| error.to_string())?;
    let sample_rate = mix_format.get_samplespersec();
    let channels = mix_format.get_nchannels();
    if sample_rate == 0 || channels == 0 {
        let error = format!("invalid output format: {sample_rate} Hz, {channels} channels");
        let _ = ready.send(Err(error.clone()));
        return Err(error);
    }

    let format = WaveFormat::new(
        32,
        32,
        &SampleType::Float,
        sample_rate as usize,
        channels as usize,
        None,
    );
    let (default_period, _) = audio_client
        .get_device_period()
        .map_err(|error| error.to_string())?;
    audio_client
        .initialize_client(
            &format,
            &Direction::Render,
            &StreamMode::PollingShared {
                autoconvert: true,
                buffer_duration_hns: default_period,
            },
        )
        .map_err(|error| error.to_string())?;
    audio_client
        .get_audiosessioncontrol()
        .and_then(|session| session.set_ducking_preference(true))
        .map_err(|error| {
            format!("failed to opt communications session out of auto-ducking: {error}")
        })?;
    let render_client = audio_client
        .get_audiorenderclient()
        .map_err(|error| error.to_string())?;
    let buffer_frames = audio_client
        .get_buffer_size()
        .map_err(|error| error.to_string())?;

    // Prime with silence before starting. The stream remains active until
    // capture has closed, so the chime never creates a second render client.
    let silence = vec![0_u8; buffer_frames as usize * channels as usize * size_of::<f32>()];
    render_client
        .write_to_device(buffer_frames as usize, &silence, None)
        .map_err(|error| error.to_string())?;
    audio_client
        .start_stream()
        .map_err(|error| error.to_string())?;
    let _ = ready.send(Ok((sample_rate, channels)));
    log::info!(
        "Communications render stream started on '{device_name}' ({sample_rate} Hz, {channels} channels)"
    );

    let mut samples = VecDeque::<f32>::new();
    let poll_interval = std::time::Duration::from_micros(
        (500_000_u64 * buffer_frames as u64 / sample_rate as u64).clamp(1_000, 10_000),
    );
    let mut shutdown = false;
    while !shutdown {
        loop {
            match commands.try_recv() {
                Ok(CommunicationOutputCommand::Play(new_samples)) => samples.extend(new_samples),
                Ok(CommunicationOutputCommand::Shutdown) => {
                    shutdown = true;
                    break;
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    shutdown = true;
                    break;
                }
            }
        }
        if shutdown {
            break;
        }

        let available_frames = audio_client
            .get_available_space_in_frames()
            .map_err(|error| error.to_string())? as usize;
        if available_frames > 0 {
            let sample_count = available_frames * channels as usize;
            let mut bytes = Vec::with_capacity(sample_count * size_of::<f32>());
            for _ in 0..sample_count {
                bytes.extend_from_slice(&samples.pop_front().unwrap_or(0.0).to_le_bytes());
            }
            render_client
                .write_to_device(available_frames, &bytes, None)
                .map_err(|error| error.to_string())?;
        }
        std::thread::sleep(poll_interval);
    }

    // Dropping the client on this dedicated worker closes the WASAPI stream.
    // Avoid IAudioClient::Stop here: Bluetooth drivers may synchronously wait
    // on a topology transition, and this thread must never hold up capture
    // teardown or a later hotkey press.
    log::info!("Communications render shutdown requested; dropping stream asynchronously");
    drop(render_client);
    drop(audio_client);
    Ok(())
}

/// Queue the chime on the render stream joined to the active capture route.
/// The stream deliberately remains alive after the sound ends and is released
/// only by `stop_microphone_stream`.
#[cfg(target_os = "windows")]
pub(crate) fn play_audio_file_using_prepared_output(
    path: &std::path::Path,
    selected_device: Option<String>,
    volume: f32,
) -> Result<(), AudioFeedbackError> {
    let selected_device = normalize_selected_device(selected_device);
    let prepared = PREPARED_AUDIO_OUTPUT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(prepared) = prepared
        .as_ref()
        .filter(|prepared| prepared.selected_device == selected_device)
    else {
        return Err(AudioFeedbackError::Communication(
            "no prepared Communications renderer; refusing playback-only chime fallback"
                .to_string(),
        ));
    };

    let decoder = rodio::Decoder::try_from(File::open(path)?)?;
    let channels = NonZeroU16::new(prepared.channels).ok_or_else(|| {
        AudioFeedbackError::Communication("prepared output has zero channels".to_string())
    })?;
    let sample_rate = NonZeroU32::new(prepared.sample_rate).ok_or_else(|| {
        AudioFeedbackError::Communication("prepared output has zero sample rate".to_string())
    })?;
    let samples = rodio::source::UniformSourceIterator::new(decoder, channels, sample_rate)
        .map(|sample| sample * volume)
        .collect();
    prepared
        .commands
        .send(CommunicationOutputCommand::Play(samples))
        .map_err(|error| AudioFeedbackError::Communication(error.to_string()))?;
    log::info!("Queued recording chime on persistent Communications render stream");
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn play_audio_file_using_prepared_output(
    path: &std::path::Path,
    selected_device: Option<String>,
    volume: f32,
) -> Result<(), AudioFeedbackError> {
    play_audio_file(path, selected_device, volume)
}

/// Signal the retained renderer after capture closes. The next preparation waits
/// a bounded time for this completion receiver instead of racing another client
/// against teardown or joining a driver thread that may be stuck.
#[cfg(target_os = "windows")]
pub(crate) fn release_prepared_audio_output() {
    let prepared = PREPARED_AUDIO_OUTPUT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    if let Some(prepared) = prepared {
        let _ = prepared.commands.send(CommunicationOutputCommand::Shutdown);
        *PENDING_RENDER_CLEANUP
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(prepared.completion);
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn release_prepared_audio_output() {}

pub(crate) fn play_audio_file(
    path: &std::path::Path,
    selected_device: Option<String>,
    volume: f32,
) -> Result<(), AudioFeedbackError> {
    let selected_device = normalize_selected_device(selected_device);
    let output = open_audio_output(selected_device.as_deref())?;
    play_audio_file_on_output(&output, path, volume)
}
