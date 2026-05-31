// PORT IMPL. Source (authoritative):
// frontend/electron/ipc/transforms.ts + frontend/electron/ipc/transform-hotkeys.ts
// + frontend/electron/lib/selection-capture.ts
// + frontend/electron/ipc/llm.ts (runProcessText provider routing).
//
// The Transforms apply/preview pipeline + its renderer feedback events. WU-13
// owns the `transforms:applied` / `transforms:failed` PLAIN events (matching
// WinSTT's Electron IPC shape byte-for-byte so the reused
// `features/transform-notifications` TransformToast listener works unchanged):
//   • `transforms:applied` → { before, after, source }
//   • `transforms:failed`  → { reason }
//
// The adapter (electron-tauri-adapter.ts) routes:
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

use crate::winstt::context::{ContextMode, ContextReader};
use crate::winstt::llm::{
    self, build_system_prompt, merge_presets_with_custom_modifiers, transforms_user_prompt,
    PresetEntry as LlmPresetEntry, PresetKey as LlmPresetKey, PresetLevel as LlmPresetLevel,
    ThinkingEffort as LlmEffort,
};
use crate::winstt::managers::{ContextManager, LlmManager};
use crate::winstt::settings_schema::{
    CustomModifier as SettingsCustomModifier, LlmProvider, PresetEntry as SettingsPreset,
    PresetKey as SettingsPresetKey, PresetLevel as SettingsLevel, ThinkingEffort as SettingsEffort,
    WinsttSettings,
};

use super::settings::read_settings;

// ── event channel names (BYTE-IDENTICAL to WinSTT's IPC strings) ───────────────

const EVT_APPLIED: &str = "transforms:applied";
const EVT_FAILED: &str = "transforms:failed";

// ── clipboard-sandwich tuning (mirrors selection-capture.ts constants) ─────────

/// How long we wait for the clipboard to update after the synthetic Ctrl+C.
const CLIPBOARD_POLL_TIMEOUT_MS: u64 = 700;
/// Polling interval — fast enough to feel instant, slow enough not to spin.
const CLIPBOARD_POLL_INTERVAL_MS: u64 = 25;

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
            let fallback = settings.llm.transforms.base.openrouter_fallback_model.clone();
            let user_prompt = transforms_user_prompt(text);
            // OpenRouter's structured-output path already returns the fallback
            // text on a total failure (never throws across the boundary), so the
            // pipeline can paste-replace with the original on a dead provider.
            Ok(run_openrouter_with_fallback(
                mgr,
                &api_key,
                &selection,
                &fallback,
                system_prompt,
                &user_prompt,
                text,
            )
            .await)
        }
        LlmProvider::Ollama => {
            let endpoint = settings.llm.endpoint.clone();
            let request_id = mgr.next_request_id();
            mgr.ollama_transform(&endpoint, model, system_prompt, text, effort, &request_id)
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
) -> String {
    match mgr
        .openrouter_chat(api_key, primary, system_prompt, user_prompt, text)
        .await
    {
        Ok(answer) => answer,
        Err(_primary_err) if !fallback.is_empty() => mgr
            .openrouter_chat(api_key, fallback, system_prompt, user_prompt, text)
            .await
            .unwrap_or_else(|_| text.to_string()),
        Err(_) => text.to_string(),
    }
}

// ── selection capture (UIA + clipboard-sandwich fallback) ──────────────────────

/// Capture the user's current selection. UIA (`--selection` via the context
/// sidecar) is the primary path; the clipboard-sandwich is the fallback. Returns
/// `(text, source)`; an empty capture yields `("", Empty)`. Mirrors
/// `captureSelection` in selection-capture.ts.
fn capture_selection(context: &ContextManager, app: &AppHandle) -> (String, TransformSource) {
    // 1. UIA selection (side-effect-free) via the context sidecar. Mirrors
    //    tryUiaSelection: the sidecar's `--selection` mode reports the live
    //    TextPattern selection in `selected_text`, falling back to `focused_text`
    //    when the control only exposes the focused value.
    if context.is_available() {
        let snap = ContextReader::read(context, ContextMode::Selection);
        let selected = snap
            .selected_text
            .clone()
            .or_else(|| {
                if snap.focused_text.trim().is_empty() {
                    None
                } else {
                    Some(snap.focused_text.clone())
                }
            })
            .unwrap_or_default();
        if !selected.trim().is_empty() {
            return (selected, TransformSource::Uia);
        }
    }

    // 2. Clipboard-sandwich fallback (mirrors captureViaClipboard): save the
    //    current clipboard, simulate Ctrl+C, poll for the clipboard to change,
    //    then restore the original clipboard. UIA fails silently in Chromium-
    //    based renderers (Slack, Discord, VS Code) and most Electron apps unless
    //    accessibility is force-enabled — this trick covers those.
    capture_via_clipboard(app)
}

fn capture_via_clipboard(app: &AppHandle) -> (String, TransformSource) {
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
        return (String::new(), TransformSource::Empty);
    }

    // Restore the user's original clipboard immediately. The paste-back
    // (crate::clipboard::paste) runs its OWN clipboard sandwich, so the captured
    // selection never has to live on the clipboard past this point — the user's
    // clipboard is left exactly as it was before the transform.
    restore_clipboard(app, &original);
    (captured, TransformSource::Clipboard)
}

/// Send a synthetic Ctrl+C (Cmd+C on macOS) through the managed Enigo instance so
/// the focused app copies its current selection. Uses platform virtual key codes
/// (layout-independent) to mirror the native `winstt-paste.exe --copy` helper.
fn send_copy_keystroke(app: &AppHandle) -> Result<(), String> {
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
/// the uIOhook listener in the Electron build).
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
    let context_state = app.try_state::<Arc<ContextManager>>();
    let (selected, source) = match context_state {
        Some(ctx) => {
            let ctx = ctx.inner().clone();
            let app_for_capture = app.clone();
            match tauri::async_runtime::spawn_blocking(move || {
                capture_selection(ctx.as_ref(), &app_for_capture)
            })
            .await
            {
                Ok(pair) => pair,
                Err(_) => (String::new(), TransformSource::Empty),
            }
        }
        None => (String::new(), TransformSource::Empty),
    };

    if selected.trim().is_empty() {
        // No-selection: WinSTT broadcasts `transforms:failed { "No text selected" }`
        // AND returns an `ApplyResult` with empty before/after.
        emit_failed(app, "No text selected");
        return TransformApplyResult {
            before: String::new(),
            after: String::new(),
            source,
        };
    }

    // Compose the transforms system prompt (presets + enabled custom modifiers).
    let presets = transforms_presets(
        &settings.llm.transforms.presets,
        &settings.llm.transforms.custom_modifiers,
    );
    let system_prompt = build_system_prompt(&presets);
    let effort = to_llm_effort(settings.llm.transforms.base.thinking_effort);
    let model = settings.llm.transforms.base.model.clone();

    // Run the LLM over the CONFIGURED provider. On a hard error, emit failure +
    // return the original-as-before so the toast surfaces the message (mirrors
    // `runLlm`'s catch → broadcast `transforms:failed` → rethrow).
    let transformed = match run_transform_provider(
        &mgr,
        &settings,
        &system_prompt,
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
                source,
            };
        }
    };

    // Paste replaces the still-highlighted selection (clipboard + Ctrl+V). The
    // paste runs its own clipboard sandwich, so the user's clipboard is restored.
    let _ = crate::clipboard::paste(transformed.clone(), app.clone());

    let result = TransformApplyResult {
        before: selected,
        after: transformed,
        source,
    };
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
/// the electron-main `FeatureLlmConfig`). Connection values (endpoint, key) are
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
    let (system_prompt, effort, model, provider, openrouter_model, openrouter_fallback) =
        if let Some(cfg) = config {
            let presets = transforms_presets(&cfg.presets, &cfg.custom_modifiers);
            let sys = build_system_prompt(&presets);
            let eff = parse_effort(&cfg.thinking_effort);
            let model = if cfg.model.trim().is_empty() {
                saved_model(&settings, is_dictation)
            } else {
                cfg.model.clone()
            };
            (
                sys,
                eff,
                model,
                parse_provider(&cfg.provider, &settings, is_dictation),
                cfg.openrouter_model.clone(),
                cfg.openrouter_fallback_model.clone(),
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
            let sys = build_system_prompt(&presets);
            (
                sys,
                to_llm_effort(base.thinking_effort),
                base.model.clone(),
                base.provider,
                base.openrouter_model.clone(),
                base.openrouter_fallback_model.clone(),
            )
        };

    let mgr = llm_manager.inner().clone();

    // Route the preview over the resolved provider (no selection/paste). On any
    // failure, fall back to the original input text so the Playground never errors.
    let out = match provider {
        LlmProvider::AppleIntelligence => text.clone(),
        LlmProvider::Openrouter => {
            let api_key = settings.llm.openrouter_api_key.clone();
            let user_prompt = transforms_user_prompt(&text);
            run_openrouter_with_fallback(
                &mgr,
                &api_key,
                &openrouter_model,
                &openrouter_fallback,
                &system_prompt,
                &user_prompt,
                &text,
            )
            .await
        }
        LlmProvider::Ollama => {
            let endpoint = settings.llm.endpoint.clone();
            let request_id = mgr.next_request_id();
            mgr.ollama_transform(&endpoint, &model, &system_prompt, &text, effort, &request_id)
                .await
                .unwrap_or_else(|_| text.clone())
        }
    };
    Ok(out)
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
        assert!(matches!(
            parse_provider("", &s, false),
            LlmProvider::Ollama
        ));
    }
}
