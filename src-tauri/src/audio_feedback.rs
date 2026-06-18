use cpal::traits::HostTrait;
use log::{debug, warn};
use rodio::DeviceSinkBuilder;
use std::fs::File;
use std::io::BufReader;

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
}

/// Low-level rodio playback helper shared by the winstt recording-sound system
/// (`winstt::commands::sound`). Plays `path` synchronously (blocks until the sink
/// drains) on `selected_device` (cpal name, or the system default when `None`) at
/// `volume`. Takes its routing/volume as parameters — it reads no settings, so
/// every sound the app produces flows through the one winstt sound pathway.
pub(crate) fn play_audio_file(
    path: &std::path::Path,
    selected_device: Option<String>,
    volume: f32,
) -> Result<(), AudioFeedbackError> {
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
    let mixer = device_sink.mixer();

    let file = File::open(path)?;
    let buf_reader = BufReader::new(file);

    let sink = rodio::play(mixer, buf_reader)?;
    sink.set_volume(volume);
    sink.sleep_until_end();

    Ok(())
}
