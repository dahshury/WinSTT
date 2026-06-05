// PORT IMPL. Source (authoritative):
// frontend/electron/ipc/transforms.ts + frontend/electron/ipc/transform-hotkeys.ts
// + frontend/electron/lib/selection-capture.ts
// + frontend/electron/ipc/llm.ts (runProcessText provider routing).
//
// The Transforms apply/preview pipeline + its renderer feedback events. WU-13
// owns the `transforms:applied` / `transforms:failed` PLAIN events (matching
// WinSTT's the reference IPC shape byte-for-byte so the reused
// `features/transform-notifications` TransformToast listener works unchanged):
//   • `transforms:applied` → { before, after, source }
//   • `transforms:failed`  → { reason }
//
// The adapter (native-bridge-adapter.ts) routes:
//   IPC.TRANSFORMS_APPLY   → command `apply_transform`           (no args; selection + paste internal)
//   IPC.TRANSFORMS_PREVIEW → command `apply_transform_preview`   ({ text, feature, config })
//   IPC.TRANSFORMS_APPLIED → event   `transforms:applied`
//   IPC.TRANSFORMS_FAILED  → event   `transforms:failed`
//
// `apply_transform` is the end-to-end runtime path the global hotkey
// (`transforms.hotkey`, default `LCtrl+LShift+T`) ALSO calls via the public
// `run_transform_pipeline` re-export below: capture selection → run the composed
// transforms prompt (presets + custom modifiers) over the CONFIGURED provider →
// paste-replace → emit `transforms:applied`. On any failure it emits
// `transforms:failed` and returns the empty result so the renderer toast
// surfaces the error.
//
// PROVIDER ROUTING (mirrors llm.rs::process_transform → runProcessText): the
// transform runs on `llm.transforms.provider` — Ollama via the all-Rust
// streaming path (LlmManager::ollama_transform), OpenRouter via the OpenAI-
// compatible structured-output path with fallback model
// (LlmManager::openrouter_chat), Apple Intelligence soft-fails to the original
// text (its CLI is macOS-only and this is a Windows app).
//
// SELECTION CAPTURE (mirrors selection-capture.ts captureSelection): UIA
// TextPattern selection first (side-effect-free, via the context sidecar
// `--selection`); on an empty UIA read, the clipboard-sandwich fallback runs —
// save clipboard → SendInput Ctrl+C → poll for the clipboard to change → restore
// the original clipboard. The paste-back (crate::clipboard::paste) re-runs its
// own clipboard sandwich, so the user's clipboard is left exactly as it was.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::managers::history::HistoryManager;
use crate::winstt::context::{ContextMode, ContextReader, WindowContextSnapshot};
use crate::winstt::llm::{
    self, build_dictation_system_prompt, build_system_prompt, merge_presets_with_custom_modifiers,
    PresetEntry as LlmPresetEntry, PresetKey as LlmPresetKey, PresetLevel as LlmPresetLevel,
    ThinkingEffort as LlmEffort,
};
use crate::winstt::managers::{ContextManager, LlmManager};
use crate::winstt::settings_schema::{
    CustomModifier as SettingsCustomModifier, EffortLevel as SettingsOpenRouterEffort,
    LlmFeatureBase, LlmProvider, PresetEntry as SettingsPreset, PresetKey as SettingsPresetKey,
    PresetLevel as SettingsLevel, ThinkingEffort as SettingsEffort, WinsttSettings,
};

use super::llm as llm_commands;
use super::settings::read_settings;

// ── event channel names (BYTE-IDENTICAL to WinSTT's IPC strings) ───────────────

const EVT_APPLIED: &str = "transforms:applied";
const EVT_FAILED: &str = "transforms:failed";
const EVT_PROCESSING_START: &str = "transforms:processing-start";
const EVT_PROCESSING_END: &str = "transforms:processing-end";

// ── clipboard-sandwich tuning (mirrors selection-capture.ts constants) ─────────

/// How long we wait for the clipboard to update after the synthetic Ctrl+C.
const CLIPBOARD_POLL_TIMEOUT_MS: u64 = 700;
/// Polling interval — fast enough to feel instant, slow enough not to spin.
const CLIPBOARD_POLL_INTERVAL_MS: u64 = 25;
/// Playground previews are diagnostic and user-driven; they should fail loudly
/// instead of leaving the modal in a spinner forever on a slow local model.
const PLAYGROUND_PREVIEW_TIMEOUT: Duration = Duration::from_secs(60);

// ── public payload shapes (mirror the renderer's TransformApplyResult) ─────────

/// The selection source the capture resolved. Mirrors WinSTT's
/// `ApplyResult.source` ("uia" | "clipboard" | "empty").
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TransformSource {
    Uia,
    Clipboard,
    Empty,
}

impl TransformSource {
    fn as_str(self) -> &'static str {
        match self {
            TransformSource::Uia => "uia",
            TransformSource::Clipboard => "clipboard",
            TransformSource::Empty => "empty",
        }
    }
}

/// Returned by `apply_transform` and mirrored on the `transforms:applied` event.
/// Field shape matches the renderer's `TransformApplyResult` exactly so the
/// `invokeOrDefault` round-trip + the toast's `onTransformApplied` reshape are
/// both identities.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TransformApplyResult {
    pub before: String,
    pub after: String,
    pub source: TransformSource,
}

impl TransformApplyResult {
    fn empty() -> Self {
        Self {
            before: String::new(),
            after: String::new(),
            source: TransformSource::Empty,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TransformCaptureScope {
    Selection,
    FocusedField,
}

#[derive(Clone, Debug)]
struct TransformCapture {
    scope: TransformCaptureScope,
    source: TransformSource,
    text: String,
}

impl TransformCapture {
    fn empty() -> Self {
        Self {
            scope: TransformCaptureScope::Selection,
            source: TransformSource::Empty,
            text: String::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum TransformPastePlan {
    ReplaceFocusedField(String),
    ReplaceSelection(String),
}

// ── settings → prompt-shape conversions (local; llm.rs keeps its own private) ───

fn to_llm_level(level: SettingsLevel) -> LlmPresetLevel {
    match level {
        SettingsLevel::Light => LlmPresetLevel::Light,
        SettingsLevel::Medium => LlmPresetLevel::Medium,
        SettingsLevel::High => LlmPresetLevel::High,
    }
}

fn to_llm_key(key: SettingsPresetKey) -> LlmPresetKey {
    match key {
        SettingsPresetKey::Neutral => LlmPresetKey::Neutral,
        SettingsPresetKey::Formal => LlmPresetKey::Formal,
        SettingsPresetKey::Friendly => LlmPresetKey::Friendly,
        SettingsPresetKey::Technical => LlmPresetKey::Technical,
        SettingsPresetKey::Concise => LlmPresetKey::Concise,
        SettingsPresetKey::Summarize => LlmPresetKey::Summarize,
        SettingsPresetKey::Reorder => LlmPresetKey::Reorder,
        SettingsPresetKey::Restructure => LlmPresetKey::Restructure,
        SettingsPresetKey::RewordForClarity => LlmPresetKey::RewordForClarity,
        SettingsPresetKey::Translate => LlmPresetKey::Translate,
    }
}

fn to_llm_preset(p: &SettingsPreset) -> LlmPresetEntry {
    LlmPresetEntry::Builtin {
        key: to_llm_key(p.key),
        level: p.level.map(to_llm_level),
        target_lang: p.target_lang.clone(),
    }
}

fn to_llm_effort(e: SettingsEffort) -> LlmEffort {
    match e {
        SettingsEffort::Off => LlmEffort::Off,
        SettingsEffort::Low => LlmEffort::Low,
        SettingsEffort::Medium => LlmEffort::Medium,
        SettingsEffort::High => LlmEffort::High,
    }
}

fn openrouter_effort_value(e: SettingsOpenRouterEffort) -> &'static str {
    match e {
        SettingsOpenRouterEffort::Low => "low",
        SettingsOpenRouterEffort::Medium => "medium",
        SettingsOpenRouterEffort::High => "high",
    }
}

fn parse_openrouter_effort_value(s: &str) -> String {
    match s {
        "low" => "low",
        "high" => "high",
        _ => "medium",
    }
    .to_string()
}

fn openrouter_options(base: &LlmFeatureBase) -> llm::OpenRouterRequestOptions {
    llm::OpenRouterRequestOptions {
        reasoning_effort: Some(openrouter_effort_value(base.reasoning_effort).to_string()),
        verbosity: Some(openrouter_effort_value(base.verbosity).to_string()),
        max_output_tokens: base.max_output_tokens.filter(|v| *v > 0),
    }
}

fn openrouter_options_from_preview(cfg: &LlmPreviewConfig) -> llm::OpenRouterRequestOptions {
    llm::OpenRouterRequestOptions {
        reasoning_effort: Some(parse_openrouter_effort_value(&cfg.reasoning_effort)),
        verbosity: Some(parse_openrouter_effort_value(&cfg.verbosity)),
        max_output_tokens: cfg.max_output_tokens.filter(|v| *v > 0),
    }
}

fn to_llm_custom(m: &SettingsCustomModifier) -> llm::CustomModifier {
    llm::CustomModifier {
        id: m.id.clone(),
        name: m.name.clone(),
        prompt: m.prompt.clone(),
        enabled: m.enabled,
        levels_enabled: m.levels_enabled,
        level: m.level.map(to_llm_level),
    }
}

/// Compose the transforms feature's full preset list (builtins + enabled custom
/// modifiers) — the SAME ordering WinSTT's `processText("transforms")` produces.
fn transforms_presets(
    presets: &[SettingsPreset],
    customs: &[SettingsCustomModifier],
) -> Vec<LlmPresetEntry> {
    let builtins: Vec<LlmPresetEntry> = presets.iter().map(to_llm_preset).collect();
    let customs: Vec<llm::CustomModifier> = customs.iter().map(to_llm_custom).collect();
    merge_presets_with_custom_modifiers(&builtins, &customs)
}

fn preview_requires_visible_change(presets: &[LlmPresetEntry]) -> bool {
    presets.iter().any(|entry| match entry {
        LlmPresetEntry::Builtin {
            key: LlmPresetKey::Neutral,
            ..
        } => false,
        LlmPresetEntry::Builtin { .. } | LlmPresetEntry::Custom { .. } => true,
    })
}

fn is_transforms_feature(feature: &str) -> bool {
    feature == "transforms"
}

fn preview_user_prompt(feature: &str, presets: &[LlmPresetEntry], text: &str) -> String {
    if is_transforms_feature(feature) {
        llm::transforms_user_prompt_for_presets(presets, text)
    } else {
        llm::dictation_user_prompt_for_presets(presets, text)
    }
}

fn preview_system_prompt(settings: &WinsttSettings, presets: &[LlmPresetEntry]) -> String {
    let vocab = llm_commands::build_vocab(settings);
    let mut prompt = build_dictation_system_prompt(presets, "", &vocab);
    if preview_requires_visible_change(presets) {
        prompt.push_str(
            "\n\nPlayground preview: Non-neutral tone/modifier instructions are active. \
             Apply them visibly. Do not return the input verbatim unless the input is empty \
             or pure noise.",
        );
    }
    prompt
}

fn finalize_preview_answer(settings: &WinsttSettings, answer: &str) -> String {
    let pairs = llm_commands::replacement_pairs(settings);
    llm::apply_replacement_pairs(answer, &pairs)
}

fn provider_label(provider: LlmProvider) -> &'static str {
    match provider {
        LlmProvider::AppleIntelligence => "apple-intelligence",
        LlmProvider::Openrouter => "openrouter",
        LlmProvider::Ollama => "ollama",
    }
}

fn ensure_preview_changed_if_required(
    requires_visible_change: bool,
    input: &str,
    output: &str,
    provider: LlmProvider,
    model: &str,
) -> Result<(), String> {
    if !requires_visible_change || input.trim() != output.trim() {
        return Ok(());
    }
    Err(format!(
        "LLM preview returned the input unchanged even though active tone/modifier instructions were selected (provider={}, model={}).",
        provider_label(provider),
        if model.trim().is_empty() { "auto" } else { model.trim() }
    ))
}

fn preview_timeout_error(provider: LlmProvider, model: &str) -> String {
    format!(
        "LLM preview timed out after {} seconds (provider={}, model={}). Try a smaller model or set thinking effort to Off/Low.",
        PLAYGROUND_PREVIEW_TIMEOUT.as_secs(),
        provider_label(provider),
        if model.trim().is_empty() { "auto" } else { model.trim() }
    )
}

// ── enable gate (mirrors transforms.ts isTransformsEnabled) ────────────────────

/// Transforms run when the feature is enabled AND a model is configured for the
/// chosen provider. There is no master switch — dictation has its own gate.
/// Mirrors `isTransformsEnabled` + `hasTransformsModel` in transforms.ts.
fn is_transforms_enabled(settings: &WinsttSettings) -> bool {
    let t = &settings.llm.transforms;
    if !t.enabled {
        return false;
    }
    match t.base.provider {
        LlmProvider::Openrouter => !settings.llm.openrouter_api_key.trim().is_empty(),
        LlmProvider::Ollama | LlmProvider::AppleIntelligence => !t.base.model.trim().is_empty(),
    }
}

// ── provider routing (mirrors llm.rs::process_transform → runProcessText) ───────

/// Run the composed transforms `system_prompt` over `text` on the feature's
/// CONFIGURED provider. Returns the transformed text on success, or `Err(reason)`
/// on a hard provider failure (the caller surfaces it via `transforms:failed`).
///
/// Routing mirrors `runProcessText` in llm.ts exactly:
///   - Apple Intelligence → soft-fail to the original text (CLI is macOS-only;
///     this is a Windows app). NEVER errors.
///   - OpenRouter → OpenAI-compatible structured-output chat with fallback model.
///   - Ollama → the all-Rust streaming `/api/chat` path.
async fn run_transform_provider(
    mgr: &Arc<LlmManager>,
    settings: &WinsttSettings,
    system_prompt: &str,
    user_prompt: &str,
    text: &str,
    effort: LlmEffort,
    model: &str,
) -> Result<String, String> {
    match settings.llm.transforms.base.provider {
        // Apple Intelligence is a soft-fail provider on Windows — paste the
        // original text rather than blocking the pipeline (mirrors
        // runAppleIntelligencePath's catch → return text).
        LlmProvider::AppleIntelligence => Ok(text.to_string()),
        LlmProvider::Openrouter => {
            let api_key = settings.llm.openrouter_api_key.clone();
            let selection = settings.llm.transforms.base.openrouter_model.clone();
            let fallback = settings
                .llm
                .transforms
                .base
                .openrouter_fallback_model
                .clone();
            // OpenRouter's structured-output path already returns the fallback
            // text on a total failure (never throws across the boundary), so the
            // pipeline can paste-replace with the original on a dead provider.
            Ok(run_openrouter_with_fallback(
                mgr,
                &api_key,
                &selection,
                &fallback,
                system_prompt,
                user_prompt,
                text,
                openrouter_options(&settings.llm.transforms.base),
            )
            .await)
        }
        LlmProvider::Ollama => {
            let endpoint = settings.llm.endpoint.clone();
            let request_id = mgr.next_request_id();
            mgr.ollama_transform(
                &endpoint,
                model,
                system_prompt,
                user_prompt,
                text,
                effort,
                &request_id,
            )
            .await
        }
    }
}

/// Try the primary OpenRouter selection; on failure (and when a fallback is
/// configured), retry with the fallback model. On total failure, return the
/// original text. Mirrors `runOpenRouterWithFallback` (and llm.rs's copy).
async fn run_openrouter_with_fallback(
    mgr: &Arc<LlmManager>,
    api_key: &str,
    primary: &str,
    fallback: &str,
    system_prompt: &str,
    user_prompt: &str,
    text: &str,
    options: llm::OpenRouterRequestOptions,
) -> String {
    match mgr
        .openrouter_chat(
            api_key,
            primary,
            system_prompt,
            user_prompt,
            text,
            options.clone(),
        )
        .await
    {
        Ok(answer) => answer,
        Err(_primary_err) if !fallback.is_empty() => mgr
            .openrouter_chat(api_key, fallback, system_prompt, user_prompt, text, options)
            .await
            .unwrap_or_else(|_| text.to_string()),
        Err(_) => text.to_string(),
    }
}

/// Preview-specific OpenRouter routing. Unlike the runtime transform path, the
/// playground must surface provider failures instead of making them look like
/// "the model decided not to change anything".
async fn run_openrouter_preview_with_fallback(
    mgr: &Arc<LlmManager>,
    api_key: &str,
    primary: &str,
    fallback: &str,
    system_prompt: &str,
    user_prompt: &str,
    feature: &str,
    request_id: &str,
    options: llm::OpenRouterRequestOptions,
) -> Result<String, String> {
    match mgr
        .openrouter_chat(
            api_key,
            primary,
            system_prompt,
            user_prompt,
            "",
            options.clone(),
        )
        .await
    {
        Ok(answer) if !answer.trim().is_empty() => Ok(answer),
        Ok(_) if !fallback.is_empty() => {
            log::warn!(
                "[llm][{request_id}] preview {feature} OpenRouter primary model '{primary}' returned no text; trying fallback '{fallback}'"
            );
            mgr.openrouter_chat(
                api_key,
                fallback,
                system_prompt,
                user_prompt,
                "",
                options.clone(),
            )
                .await
                .and_then(|answer| {
                    if answer.trim().is_empty() {
                        Err(format!(
                            "OpenRouter fallback model '{fallback}' returned no transformed text"
                        ))
                    } else {
                        Ok(answer)
                    }
                })
                .map_err(|fallback_err| {
                    format!(
                        "OpenRouter primary model '{primary}' returned no transformed text; fallback model '{fallback}' failed: {}",
                        llm::compact_error_for_log(&fallback_err)
                    )
                })
        }
        Ok(_) => Err(format!(
            "OpenRouter model '{primary}' returned no transformed text"
        )),
        Err(primary_err) if !fallback.is_empty() => {
            log::warn!(
                "[llm][{request_id}] preview {feature} OpenRouter primary model '{primary}' failed; trying fallback '{fallback}': {}",
                llm::compact_error_for_log(&primary_err)
            );
            mgr.openrouter_chat(api_key, fallback, system_prompt, user_prompt, "", options)
                .await
                .and_then(|answer| {
                    if answer.trim().is_empty() {
                        Err(format!(
                            "OpenRouter fallback model '{fallback}' returned no transformed text"
                        ))
                    } else {
                        Ok(answer)
                    }
                })
                .map_err(|fallback_err| {
                    format!(
                        "OpenRouter primary model '{primary}' failed: {}; fallback model '{fallback}' failed: {}",
                        llm::compact_error_for_log(&primary_err),
                        llm::compact_error_for_log(&fallback_err)
                    )
                })
        }
        Err(primary_err) => Err(format!(
            "OpenRouter model '{primary}' failed: {}",
            llm::compact_error_for_log(&primary_err)
        )),
    }
}

// ── selection capture (UIA + clipboard-sandwich fallback) ──────────────────────

/// Capture the user's current selection. UIA (`--selection` via the context
/// sidecar) is the primary path; the clipboard-sandwich is the fallback. Returns
/// the captured text plus whether it came from a true selection or the whole
/// focused field; an empty capture yields [`TransformCapture::empty`]. Mirrors
/// `captureSelection` in selection-capture.ts.
fn capture_selection(context: &ContextManager, app: &AppHandle) -> TransformCapture {
    // 1. UIA selection (side-effect-free) via the context sidecar. Mirrors
    //    tryUiaSelection: the sidecar's `--selection` mode reports the live
    //    TextPattern selection in `selected_text`, falling back to `focused_text`
    //    when the control only exposes the focused value. The latter is a
    //    full-field transform, so paste-back must select-all first.
    if context.is_available() {
        let snap = ContextReader::read(context, ContextMode::Selection);
        if let Some(selected) = snap.selected_text.clone() {
            if !selected.trim().is_empty() {
                return TransformCapture {
                    scope: TransformCaptureScope::Selection,
                    source: TransformSource::Uia,
                    text: selected,
                };
            }
        }
        if !snap.focused_text.trim().is_empty() {
            return TransformCapture {
                scope: TransformCaptureScope::FocusedField,
                source: TransformSource::Uia,
                text: snap.focused_text,
            };
        }
    }

    // 2. Clipboard-sandwich fallback (mirrors captureViaClipboard): save the
    //    current clipboard, simulate Ctrl+C, poll for the clipboard to change,
    //    then restore the original clipboard. UIA fails silently in Chromium-
    //    based renderers (Slack, Discord, VS Code) and most the reference apps unless
    //    accessibility is force-enabled — this trick covers those.
    capture_via_clipboard(app)
}

/// Capture the current selection for a NON-transform consumer (the TTS read-aloud
/// global hotkey). Resolves the `ContextManager` from managed state and returns
/// just the selected text (`""` when nothing is selected / no context manager).
/// Runs the SAME UIA → clipboard-sandwich path as the transforms pipeline, so the
/// hotkey behaves identically to "Speak selection". BLOCKING (the clipboard
/// sandwich simulates Ctrl+C) — call it off the hotkey thread.
pub fn capture_selection_text(app: &AppHandle) -> String {
    match app.try_state::<Arc<ContextManager>>() {
        Some(ctx) => {
            let ctx = ctx.inner().clone();
            capture_selection(ctx.as_ref(), app).text
        }
        None => String::new(),
    }
}

fn capture_via_clipboard(app: &AppHandle) -> TransformCapture {
    let original = read_clipboard(app).unwrap_or_default();

    // Simulate Ctrl+C in the focused app. A failure here (no Enigo state) just
    // means the clipboard won't change and we fall through to "empty".
    if let Err(e) = send_copy_keystroke(app) {
        log::debug!("transforms: Ctrl+C copy keystroke failed: {e}");
    }

    let captured = wait_for_clipboard_change(app, &original);

    // No fresh selection landed in the clipboard — restore whatever was there and
    // report empty (mirrors clipboardCaptureFailed → restoreClipboard → EMPTY).
    if captured == original || captured.trim().is_empty() {
        restore_clipboard(app, &original);
        return TransformCapture::empty();
    }

    // Restore the user's original clipboard immediately. The paste-back
    // (crate::clipboard::paste) runs its OWN clipboard sandwich, so the captured
    // selection never has to live on the clipboard past this point — the user's
    // clipboard is left exactly as it was before the transform.
    restore_clipboard(app, &original);
    TransformCapture {
        scope: TransformCaptureScope::Selection,
        source: TransformSource::Clipboard,
        text: captured,
    }
}

/// Send a synthetic Ctrl+C (Cmd+C on macOS) through the managed Enigo instance so
/// the focused app copies its current selection. Uses platform virtual key codes
/// (layout-independent) to mirror the native `winstt-paste.exe --copy` helper.
///
/// The Enigo keystroke is dispatched on the MAIN thread (input synthesis must not run on the
/// async-runtime / spawn_blocking worker — the same main-thread paste discipline actions.rs
/// keeps). `capture_via_clipboard` runs on a `spawn_blocking` thread, so it can block on the
/// keystroke completing here; we round-trip a oneshot channel and wait for the result.
fn send_copy_keystroke(app: &AppHandle) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let app_for_main = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(send_copy_keystroke_on_main(&app_for_main));
    })
    .map_err(|e| format!("failed to schedule copy keystroke on main thread: {e}"))?;
    // Bounded wait so a stalled main thread can't wedge the transform pipeline forever.
    match rx.recv_timeout(Duration::from_secs(2)) {
        Ok(result) => result,
        Err(_) => Err("copy keystroke timed out on main thread".to_string()),
    }
}

/// The actual Enigo Ctrl+C synthesis — MUST run on the main thread (called only via
/// `send_copy_keystroke`'s `run_on_main_thread`).
fn send_copy_keystroke_on_main(app: &AppHandle) -> Result<(), String> {
    use enigo::{Direction, Key, Keyboard};

    let enigo_state = app
        .try_state::<crate::input::EnigoState>()
        .ok_or("Enigo state not initialized")?;
    let mut enigo = enigo_state
        .0
        .lock()
        .map_err(|e| format!("Failed to lock Enigo: {e}"))?;

    #[cfg(target_os = "macos")]
    let (modifier_key, c_key) = (Key::Meta, Key::Other(8)); // Cmd + C
    #[cfg(target_os = "windows")]
    let (modifier_key, c_key) = (Key::Control, Key::Other(0x43)); // VK_C
    #[cfg(target_os = "linux")]
    let (modifier_key, c_key) = (Key::Control, Key::Unicode('c'));

    enigo
        .key(modifier_key, Direction::Press)
        .map_err(|e| format!("Failed to press modifier key: {e}"))?;
    enigo
        .key(c_key, Direction::Click)
        .map_err(|e| format!("Failed to click C key: {e}"))?;
    std::thread::sleep(Duration::from_millis(50));
    enigo
        .key(modifier_key, Direction::Release)
        .map_err(|e| format!("Failed to release modifier key: {e}"))?;
    Ok(())
}

/// Poll the clipboard until it changes from `original` or the timeout elapses.
/// Returns the new value (or the current clipboard if nothing changed). Mirrors
/// `waitForClipboardChange`.
fn wait_for_clipboard_change(app: &AppHandle, original: &str) -> String {
    let deadline = Instant::now() + Duration::from_millis(CLIPBOARD_POLL_TIMEOUT_MS);
    while Instant::now() < deadline {
        let current = read_clipboard(app).unwrap_or_default();
        // Fresh = changed AND non-empty (mirrors isFreshClipboard).
        if current != original && !current.is_empty() {
            return current;
        }
        std::thread::sleep(Duration::from_millis(CLIPBOARD_POLL_INTERVAL_MS));
    }
    read_clipboard(app).unwrap_or_default()
}

fn read_clipboard(app: &AppHandle) -> Option<String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().read_text().ok()
}

/// Write `original` back to the clipboard if it held something (mirrors
/// `restoreClipboard` — an empty original is left untouched).
fn restore_clipboard(app: &AppHandle, original: &str) {
    if original.is_empty() {
        return;
    }
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let _ = app.clipboard().write_text(original.to_string());
}

fn replace_unique_occurrence(haystack: &str, needle: &str, replacement: &str) -> Option<String> {
    if needle.is_empty() {
        return None;
    }
    let mut matches = haystack.match_indices(needle);
    let (start, _) = matches.next()?;
    if matches.next().is_some() {
        return None;
    }

    let mut out = String::with_capacity(haystack.len() - needle.len() + replacement.len());
    out.push_str(&haystack[..start]);
    out.push_str(replacement);
    out.push_str(&haystack[start + needle.len()..]);
    Some(out)
}

fn field_replacement_for_lost_selection(
    focused_text: &str,
    captured_text: &str,
    transformed: &str,
) -> Option<String> {
    if focused_text.trim().is_empty() || captured_text.trim().is_empty() {
        return None;
    }
    if focused_text == captured_text {
        return Some(transformed.to_string());
    }
    replace_unique_occurrence(focused_text, captured_text, transformed)
}

fn plan_transform_paste(
    capture: &TransformCapture,
    transformed: &str,
    current: Option<&WindowContextSnapshot>,
) -> TransformPastePlan {
    if capture.scope == TransformCaptureScope::FocusedField {
        return TransformPastePlan::ReplaceFocusedField(transformed.to_string());
    }

    let Some(snapshot) = current else {
        return TransformPastePlan::ReplaceSelection(transformed.to_string());
    };
    let selected = snapshot.selected_text.as_deref().unwrap_or("");
    if selected == capture.text {
        return TransformPastePlan::ReplaceSelection(transformed.to_string());
    }
    if let Some(field_text) =
        field_replacement_for_lost_selection(&snapshot.focused_text, &capture.text, transformed)
    {
        return TransformPastePlan::ReplaceFocusedField(field_text);
    }
    TransformPastePlan::ReplaceSelection(transformed.to_string())
}

// ── emit helpers ───────────────────────────────────────────────────────────────

fn emit_applied(app: &AppHandle, result: &TransformApplyResult) {
    let _ = app.emit(
        EVT_APPLIED,
        serde_json::json!({
            "before": result.before,
            "after": result.after,
            "source": result.source.as_str(),
        }),
    );
}

fn emit_failed(app: &AppHandle, reason: &str) {
    let _ = app.emit(EVT_FAILED, serde_json::json!({ "reason": reason }));
}

fn selected_transform_model(settings: &WinsttSettings) -> Option<String> {
    let model = match settings.llm.transforms.base.provider {
        LlmProvider::Openrouter => {
            let primary = settings.llm.transforms.base.openrouter_model.trim();
            let fallback = settings
                .llm
                .transforms
                .base
                .openrouter_fallback_model
                .trim();
            if primary.is_empty() {
                fallback
            } else {
                primary
            }
        }
        LlmProvider::AppleIntelligence | LlmProvider::Ollama => {
            settings.llm.transforms.base.model.trim()
        }
    };
    if model.is_empty() {
        None
    } else {
        Some(model.to_string())
    }
}

fn transform_llm_meta(settings: &WinsttSettings, processing_ms: i64) -> Option<String> {
    selected_transform_model(settings).map(|model| {
        serde_json::json!({
            "model": model,
            "processingMs": processing_ms,
        })
        .to_string()
    })
}

fn persist_transform_history(
    app: &AppHandle,
    settings: &WinsttSettings,
    result: &TransformApplyResult,
    processing_ms: i64,
) {
    if result.before.trim().is_empty() && result.after.trim().is_empty() {
        return;
    }
    let Some(history_manager) = app.try_state::<Arc<HistoryManager>>() else {
        log::warn!("transforms: history manager not initialized; transform history not saved");
        return;
    };
    let meta = transform_llm_meta(settings, processing_ms);
    match history_manager.save_transform_entry(
        result.before.clone(),
        result.after.clone(),
        result.source.as_str().to_string(),
        meta,
    ) {
        Ok(entry) => super::history::emit_transform_history_added(app, &entry),
        Err(err) => log::warn!("transforms: failed to save transform history: {err}"),
    }
}

struct TransformProcessingGuard {
    app: AppHandle,
}

impl TransformProcessingGuard {
    fn new(app: &AppHandle) -> Self {
        crate::utils::show_recording_overlay(app);
        crate::tray::on_llm_thinking_start(app);
        let _ = app.emit(EVT_PROCESSING_START, ());
        Self { app: app.clone() }
    }
}

impl Drop for TransformProcessingGuard {
    fn drop(&mut self) {
        let _ = self.app.emit(EVT_PROCESSING_END, ());
        crate::tray::on_llm_thinking_stop(&self.app);
        crate::utils::hide_recording_overlay(&self.app);
    }
}

// ── end-to-end pipeline (shared by the command AND the global hotkey) ───────────

/// The full Transforms runtime: gate → capture selection → run the composed
/// presets+modifiers prompt over the configured provider → paste-replace → emit
/// `transforms:applied`. Resolves to the [`TransformApplyResult`] on success; on
/// a disabled feature, no selection, or a provider failure it emits
/// `transforms:failed` (or an empty result for the no-selection hint) and returns
/// the empty/partial result. NEVER errors past this layer.
///
/// Both the `apply_transform` command (renderer `applyTransform()`) and the
/// global `transforms.hotkey` action call THIS, so the two entry points are
/// byte-identical (mirrors `runTransformPipeline`, shared by the IPC handler and
/// the uIOhook listener in the reference build).
pub async fn run_transform_pipeline(app: &AppHandle) -> TransformApplyResult {
    let settings = read_settings(app);

    // Gate: feature disabled / no model → emit failure, return empty (mirrors
    // `requireEnabled` → broadcast `transforms:failed`).
    if !is_transforms_enabled(&settings) {
        emit_failed(app, "LLM text transformation is disabled");
        return TransformApplyResult::empty();
    }

    // Resolve the LlmManager from managed state (the hotkey path has no `State<>`
    // injection, so resolve it here; the command path resolves the same instance).
    let mgr = match app.try_state::<Arc<LlmManager>>() {
        Some(state) => state.inner().clone(),
        None => {
            emit_failed(app, "LLM manager not initialized");
            return TransformApplyResult::empty();
        }
    };

    // Capture the current selection (UIA → clipboard-sandwich fallback). This
    // touches the clipboard/keyboard, so run it off the async pump.
    let context_manager = app
        .try_state::<Arc<ContextManager>>()
        .map(|state| state.inner().clone());
    let capture = match context_manager.clone() {
        Some(ctx) => {
            let app_for_capture = app.clone();
            match tauri::async_runtime::spawn_blocking(move || {
                capture_selection(ctx.as_ref(), &app_for_capture)
            })
            .await
            {
                Ok(capture) => capture,
                Err(_) => TransformCapture::empty(),
            }
        }
        None => TransformCapture::empty(),
    };

    if capture.text.trim().is_empty() {
        // No-selection: WinSTT broadcasts `transforms:failed { "No text selected" }`
        // AND returns an `ApplyResult` with empty before/after.
        emit_failed(app, "No text selected");
        return TransformApplyResult {
            before: String::new(),
            after: String::new(),
            source: capture.source,
        };
    }

    let selected = capture.text.clone();
    let _processing = TransformProcessingGuard::new(app);

    // Compose the transforms system prompt (presets + enabled custom modifiers).
    let presets = transforms_presets(
        &settings.llm.transforms.presets,
        &settings.llm.transforms.custom_modifiers,
    );
    let system_prompt = build_system_prompt(&presets);
    let user_prompt = llm::transforms_user_prompt_for_presets(&presets, &selected);
    let effort = to_llm_effort(settings.llm.transforms.base.thinking_effort);
    let model = settings.llm.transforms.base.model.clone();

    // Run the LLM over the CONFIGURED provider. On a hard error, emit failure +
    // return the original-as-before so the toast surfaces the message (mirrors
    // `runLlm`'s catch → broadcast `transforms:failed` → rethrow).
    let processing_started = Instant::now();
    let transformed = match run_transform_provider(
        &mgr,
        &settings,
        &system_prompt,
        &user_prompt,
        &selected,
        effort,
        &model,
    )
    .await
    {
        Ok(out) => out,
        Err(reason) => {
            emit_failed(app, &reason);
            return TransformApplyResult {
                before: selected,
                after: String::new(),
                source: capture.source,
            };
        }
    };
    let processing_ms = processing_started
        .elapsed()
        .as_millis()
        .min(i64::MAX as u128) as i64;

    let current_snapshot = match context_manager.clone() {
        Some(ctx) if ctx.is_available() => tauri::async_runtime::spawn_blocking(move || {
            ContextReader::read(ctx.as_ref(), ContextMode::Selection)
        })
        .await
        .ok(),
        _ => None,
    };
    match plan_transform_paste(&capture, &transformed, current_snapshot.as_ref()) {
        TransformPastePlan::ReplaceSelection(text) => {
            // Paste replaces the still-highlighted selection (clipboard + Ctrl+V). Use the
            // REPLACE-mode paste (no trailing space, no auto-submit Enter — this is a rewrite-in-place,
            // not a dictation) and schedule it on the MAIN thread: this pipeline runs on the async
            // runtime, and input synthesis must not run off it (the discipline actions.rs keeps). The
            // paste runs its own clipboard sandwich, so the user's clipboard is restored.
            let _ = crate::clipboard::paste_on_main_thread(app, text, true);
        }
        TransformPastePlan::ReplaceFocusedField(text) => {
            let _ = crate::clipboard::paste_replace_field_on_main_thread(app, text);
        }
    }

    let result = TransformApplyResult {
        before: selected,
        after: transformed,
        source: capture.source,
    };
    persist_transform_history(app, &settings, &result, processing_ms);
    emit_applied(app, &result);
    result
}

// ── commands ───────────────────────────────────────────────────────────────────

/// `apply_transform` — end-to-end Transforms pipeline (renderer `applyTransform()`
/// + the `transforms.hotkey` global-hotkey path). Delegates to
/// [`run_transform_pipeline`] so the command and the hotkey are byte-identical.
///
/// NEVER throws past this layer — the renderer's `invokeOrDefault` would mask it
/// and the toast would never fire.
#[tauri::command]
#[specta::specta]
pub async fn apply_transform(app: AppHandle) -> Result<TransformApplyResult, String> {
    Ok(run_transform_pipeline(&app).await)
}

/// Explicit LLM config the Playground runs against (mirrors `LlmPreviewConfig` /
/// the reference main `FeatureLlmConfig`). Connection values (endpoint, key) are
/// read from settings regardless, so they are NOT carried here.
#[derive(Clone, Debug, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct LlmPreviewConfig {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub openrouter_model: String,
    #[serde(default)]
    pub openrouter_fallback_model: String,
    #[serde(default)]
    pub reasoning_effort: String,
    #[serde(default)]
    pub verbosity: String,
    #[serde(default)]
    pub max_output_tokens: Option<i64>,
    #[serde(default)]
    pub thinking_effort: String,
    #[serde(default)]
    pub presets: Vec<SettingsPreset>,
    #[serde(default)]
    pub custom_modifiers: Vec<SettingsCustomModifier>,
}

/// `apply_transform_preview` — Playground preview (renderer `runLlmPreview`).
/// Runs `text` through the chosen feature's full composed pipeline WITHOUT
/// touching selection / clipboard / paste. `feature` is "dictation" | "transforms";
/// an explicit `config` overrides the feature's saved presets/modifiers/model AND
/// provider. Mirrors `handlePreview` → `processText(text, "", feature, config)` —
/// which routes through `runProcessText` (provider-aware), so the preview honors
/// the selected provider exactly like the runtime path.
#[tauri::command]
#[specta::specta]
pub async fn apply_transform_preview(
    app: AppHandle,
    llm_manager: State<'_, Arc<LlmManager>>,
    text: String,
    feature: String,
    config: Option<LlmPreviewConfig>,
) -> Result<String, String> {
    let settings = read_settings(&app);
    let is_dictation = feature == "dictation";

    // Resolve system-prompt / model / effort / provider — config override first,
    // else the feature's saved settings. The override's `provider` string maps to
    // the LlmProvider enum so the Playground can exercise any provider.
    let (
        system_prompt,
        user_prompt,
        effort,
        model,
        provider,
        openrouter_model,
        openrouter_fallback,
        openrouter_request_options,
        requires_visible_change,
    ) = if let Some(cfg) = config {
        let presets = transforms_presets(&cfg.presets, &cfg.custom_modifiers);
        let requires_visible_change = preview_requires_visible_change(&presets);
        let sys = preview_system_prompt(&settings, &presets);
        let user = preview_user_prompt(&feature, &presets, &text);
        let eff = parse_effort(&cfg.thinking_effort);
        let model = if cfg.model.trim().is_empty() {
            saved_model(&settings, is_dictation)
        } else {
            cfg.model.clone()
        };
        (
            sys,
            user,
            eff,
            model,
            parse_provider(&cfg.provider, &settings, is_dictation),
            cfg.openrouter_model.clone(),
            cfg.openrouter_fallback_model.clone(),
            openrouter_options_from_preview(&cfg),
            requires_visible_change,
        )
    } else {
        let base = if is_dictation {
            &settings.llm.dictation.base
        } else {
            &settings.llm.transforms.base
        };
        let (presets_src, customs_src) = if is_dictation {
            (
                &settings.llm.dictation.presets,
                &settings.llm.dictation.custom_modifiers,
            )
        } else {
            (
                &settings.llm.transforms.presets,
                &settings.llm.transforms.custom_modifiers,
            )
        };
        let presets = transforms_presets(presets_src, customs_src);
        let requires_visible_change = preview_requires_visible_change(&presets);
        let sys = preview_system_prompt(&settings, &presets);
        let user = preview_user_prompt(&feature, &presets, &text);
        (
            sys,
            user,
            to_llm_effort(base.thinking_effort),
            base.model.clone(),
            base.provider,
            base.openrouter_model.clone(),
            base.openrouter_fallback_model.clone(),
            openrouter_options(base),
            requires_visible_change,
        )
    };

    let mgr = llm_manager.inner().clone();
    let preview_model = match provider {
        LlmProvider::Openrouter => openrouter_model.as_str(),
        LlmProvider::AppleIntelligence | LlmProvider::Ollama => model.as_str(),
    }
    .to_string();
    let started = Instant::now();

    // Route the preview over the resolved provider (no selection/paste). Unlike
    // runtime dictation, the playground rejects provider failures so a broken
    // model call cannot masquerade as an intentional no-op.
    let out = tokio::time::timeout(PLAYGROUND_PREVIEW_TIMEOUT, async {
        match provider {
            LlmProvider::AppleIntelligence => Ok(text.clone()),
            LlmProvider::Openrouter => {
                let api_key = settings.llm.openrouter_api_key.clone();
                let request_id = mgr.next_request_id();
                run_openrouter_preview_with_fallback(
                    &mgr,
                    &api_key,
                    &openrouter_model,
                    &openrouter_fallback,
                    &system_prompt,
                    &user_prompt,
                    &feature,
                    &request_id,
                    openrouter_request_options,
                )
                .await
            }
            LlmProvider::Ollama => {
                let endpoint = settings.llm.endpoint.clone();
                let request_id = mgr.next_request_id();
                if is_transforms_feature(&feature) {
                    mgr.ollama_transform(
                        &endpoint,
                        &model,
                        &system_prompt,
                        &user_prompt,
                        &text,
                        effort,
                        &request_id,
                    )
                    .await
                } else {
                    mgr.ollama_dictation(
                        &endpoint,
                        &model,
                        &system_prompt,
                        &user_prompt,
                        &text,
                        effort,
                        &request_id,
                    )
                    .await
                }
            }
        }
    })
    .await
    .map_err(|_| preview_timeout_error(provider, &preview_model))??;
    let final_out = finalize_preview_answer(&settings, &out);
    log::info!(
        "[llm-preview] feature={feature} provider={} model='{}' active_modifier={} input_chars={} output_chars={} unchanged={} elapsed_ms={}",
        provider_label(provider),
        if preview_model.trim().is_empty() {
            "auto"
        } else {
            preview_model.trim()
        },
        requires_visible_change,
        text.chars().count(),
        final_out.chars().count(),
        text.trim() == final_out.trim(),
        started.elapsed().as_millis()
    );
    ensure_preview_changed_if_required(
        requires_visible_change,
        &text,
        &final_out,
        provider,
        &preview_model,
    )?;
    Ok(final_out)
}

fn saved_model(settings: &WinsttSettings, is_dictation: bool) -> String {
    if is_dictation {
        settings.llm.dictation.base.model.clone()
    } else {
        settings.llm.transforms.base.model.clone()
    }
}

/// Map the Playground's provider string to the `LlmProvider` enum, falling back
/// to the feature's saved provider on an unknown/empty value (matches Zod's
/// kebab-case spellings: `ollama` / `openrouter` / `apple-intelligence`).
fn parse_provider(s: &str, settings: &WinsttSettings, is_dictation: bool) -> LlmProvider {
    match s {
        "ollama" => LlmProvider::Ollama,
        "openrouter" => LlmProvider::Openrouter,
        "apple-intelligence" => LlmProvider::AppleIntelligence,
        _ => {
            if is_dictation {
                settings.llm.dictation.base.provider
            } else {
                settings.llm.transforms.base.provider
            }
        }
    }
}

fn parse_effort(s: &str) -> LlmEffort {
    match s {
        "off" => LlmEffort::Off,
        "low" => LlmEffort::Low,
        "high" => LlmEffort::High,
        _ => LlmEffort::Medium,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::winstt::settings_schema::DictionaryEntry;

    #[test]
    fn source_strings_match_renderer() {
        assert_eq!(TransformSource::Uia.as_str(), "uia");
        assert_eq!(TransformSource::Clipboard.as_str(), "clipboard");
        assert_eq!(TransformSource::Empty.as_str(), "empty");
    }

    #[test]
    fn empty_result_is_empty_source() {
        let r = TransformApplyResult::empty();
        assert!(r.before.is_empty());
        assert!(r.after.is_empty());
        assert_eq!(r.source, TransformSource::Empty);
    }

    fn transform_capture(scope: TransformCaptureScope, text: &str) -> TransformCapture {
        TransformCapture {
            scope,
            source: TransformSource::Uia,
            text: text.to_string(),
        }
    }

    fn paste_snapshot(focused_text: &str, selected_text: Option<&str>) -> WindowContextSnapshot {
        WindowContextSnapshot {
            focused_text: focused_text.to_string(),
            selected_text: selected_text.map(str::to_string),
            ..Default::default()
        }
    }

    #[test]
    fn focused_field_capture_replaces_whole_field() {
        let capture = transform_capture(TransformCaptureScope::FocusedField, "old field");
        assert_eq!(
            plan_transform_paste(&capture, "new field", None),
            TransformPastePlan::ReplaceFocusedField("new field".into())
        );
    }

    #[test]
    fn active_original_selection_keeps_normal_replace_paste() {
        let capture = transform_capture(TransformCaptureScope::Selection, "selected text");
        let snapshot = paste_snapshot("before selected text after", Some("selected text"));
        assert_eq!(
            plan_transform_paste(&capture, "replacement", Some(&snapshot)),
            TransformPastePlan::ReplaceSelection("replacement".into())
        );
    }

    #[test]
    fn lost_selection_reconstructs_focused_field_when_source_is_unique() {
        let capture = transform_capture(TransformCaptureScope::Selection, "selected text");
        let snapshot = paste_snapshot("before selected text after", None);
        assert_eq!(
            plan_transform_paste(&capture, "replacement", Some(&snapshot)),
            TransformPastePlan::ReplaceFocusedField("before replacement after".into())
        );
    }

    #[test]
    fn lost_selection_replaces_whole_field_when_field_equals_source() {
        let capture = transform_capture(TransformCaptureScope::Selection, "selected text");
        let snapshot = paste_snapshot("selected text", None);
        assert_eq!(
            plan_transform_paste(&capture, "replacement", Some(&snapshot)),
            TransformPastePlan::ReplaceFocusedField("replacement".into())
        );
    }

    #[test]
    fn lost_selection_does_not_guess_when_source_repeats() {
        let capture = transform_capture(TransformCaptureScope::Selection, "same");
        let snapshot = paste_snapshot("same and same", None);
        assert_eq!(
            plan_transform_paste(&capture, "replacement", Some(&snapshot)),
            TransformPastePlan::ReplaceSelection("replacement".into())
        );
    }

    #[test]
    fn parse_effort_maps_levels() {
        assert!(matches!(parse_effort("off"), LlmEffort::Off));
        assert!(matches!(parse_effort("low"), LlmEffort::Low));
        assert!(matches!(parse_effort("high"), LlmEffort::High));
        assert!(matches!(parse_effort("medium"), LlmEffort::Medium));
        assert!(matches!(parse_effort("garbage"), LlmEffort::Medium));
    }

    fn enabled_settings(provider: LlmProvider, model: &str, key: &str) -> WinsttSettings {
        let mut s = WinsttSettings::default();
        s.llm.transforms.enabled = true;
        s.llm.transforms.base.provider = provider;
        s.llm.transforms.base.model = model.to_string();
        s.llm.openrouter_api_key = key.to_string();
        s
    }

    #[test]
    fn gate_requires_enabled() {
        let mut s = enabled_settings(LlmProvider::Ollama, "llama3", "");
        s.llm.transforms.enabled = false;
        assert!(!is_transforms_enabled(&s));
    }

    #[test]
    fn gate_ollama_requires_model() {
        assert!(is_transforms_enabled(&enabled_settings(
            LlmProvider::Ollama,
            "llama3",
            ""
        )));
        assert!(!is_transforms_enabled(&enabled_settings(
            LlmProvider::Ollama,
            "",
            ""
        )));
    }

    #[test]
    fn gate_openrouter_requires_key() {
        assert!(is_transforms_enabled(&enabled_settings(
            LlmProvider::Openrouter,
            "",
            "sk-or-xxx"
        )));
        assert!(!is_transforms_enabled(&enabled_settings(
            LlmProvider::Openrouter,
            "",
            "   "
        )));
    }

    #[test]
    fn gate_apple_intelligence_requires_model() {
        assert!(is_transforms_enabled(&enabled_settings(
            LlmProvider::AppleIntelligence,
            "apple",
            ""
        )));
        assert!(!is_transforms_enabled(&enabled_settings(
            LlmProvider::AppleIntelligence,
            "",
            ""
        )));
    }

    #[test]
    fn parse_provider_maps_kebab_case() {
        let s = WinsttSettings::default();
        assert!(matches!(
            parse_provider("ollama", &s, false),
            LlmProvider::Ollama
        ));
        assert!(matches!(
            parse_provider("openrouter", &s, false),
            LlmProvider::Openrouter
        ));
        assert!(matches!(
            parse_provider("apple-intelligence", &s, false),
            LlmProvider::AppleIntelligence
        ));
        // Unknown → saved transforms provider (default Ollama).
        assert!(matches!(parse_provider("", &s, false), LlmProvider::Ollama));
    }

    #[test]
    fn preview_system_prompt_uses_dictation_post_processing_layers() {
        let settings = WinsttSettings::default();
        let presets = transforms_presets(&settings.llm.dictation.presets, &[]);
        let prompt = preview_system_prompt(&settings, &presets);

        assert!(prompt.contains("How to interpret the dictation:"));
        assert!(prompt.contains("Output only the transformed text"));
        assert!(!prompt.contains("Non-neutral tone/modifier instructions are active"));
    }

    #[test]
    fn preview_system_prompt_marks_active_modifiers() {
        let settings = WinsttSettings::default();
        let presets = vec![LlmPresetEntry::Builtin {
            key: LlmPresetKey::Formal,
            level: None,
            target_lang: None,
        }];
        let prompt = preview_system_prompt(&settings, &presets);

        assert!(preview_requires_visible_change(&presets));
        assert!(prompt.contains("Non-neutral tone/modifier instructions are active"));
    }

    #[test]
    fn preview_user_prompt_uses_feature_specific_wording() {
        let plain_presets = vec![LlmPresetEntry::Builtin {
            key: LlmPresetKey::Neutral,
            level: None,
            target_lang: None,
        }];
        let dictation = preview_user_prompt("dictation", &plain_presets, "hello");
        assert!(dictation.contains("Text to transform:\nhello"));
        assert!(dictation.contains("style guide above"));

        let transforms = preview_user_prompt("transforms", &plain_presets, "hello");
        assert!(transforms.contains("Text:\nhello"));
        assert!(transforms.contains("Apply the system instructions above"));

        let translate_presets = vec![LlmPresetEntry::Builtin {
            key: LlmPresetKey::Translate,
            level: None,
            target_lang: Some("Arabic".to_string()),
        }];
        let translation = preview_user_prompt("dictation", &translate_presets, "hello");
        assert!(translation.contains("translate the following text into Arabic"));
        assert!(translation.contains("Text to translate:\nhello"));
    }

    #[test]
    fn unchanged_preview_is_error_when_modifier_active() {
        let err = ensure_preview_changed_if_required(
            true,
            "make this better",
            "make this better",
            LlmProvider::Ollama,
            "gemma4:12b",
        )
        .unwrap_err();

        assert!(err.contains("returned the input unchanged"));
        assert!(err.contains("provider=ollama"));
    }

    #[test]
    fn unchanged_preview_is_allowed_for_neutral_cleanup() {
        assert!(ensure_preview_changed_if_required(
            false,
            "Already clean.",
            "Already clean.",
            LlmProvider::Ollama,
            "gemma4:12b",
        )
        .is_ok());
    }

    #[test]
    fn finalize_preview_answer_applies_replacement_pairs() {
        let mut settings = WinsttSettings::default();
        settings.dictionary.push(DictionaryEntry {
            id: "github".to_string(),
            term: "github".to_string(),
            replacement: Some("GitHub".to_string()),
        });

        assert_eq!(
            finalize_preview_answer(&settings, "push it to github"),
            "push it to GitHub"
        );
    }
}
