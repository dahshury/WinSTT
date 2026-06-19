use super::WindowContextSnapshot;

/// Which editor/IDE the foreground app is. Drives per-IDE feature gating.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdeKind {
    Cursor,
    Windsurf,
    VsCode,
    VsCodeInsiders,
    Vscodium,
    SublimeText,
    VisualStudio,
    JetBrains,
}

/// Per-IDE capability profile.
///
/// - `variable_recognition`: backtick-wrap spoken code symbols.
/// - `file_tagging`: the "@file" chat affordance, limited to Cursor + Windsurf.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IdeProfile {
    pub kind: IdeKind,
    pub variable_recognition: bool,
    pub file_tagging: bool,
}

/// Classify the foreground app's executable into an `IdeKind`, or `None` when
/// it is not a recognized editor.
pub fn ide_kind_from_exe(app_exe: Option<&str>) -> Option<IdeKind> {
    let exe = app_exe.unwrap_or("").to_lowercase();
    if exe.is_empty() {
        return None;
    }
    let exact = match exe.as_str() {
        "cursor.exe" => Some(IdeKind::Cursor),
        "windsurf.exe" => Some(IdeKind::Windsurf),
        "code.exe" => Some(IdeKind::VsCode),
        "code - insiders.exe" => Some(IdeKind::VsCodeInsiders),
        "vscodium.exe" => Some(IdeKind::Vscodium),
        "sublime_text.exe" => Some(IdeKind::SublimeText),
        "devenv.exe" => Some(IdeKind::VisualStudio),
        _ => None,
    };
    if exact.is_some() {
        return exact;
    }
    const JETBRAINS: &[&str] = &[
        "idea",
        "pycharm",
        "webstorm",
        "rubymine",
        "clion",
        "goland",
        "rustrover",
        "rider",
        "phpstorm",
    ];
    if exe.ends_with(".exe") && JETBRAINS.iter().any(|p| exe.starts_with(p)) {
        return Some(IdeKind::JetBrains);
    }
    None
}

/// Resolve the per-IDE capability profile for the foreground app.
pub fn ide_profile(snapshot: &WindowContextSnapshot) -> Option<IdeProfile> {
    let kind = ide_kind_from_exe(snapshot.app_exe.as_deref())?;
    let file_tagging = matches!(kind, IdeKind::Cursor | IdeKind::Windsurf);
    Some(IdeProfile {
        kind,
        variable_recognition: true,
        file_tagging,
    })
}

/// True when the foreground app is a recognized IDE / code editor.
pub fn is_ide_context(snapshot: &WindowContextSnapshot) -> bool {
    ide_kind_from_exe(snapshot.app_exe.as_deref()).is_some()
}

/// True when the focused control is an IDE's integrated terminal.
pub fn is_ide_terminal(snapshot: &WindowContextSnapshot) -> bool {
    is_ide_context(snapshot) && looks_like_terminal(snapshot)
}

/// True when the focused surface looks like an AI coding CLI running in a
/// terminal. Conservative: requires a terminal-shaped focus and CLI marker.
pub fn is_ai_coding_cli(snapshot: &WindowContextSnapshot) -> bool {
    if !looks_like_terminal(snapshot) {
        return false;
    }
    let haystack = format!(
        "{} {}",
        snapshot.window_title.to_lowercase(),
        snapshot.element_name.to_lowercase()
    );
    contains_word(&haystack, "claude") || contains_word(&haystack, "codex")
}

/// True when the focused control looks like a terminal/console.
pub fn looks_like_terminal(snapshot: &WindowContextSnapshot) -> bool {
    let name = snapshot.element_name.to_lowercase();
    contains_word(&name, "terminal") || contains_word(&name, "console")
}

pub(super) fn contains_word(haystack: &str, word: &str) -> bool {
    let bytes = haystack.as_bytes();
    let mut from = 0;
    while let Some(rel) = haystack[from..].find(word) {
        let start = from + rel;
        let end = start + word.len();
        let left_ok = start == 0 || !bytes[start - 1].is_ascii_alphanumeric();
        let right_ok = end >= bytes.len() || !bytes[end].is_ascii_alphanumeric();
        if left_ok && right_ok {
            return true;
        }
        from = start + 1;
    }
    false
}

/// True for canvas/grid surfaces whose real content is painted to canvas and
/// not exposed reliably through UIA.
pub fn is_canvas_surface(app_exe: Option<&str>, url: Option<&str>) -> bool {
    let exe = app_exe.unwrap_or("").to_lowercase();
    let url = url.unwrap_or("").to_lowercase();
    const CANVAS_EXES: &[&str] = &["figma.exe"];
    const CANVAS_HOSTS: &[&str] = &[
        "figma.com",
        "canva.com",
        "docs.google.com/spreadsheets",
        "sheets.google.com",
        "miro.com",
        "excalidraw.com",
    ];
    if CANVAS_EXES.contains(&exe.as_str()) {
        return true;
    }
    CANVAS_HOSTS.iter().any(|h| url.contains(h))
}
