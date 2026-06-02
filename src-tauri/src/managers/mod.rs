//! Dual-manager boundary rule: `managers/` = the inherited Handy pipeline core
//! (audio capture, model registry, transcription engine, history); `winstt/managers/`
//! = WinSTT feature subsystems layered on top (cloud STT, TTS, diarization, wakeword,
//! LLM transforms, realtime preview, context, file-transcribe, downloads). The one-way
//! dependency edge is `winstt/managers/ → managers/` (features reuse the core); the
//! core must not reach back into `winstt/` except at the explicit seams the port wires.

pub mod audio;
pub mod history;
pub mod model;
pub mod transcription;
