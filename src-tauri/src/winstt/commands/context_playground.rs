// Source (authoritative):
// frontend/electron/ipc/context-playground-window.ts + frontend/electron/lib/context-debug.ts
// + src/shared/api/context-debug-types.ts (the renderer's ContextDebugReport /
//   ContextPlaygroundPush contract) + src/views/context-playground/model/use-context-playground.ts
// + docs/port/10_frontend_port_plan.md §6 WU-13 + memory project_context_playground_debug.
//
// DEBUG-ONLY context-awareness playground backend. The renderer hides entry
// points behind CONTEXT_PLAYGROUND_ENABLED, but the backend commands stay
// registered so generated bindings and native-bridge routes never point at
// missing commands in dev builds.
//
// The renderer (`views/context-playground`) drives three channels; the adapter
// (native-bridge-adapter.ts) routes them:
//   IPC.CONTEXT_PLAYGROUND_SET_LIVE  → command `context_playground_set_live`  ({ enabled })
//   IPC.CONTEXT_PLAYGROUND_ARM_DEEP  → command `context_playground_arm_deep`
//   IPC.CONTEXT_PLAYGROUND_CLOSE     → window  `close_window`  (handled by windows.rs)
//   IPC.CONTEXT_PLAYGROUND_REPORT    → event   `context-playground:report`  (push)
//
// Capture model (matches the reference `decideTick` state machine exactly):
//   - Live: every ~750ms capture the foreground field via the production tree
//     path and push a `report`.
//   - Deep (armed by the renderer): the NEXT external tick runs all four UIA
//     modes side-by-side, then disarms.
//   - Own-focus skip: the native UIA reader reads the FOREGROUND window, so the
//     loop must never read its OWN UI — any tick where one of our webviews holds
//     focus pushes `waiting{own-window-focused}` (deduped) instead of capturing.
//
// HARD-RULE-safe: NEW file under winstt/commands/. State lives in module-level
// statics (mirroring the reference handler's module-level `liveEnabled`/`armedDeep`,
// NOT a Tauri-managed manager) so no lib.rs `.manage(...)` edit is needed. The
// captures reuse the already-registered `ContextManager` (Arc state).
//
// The push payloads are BYTE-IDENTICAL to `ContextPlaygroundPush` in
// context-debug-types.ts so the reused renderer listener needs no changes.

// Compatibility behavior: visibility is a frontend debug flag, not a Rust cfg.
// Keep these commands registered unconditionally so flipping the renderer flag
// does not require rebuilding the backend with a matching Cargo feature.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::winstt::context::{
    apply_deny_list, format_context_for_prompt, is_denied_by_list, is_ide_context,
    looks_like_terminal, ContextMode, ContextReader, WindowContextSnapshot,
};
use crate::winstt::managers::ContextManager;

use super::settings::read_settings;

const EVT_REPORT: &str = "context-playground:report";
const POLL_INTERVAL_MS: u64 = 750;
/// The native helper's hard axHtml cap (mirrors AX_HTML_CAP surfaced to the UI).
const AX_HTML_CAP: u64 = 60_000;
/// ASR prompt-tail sanitize cap (mirrors the 250-char Whisper prior-text window).
const ASR_TAIL_MAX: usize = 250;

// ── module-level state (mirrors the reference handler's module statics) ─────────

static LIVE_ENABLED: AtomicBool = AtomicBool::new(true);
static ARMED_DEEP: AtomicBool = AtomicBool::new(false);
static CAPTURING: AtomicBool = AtomicBool::new(false);
/// Generation token — bumped on every (re)start so a stale loop exits.
static LOOP_GEN: AtomicU64 = AtomicU64::new(0);
/// Last "waiting" reason pushed (dedupe the 750ms heartbeat). Reset after a real
/// report so the next wait re-pushes. Mirrors `lastWaitReason`.
static LAST_WAIT: Lazy<Mutex<Option<&'static str>>> = Lazy::new(|| Mutex::new(None));

// ── renderer-shape payloads (camelCase, byte-identical to context-debug-types.ts) ─

#[derive(Clone, Debug, Serialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContextSnapshotView {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_exe: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ax_html: Option<String>,
    pub element_name: String,
    pub focused_text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ocr_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_after: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub window_title: String,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ContextModeResult {
    pub duration_ms: u64,
    /// "tree" | "split" | "default" | "selection"
    pub mode: String,
    pub ok: bool,
    pub snapshot: ContextSnapshotView,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ContextMetrics {
    pub ax_html_cap: u64,
    pub ax_html_chars: u64,
    pub deny_list_size: u64,
    pub focused_text_chars: u64,
    pub prompt_fragment_chars: u64,
    pub text_after_chars: u64,
    pub text_before_chars: u64,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ContextDebugReport {
    pub asr_prompt_tail: String,
    pub asr_prompt_tail_raw: String,
    pub captured_at: u64,
    pub contentless: bool,
    pub context_awareness_enabled: bool,
    pub deep: bool,
    pub denied: bool,
    pub denied_reason: Option<String>,
    pub duration_ms: u64,
    pub filtered_snapshot: ContextSnapshotView,
    pub has_caret: bool,
    pub is_ide: bool,
    pub is_terminal: bool,
    pub metrics: ContextMetrics,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modes: Option<Vec<ContextModeResult>>,
    pub ocr_used: bool,
    pub prompt_fragment: String,
    pub raw_snapshot: ContextSnapshotView,
}

/// The live push payload — `ContextPlaygroundPush`. Internally-tagged: a "report"
/// carries `report`; a "waiting" carries `reason`. `#[serde(tag = "kind")]`
/// matches the renderer's discriminated union exactly. Emitted as a PLAIN string
/// event (`context-playground:report`), so it needs only `Serialize` — no
/// `specta::Type` (it isn't a command param/return nor a collected event).
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[expect(
    clippy::large_enum_variant,
    reason = "debug-only context-playground payload; rarely constructed"
)]
pub enum ContextPlaygroundPush {
    #[serde(rename = "report")]
    Report { at: u64, report: ContextDebugReport },
    #[serde(rename = "waiting")]
    Waiting { at: u64, reason: String },
}

// ── snapshot → renderer view ───────────────────────────────────────────────────

fn to_view(s: &WindowContextSnapshot) -> ContextSnapshotView {
    ContextSnapshotView {
        app_exe: s.app_exe.clone(),
        ax_html: s.ax_html.clone(),
        element_name: s.element_name.clone(),
        focused_text: s.focused_text.clone(),
        ocr_text: s.ocr_text.clone(),
        text_after: s.text_after.clone(),
        text_before: s.text_before.clone(),
        url: s.url.clone(),
        window_title: s.window_title.clone(),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn char_count(opt: Option<&str>) -> u64 {
    opt.map(|s| s.chars().count() as u64).unwrap_or(0)
}

/// Sanitize + tail-cap the raw textBefore into the Whisper ASR prior-text bias.
/// Collapses control/decorative noise + whitespace and keeps the last 250 chars
/// (mirrors `sanitizeAsrPromptTail` in context-debug.ts — minimal port).
fn asr_prompt_tail(raw: &str) -> String {
    let collapsed = raw
        .chars()
        .map(|c| if c.is_control() && c != '\n' { ' ' } else { c })
        .collect::<String>();
    // Collapse runs of whitespace into single spaces.
    let mut out = String::with_capacity(collapsed.len());
    let mut prev_ws = false;
    for c in collapsed.chars() {
        if c.is_whitespace() {
            if !prev_ws {
                out.push(' ');
            }
            prev_ws = true;
        } else {
            out.push(c);
            prev_ws = false;
        }
    }
    let trimmed = out.trim();
    let n = trimmed.chars().count();
    if n <= ASR_TAIL_MAX {
        trimmed.to_string()
    } else {
        trimmed.chars().skip(n - ASR_TAIL_MAX).collect()
    }
}

/// Find the deny-list pattern that matched (for the "denied by X" banner). Mirrors
/// the renderer surfacing `deniedReason`.
fn matched_deny_reason(snapshot: &WindowContextSnapshot, deny_list: &[String]) -> Option<String> {
    if !is_denied_by_list(snapshot, deny_list) {
        return None;
    }
    deny_list
        .iter()
        .find(|p| is_denied_by_list(snapshot, std::slice::from_ref(p)))
        .cloned()
}

/// Build the full `ContextDebugReport` from a raw capture. The deny-list resolves
/// the `filtered_snapshot` (what the pipeline actually uses); the formatter
/// produces the prompt fragment; the verdicts drive the IDE/terminal chips.
fn build_report(
    raw: &WindowContextSnapshot,
    deep: bool,
    context_awareness_enabled: bool,
    deny_list: &[String],
    duration_ms: u64,
    modes: Option<Vec<ContextModeResult>>,
) -> ContextDebugReport {
    let denied = is_denied_by_list(raw, deny_list);
    let denied_reason = matched_deny_reason(raw, deny_list);
    let filtered = apply_deny_list(raw, deny_list);
    let prompt_fragment = format_context_for_prompt(&filtered);

    let raw_tail = raw.text_before.clone().unwrap_or_default();
    let asr_tail = asr_prompt_tail(raw_tail.trim());

    let has_caret = raw.text_before.is_some() || raw.text_after.is_some();
    let contentless = raw.focused_text.trim().is_empty()
        && raw.text_before.as_deref().unwrap_or("").trim().is_empty()
        && raw.ax_html.as_deref().unwrap_or("").trim().is_empty();
    let ocr_used = raw
        .ocr_text
        .as_deref()
        .map(|t| !t.trim().is_empty())
        .unwrap_or(false);

    let metrics = ContextMetrics {
        ax_html_cap: AX_HTML_CAP,
        ax_html_chars: char_count(raw.ax_html.as_deref()),
        deny_list_size: deny_list.len() as u64,
        focused_text_chars: raw.focused_text.chars().count() as u64,
        prompt_fragment_chars: prompt_fragment.chars().count() as u64,
        text_after_chars: char_count(raw.text_after.as_deref()),
        text_before_chars: char_count(raw.text_before.as_deref()),
    };

    ContextDebugReport {
        asr_prompt_tail: asr_tail,
        asr_prompt_tail_raw: raw_tail.trim().to_string(),
        captured_at: now_ms(),
        contentless,
        context_awareness_enabled,
        deep,
        denied,
        denied_reason,
        duration_ms,
        filtered_snapshot: to_view(&filtered),
        has_caret,
        is_ide: is_ide_context(raw),
        is_terminal: looks_like_terminal(raw),
        metrics,
        modes,
        ocr_used,
        prompt_fragment,
        raw_snapshot: to_view(raw),
    }
}

// ── focus / push helpers ───────────────────────────────────────────────────────

/// True when one of OUR webview windows currently holds OS focus (so the next
/// capture would read our own UI). Mirrors `BrowserWindow.getFocusedWindow() !== null`.
fn own_window_focused(app: &AppHandle) -> bool {
    app.webview_windows()
        .values()
        .any(|w| w.is_focused().unwrap_or(false))
}

fn push(app: &AppHandle, payload: ContextPlaygroundPush) {
    let _ = app.emit(EVT_REPORT, payload);
}

fn push_report(app: &AppHandle, report: ContextDebugReport) {
    if let Ok(mut last) = LAST_WAIT.lock() {
        *last = None;
    }
    push(
        app,
        ContextPlaygroundPush::Report {
            at: now_ms(),
            report,
        },
    );
}

fn push_waiting(app: &AppHandle, reason: &'static str) {
    if let Ok(mut last) = LAST_WAIT.lock() {
        if *last == Some(reason) {
            return; // dedupe the heartbeat
        }
        *last = Some(reason);
    }
    push(
        app,
        ContextPlaygroundPush::Waiting {
            at: now_ms(),
            reason: reason.to_string(),
        },
    );
}

// ── capture ─────────────────────────────────────────────────────────────────────

/// Capture one mode and time it. Mirrors a single `runCaptureForMode`.
fn capture_mode(context: &ContextManager, mode: ContextMode, label: &str) -> ContextModeResult {
    let start = std::time::Instant::now();
    let snapshot = ContextReader::read(context, mode);
    let duration_ms = start.elapsed().as_millis() as u64;
    let ok = !snapshot.focused_text.trim().is_empty()
        || snapshot
            .text_before
            .as_deref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        || snapshot
            .ax_html
            .as_deref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
    ContextModeResult {
        duration_ms,
        mode: label.to_string(),
        ok,
        snapshot: to_view(&snapshot),
    }
}

/// Run a live (tree-only) or deep (all-four-modes) capture and push the report.
fn run_capture(app: &AppHandle, context: &ContextManager, deep: bool) {
    CAPTURING.store(true, Ordering::SeqCst);
    let settings = read_settings(app);
    let context_awareness_enabled = settings.general.context_awareness;
    let deny_list = settings.general.context_deny_list.clone();

    let start = std::time::Instant::now();
    // The production live path is the tree mode; deep adds the side-by-side modes.
    let raw = ContextReader::read(context, ContextMode::Tree);

    let modes = if deep {
        Some(vec![
            capture_mode(context, ContextMode::Tree, "tree"),
            capture_mode(context, ContextMode::Split, "split"),
            capture_mode(context, ContextMode::Focused, "default"),
            capture_mode(context, ContextMode::Selection, "selection"),
        ])
    } else {
        None
    };
    let duration_ms = start.elapsed().as_millis() as u64;

    let report = build_report(
        &raw,
        deep,
        context_awareness_enabled,
        &deny_list,
        duration_ms,
        modes,
    );
    push_report(app, report);
    CAPTURING.store(false, Ordering::SeqCst);
}

// ── poll loop (mirrors decideTick + runPollTick) ───────────────────────────────

#[derive(Debug, PartialEq, Eq)]
enum TickDecision {
    SkipCapturing,
    WaitOff,
    WaitOwn,
    CaptureLive,
    CaptureDeep,
}

fn decide_tick(
    armed_deep: bool,
    capturing: bool,
    live_enabled: bool,
    own_focus: bool,
) -> TickDecision {
    if capturing {
        return TickDecision::SkipCapturing;
    }
    if !(live_enabled || armed_deep) {
        return TickDecision::WaitOff;
    }
    if own_focus {
        return TickDecision::WaitOwn;
    }
    if armed_deep {
        TickDecision::CaptureDeep
    } else {
        TickDecision::CaptureLive
    }
}

/// (Re)start the poll loop. Bumps the generation token so any prior loop exits.
/// Each open / set-live(true) / arm-deep call re-primes it with an immediate tick.
fn start_polling(app: AppHandle) {
    let generation = LOOP_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    if let Ok(mut last) = LAST_WAIT.lock() {
        *last = None;
    }

    tauri::async_runtime::spawn(async move {
        // Kick an immediate tick so the user sees state without a full interval.
        loop {
            // A newer start superseded this loop — exit.
            if LOOP_GEN.load(Ordering::SeqCst) != generation {
                return;
            }
            // Clone the Arc out so no Tauri State guard is held across the await.
            let Some(context) = app
                .try_state::<Arc<ContextManager>>()
                .map(|s| s.inner().clone())
            else {
                return; // manager not registered yet — nothing to capture.
            };
            let decision = decide_tick(
                ARMED_DEEP.load(Ordering::SeqCst),
                CAPTURING.load(Ordering::SeqCst),
                LIVE_ENABLED.load(Ordering::SeqCst),
                own_window_focused(&app),
            );
            match decision {
                TickDecision::SkipCapturing => {}
                TickDecision::WaitOff => push_waiting(&app, "live-off"),
                TickDecision::WaitOwn => push_waiting(&app, "own-window-focused"),
                TickDecision::CaptureLive => run_capture(&app, context.as_ref(), false),
                TickDecision::CaptureDeep => {
                    ARMED_DEEP.store(false, Ordering::SeqCst);
                    run_capture(&app, context.as_ref(), true);
                }
            }
            tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
        }
    });
}

// ── commands ───────────────────────────────────────────────────────────────────

/// `context_playground_set_live` — flip live polling on/off. A freshly-mounted
/// renderer sends `{ enabled: true }`, which BOTH enables live mode AND signals
/// "renderer ready" so a capture lands promptly (re-primes the loop). Mirrors
/// `handleSetLive`.
#[tauri::command]
#[specta::specta]
pub fn context_playground_set_live(app: AppHandle, enabled: bool) {
    LIVE_ENABLED.store(enabled, Ordering::SeqCst);
    start_polling(app);
}

/// `context_playground_arm_deep` — arm a deep (all-modes) capture; the next
/// external tick runs all four UIA modes side-by-side, then disarms. Mirrors
/// `handleArmDeep`.
#[tauri::command]
#[specta::specta]
pub fn context_playground_arm_deep(app: AppHandle) {
    ARMED_DEEP.store(true, Ordering::SeqCst);
    start_polling(app);
}

/// One-shot capture (kept for parity with `debug_read_context`'s mode probe; the
/// live loop is the primary path). Returns the full report so a caller can read
/// it synchronously without subscribing to the push channel.
#[tauri::command]
#[specta::specta]
pub fn context_playground_capture(
    app: AppHandle,
    context: State<'_, Arc<ContextManager>>,
    deep: bool,
) -> ContextDebugReport {
    let settings = read_settings(&app);
    let deny_list = settings.general.context_deny_list.clone();
    let context_awareness_enabled = settings.general.context_awareness;
    let reader: &ContextManager = context.inner().as_ref();
    let start = std::time::Instant::now();
    let raw = ContextReader::read(reader, ContextMode::Tree);
    let modes = if deep {
        Some(vec![
            capture_mode(reader, ContextMode::Tree, "tree"),
            capture_mode(reader, ContextMode::Split, "split"),
            capture_mode(reader, ContextMode::Focused, "default"),
            capture_mode(reader, ContextMode::Selection, "selection"),
        ])
    } else {
        None
    };
    let duration_ms = start.elapsed().as_millis() as u64;
    build_report(
        &raw,
        deep,
        context_awareness_enabled,
        &deny_list,
        duration_ms,
        modes,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap() -> WindowContextSnapshot {
        WindowContextSnapshot::default()
    }

    #[test]
    fn decide_tick_priority_order() {
        // capturing dominates everything.
        assert_eq!(
            decide_tick(true, true, true, true),
            TickDecision::SkipCapturing
        );
        // both live + deep off → wait-off.
        assert_eq!(
            decide_tick(false, false, false, false),
            TickDecision::WaitOff
        );
        // own-focus blocks capture.
        assert_eq!(decide_tick(false, false, true, true), TickDecision::WaitOwn);
        // live, external focus → live capture.
        assert_eq!(
            decide_tick(false, false, true, false),
            TickDecision::CaptureLive
        );
        // armed deep, external focus → deep capture.
        assert_eq!(
            decide_tick(true, false, false, false),
            TickDecision::CaptureDeep
        );
        // armed deep beats live capture.
        assert_eq!(
            decide_tick(true, false, true, false),
            TickDecision::CaptureDeep
        );
    }

    #[test]
    fn asr_tail_collapses_and_caps() {
        let raw = format!("{}END", "x ".repeat(300));
        let tail = asr_prompt_tail(&raw);
        assert!(tail.chars().count() <= ASR_TAIL_MAX);
        assert!(tail.ends_with("END"));
        // whitespace collapsed (no double spaces)
        assert!(!asr_prompt_tail("a   b\t\tc").contains("  "));
    }

    #[test]
    fn report_marks_denied_and_reason() {
        let s = WindowContextSnapshot {
            window_title: "Vault".into(),
            focused_text: "secret".into(),
            app_exe: Some("1password.exe".into()),
            ..snap()
        };
        let r = build_report(&s, false, true, &["1password.exe".into()], 5, None);
        assert!(r.denied);
        assert_eq!(r.denied_reason.as_deref(), Some("1password.exe"));
        // filtered snapshot blanks the focused text.
        assert_eq!(r.filtered_snapshot.focused_text, "");
        // raw snapshot keeps it.
        assert_eq!(r.raw_snapshot.focused_text, "secret");
    }

    #[test]
    fn report_caret_and_metrics() {
        let s = WindowContextSnapshot {
            element_name: "Body".into(),
            text_before: Some("Dear team, ".into()),
            focused_text: "hi".into(),
            ..snap()
        };
        let r = build_report(&s, false, true, &[], 3, None);
        assert!(r.has_caret);
        assert_eq!(
            r.metrics.text_before_chars,
            "Dear team, ".chars().count() as u64
        );
        assert_eq!(r.metrics.focused_text_chars, 2);
        assert_eq!(r.metrics.ax_html_cap, AX_HTML_CAP);
    }

    #[test]
    fn report_contentless_when_all_empty() {
        let r = build_report(&snap(), false, false, &[], 1, None);
        assert!(r.contentless);
        assert!(!r.has_caret);
        assert!(!r.ocr_used);
    }

    #[test]
    fn deep_report_carries_four_modes() {
        let modes = vec![
            ContextModeResult {
                duration_ms: 1,
                mode: "tree".into(),
                ok: true,
                snapshot: ContextSnapshotView::default(),
            },
            ContextModeResult {
                duration_ms: 1,
                mode: "split".into(),
                ok: false,
                snapshot: ContextSnapshotView::default(),
            },
            ContextModeResult {
                duration_ms: 1,
                mode: "default".into(),
                ok: false,
                snapshot: ContextSnapshotView::default(),
            },
            ContextModeResult {
                duration_ms: 1,
                mode: "selection".into(),
                ok: false,
                snapshot: ContextSnapshotView::default(),
            },
        ];
        let r = build_report(&snap(), true, true, &[], 4, Some(modes));
        assert!(r.deep);
        assert_eq!(r.modes.as_ref().map(|m| m.len()), Some(4));
    }

    #[test]
    fn snapshot_view_serializes_camelcase() {
        let view = ContextSnapshotView {
            window_title: "W".into(),
            element_name: "E".into(),
            focused_text: "F".into(),
            app_exe: Some("chrome.exe".into()),
            ..Default::default()
        };
        let json = serde_json::to_string(&view).unwrap();
        assert!(json.contains("\"windowTitle\""));
        assert!(json.contains("\"elementName\""));
        assert!(json.contains("\"appExe\""));
        // None optionals are skipped.
        assert!(!json.contains("\"axHtml\""));
    }

    #[test]
    fn push_report_serializes_kind_tag() {
        let report = build_report(&snap(), false, false, &[], 1, None);
        let p = ContextPlaygroundPush::Report { at: 123, report };
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"kind\":\"report\""));
        assert!(json.contains("\"report\""));

        let w = ContextPlaygroundPush::Waiting {
            at: 9,
            reason: "live-off".into(),
        };
        let jw = serde_json::to_string(&w).unwrap();
        assert!(jw.contains("\"kind\":\"waiting\""));
        assert!(jw.contains("\"reason\":\"live-off\""));
    }
}
