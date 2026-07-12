// Re-export all audio components
mod device;
mod recorder;
mod resampler;
mod utils;
mod visualizer;

pub(crate) use device::device_display_name;
pub use device::{CpalDeviceInfo, list_input_devices, list_output_devices};
pub use recorder::{
    AudioDeviceError, AudioRecorder, AudioRecorderError, CapturedAudio, RealtimeAudioProgress,
    is_microphone_access_denied, is_no_input_device_error,
};
pub use resampler::FrameResampler;
pub use utils::{
    read_wav_samples, save_wav_file, save_wav_file_with_spec, verify_wav_file, wav_duration_ms,
};
pub use visualizer::AudioVisualiser;
