// PORT IMPL — drafted against real APIs, pending compile. Source: app/PORT/07_*.md §3 + lib_wiring.md §3,
// memory project_context_playground_debug. Wraps managers::ContextManager.
//
// Context-awareness debug command — gated behind the `context-playground` feature
// (flip off before release; mirrors CONTEXT_PLAYGROUND_ENABLED in the Electron
// build). Surfaces EXACTLY what the dictation capture pulls from the focused
// field, for the live debug window.

use serde::{Deserialize, Serialize};
use specta::Type;

#[cfg(feature = "context-playground")]
use std::sync::Arc;
#[cfg(feature = "context-playground")]
use tauri::State;

#[cfg(feature = "context-playground")]
use crate::winstt::context::ContextMode;
#[cfg(feature = "context-playground")]
use crate::winstt::managers::ContextManager;

/// The debug capture payload — the raw snapshot fields + the formatted prompt
/// fragment the LLM would receive, plus the detection verdicts.
#[derive(Clone, Debug, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContextDebugPayload {
    pub window_title: String,
    pub element_name: String,
    pub focused_text: String,
    pub app_exe: Option<String>,
    pub url: Option<String>,
    pub prompt_fragment: String,
    pub is_ide: bool,
    pub is_terminal: bool,
    pub is_canvas: bool,
    pub is_rich_field: bool,
}

/// `debug_read_context` — capture the focused-field context in `mode` and return
/// both the raw snapshot and the formatted fragment (debug only).
#[cfg(feature = "context-playground")]
#[tauri::command]
#[specta::specta]
pub fn debug_read_context(
    context: State<'_, Arc<ContextManager>>,
    mode: String,
) -> ContextDebugPayload {
    use crate::winstt::context::{
        debug_verdicts, format_context_for_prompt, ContextReader,
    };

    let mode = match mode.as_str() {
        "selection" => ContextMode::Selection,
        "split" => ContextMode::Split,
        "tree" => ContextMode::Tree,
        _ => ContextMode::Focused,
    };
    let snapshot = context.read(mode);
    let verdicts = debug_verdicts(&snapshot);
    let fragment = format_context_for_prompt(&snapshot);
    ContextDebugPayload {
        window_title: snapshot.window_title.clone(),
        element_name: snapshot.element_name.clone(),
        focused_text: snapshot.focused_text.clone(),
        app_exe: snapshot.app_exe.clone(),
        url: snapshot.url.clone(),
        prompt_fragment: fragment,
        is_ide: *verdicts.get("ide").unwrap_or(&false),
        is_terminal: *verdicts.get("terminal").unwrap_or(&false),
        is_canvas: *verdicts.get("canvas").unwrap_or(&false),
        is_rich_field: *verdicts.get("rich_field").unwrap_or(&false),
    }
}
