/// The parsed UIA snapshot. Required fields are always present; optional
/// enrichments are attached only when the sidecar emitted them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WindowContextSnapshot {
    pub window_title: String,
    pub element_name: String,
    pub focused_text: String,
    pub text_before: Option<String>,
    pub text_after: Option<String>,
    pub selected_text: Option<String>,
    pub clipboard_text: Option<String>,
    pub app_exe: Option<String>,
    pub url: Option<String>,
    pub ax_html: Option<String>,
    pub ocr_text: Option<String>,
}

/// The empty/sentinel snapshot returned on sidecar failure, timeout, malformed
/// JSON, or unsupported platforms.
pub fn empty_context() -> WindowContextSnapshot {
    WindowContextSnapshot::default()
}

/// Sidecar invocation mode. Mirrors the `winstt-context` binary flags.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContextMode {
    /// Default: focused element text only.
    Focused,
    /// `--selection`: only the user's selected text.
    Selection,
    /// `--split`: caret-aware textBefore / textAfter.
    Split,
    /// `--tree`: full UIA subtree axHtml + URL + appExe.
    Tree,
}

impl ContextMode {
    pub fn flag(self) -> Option<&'static str> {
        match self {
            ContextMode::Focused => None,
            ContextMode::Selection => Some("--selection"),
            ContextMode::Split => Some("--split"),
            ContextMode::Tree => Some("--tree"),
        }
    }
}

/// Hard outer timeout for the sidecar. The binary has its own inner watchdog.
pub const READ_TIMEOUT_MS: u64 = 1200;

/// Cap on raw sidecar stdout bytes. Long Gmail/chat captures can exceed 2 MB
/// after JSON escaping, so the caller allows a 4 MB ceiling before truncation.
pub const MAX_BUFFER_BYTES: usize = 4 * 1024 * 1024;

/// Parse the sidecar's single-line JSON into a snapshot, attaching optional
/// fields only when non-empty. Returns [`empty_context`] on bad JSON.
pub fn parse_snapshot(raw: &str) -> WindowContextSnapshot {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw.trim()) else {
        return empty_context();
    };
    let Some(obj) = value.as_object() else {
        return empty_context();
    };
    let get = |k: &str| {
        obj.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let non_empty = |k: &str| {
        let v = get(k);
        if v.is_empty() {
            None
        } else {
            Some(v)
        }
    };
    WindowContextSnapshot {
        window_title: get("windowTitle"),
        element_name: get("elementName"),
        focused_text: get("focusedText"),
        text_before: non_empty("textBefore"),
        text_after: non_empty("textAfter"),
        selected_text: non_empty("selectedText"),
        clipboard_text: non_empty("clipboardText"),
        app_exe: non_empty("appExe"),
        url: non_empty("url"),
        ax_html: non_empty("axHtml"),
        ocr_text: non_empty("ocrText"),
    }
}

/// Public reader trait so managers and tests can swap the sidecar transport.
pub trait ContextReader {
    /// Run the sidecar in `mode`. Implementations always resolve, returning an
    /// empty snapshot on failure.
    fn read(&self, mode: ContextMode) -> WindowContextSnapshot;
}
