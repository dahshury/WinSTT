//! Dual-manager boundary rule: `managers/` = the shared runtime core
//! (audio capture, transcription engine, history); `winstt/managers/`
//! = WinSTT feature subsystems layered on top (cloud STT, TTS, wakeword,
//! LLM transforms, realtime preview, context, file-transcribe, downloads).

pub mod audio;
pub mod history;
pub mod transcription;
