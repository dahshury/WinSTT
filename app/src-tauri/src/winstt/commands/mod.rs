// PORT IMPL — drafted against real APIs, pending compile. Source: app/PORT/lib_wiring.md §3.
//
// The WinSTT Tauri command layer. Every `#[tauri::command] #[specta::specta]` fn
// here wraps a manager (winstt/managers/*.rs) or a pure module (catalog,
// settings_schema, cloud_stt, llm, tts, context). Every payload type derives
// `specta::Type, serde::{Serialize, Deserialize}, Clone` so tauri-specta emits TS
// bindings + invoke routing.
//
// Commands are grouped by feature; the orchestrator appends each `winstt::commands::<group>::<fn>`
// to `collect_commands![]` in lib.rs (the full list is in lib_wiring.md §3).

pub mod settings;
pub mod stt;
pub mod tts;
pub mod llm;
pub mod cloud_stt;
pub mod wakeword;
pub mod listen;
pub mod wordts;
pub mod file_transcribe;
pub mod context;

/// The specta-typed events the WinSTT port emits (registered in
/// `collect_events![]`). Re-exported here so lib.rs has one import site.
pub mod events;
