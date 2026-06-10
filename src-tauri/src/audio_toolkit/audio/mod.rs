// Re-export all audio components
mod device;
mod recorder;
mod resampler;
mod utils;
mod visualizer;

pub(crate) use device::device_display_name;
pub use device::{list_input_devices, list_output_devices, CpalDeviceInfo};
pub use recorder::{
    is_microphone_access_denied, is_no_input_device_error, AudioDeviceError, AudioRecorder,
    RealtimeAudioProgress,
};
pub use resampler::FrameResampler;
pub use utils::{read_wav_samples, save_wav_file, verify_wav_file};
pub use visualizer::AudioVisualiser;
