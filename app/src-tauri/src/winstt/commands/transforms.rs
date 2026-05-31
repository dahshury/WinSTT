// PORT IMPL — drafted against real APIs, pending compile. Source (authoritative):
// frontend/electron/ipc/transforms.ts + frontend/electron/ipc/transform-hotkeys.ts
// + src/shared/api/ipc-client.ts (applyTransform / runLlmPreview / onTransformApplied /
//   onTransformFailed) + app/PORT/10_frontend_port_plan.md §6 WU-13 + lib_wiring.md §3/§4b/§5.
//
// The Transforms apply/preview pipeline + its renderer feedback events. WU-13 owns
// the `transforms:applied` / `transforms:failed` PLAIN events (matching WinSTT's
// Electron IPC shape byte-for-byte so the reused `features/transform-notifications`
// TransformToast listener works unchanged):
//   • `transforms:applied` → { before, after, source }
//   • `transforms:failed`  → { reason }
//
// The adapter (electron-tauri-adapter.ts) routes:
//   IPC.TRANSFORMS_APPLY   → command `apply_transform`           (no args; selection + paste internal)
//   IPC.TRANSFORMS_PREVIEW → command `apply_transform_preview`   ({ text, feature, config })
//   IPC.TRANSFORMS_APPLIED → event   `transforms:applied`
//   IPC.TRANSFORMS_FAILED  → event   `transforms:failed`
//
// `apply_transform` is the end-to-end runtime path the hotkey (`TransformAction`,
// lib_wiring §5) ALSO calls: capture selection → run composed transforms prompt
// (presets + custom modifiers) over the configured provider → paste-replace →
// emit `transforms:applied`. On any failure it emits `transforms:failed` and
// returns the empty result so the renderer toast surfaces the error.
//
// SPIKE SEAMS (consistent with the rest of the draft layer):
//   - selection capture: WinSTT uses UIA `--selection` (winstt-context sidecar)
//     with a clipboard sandwich fallback. The Rust capture below tries the
//     ContextManager sidecar (Selection mode) first, then falls back to the
//     current clipboard text. Wire the clipboard-sandwich (Ctrl+C + read + restore)
//     in the compile loop if richer capture is needed.
//   - paste-back: reuses Handy's `crate::clipboard::paste` (clipboard + Ctrl+V),
//     which overwrites the still-highlighted selection — identical to WinSTT's
//     `pasteText` over a live selection.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, State};

use crate::winstt::llm::{
    self, build_system_prompt, merge_presets_with_custom_modifiers, PresetEntry as LlmPresetEntry,
    PresetKey as LlmPresetKey, PresetLevel as LlmPresetLevel, ThinkingEffort as LlmEffort,
};
use crate::winstt::context::{ContextMode, ContextReader};
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
fn transforms_presets(presets: &[SettingsPreset], customs: &[SettingsCustomModifier]) -> Vec<LlmPresetEntry> {
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

// ── selection capture (SPIKE seam) ─────────────────────────────────────────────

/// Capture the user's current selection. UIA (`--selection` via the context
/// sidecar) is the primary path; the clipboard is the fallback. Returns
/// `(text, source)`; an empty capture yields `("", Empty)`. Mirrors
/// `captureSelection` in selection-capture.ts.
///
/// SPIKE: WinSTT's full `captureSelection` runs a clipboard-sandwich (Ctrl+C +
/// read + restore) when UIA is empty. Wire that here in the compile loop if the
/// bare-clipboard fallback proves too coarse; the event/result contract above
/// is unaffected.
fn capture_selection(context: &ContextManager, app: &AppHandle) -> (String, TransformSource) {
    // 1. UIA selection (side-effect-free) via the context sidecar.
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
    // 2. Clipboard fallback — best-effort read of whatever the user last copied.
    match read_clipboard(app) {
        Some(text) if !text.trim().is_empty() => (text, TransformSource::Clipboard),
        _ => (String::new(), TransformSource::Empty),
    }
}

fn read_clipboard(app: &AppHandle) -> Option<String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().read_text().ok()
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

// ── commands ───────────────────────────────────────────────────────────────────

/// `apply_transform` — end-to-end Transforms pipeline (renderer `applyTransform()`
/// + the `TransformAction` hotkey path). Capture selection → run the composed
/// presets+modifiers prompt → paste-replace → emit `transforms:applied`.
///
/// On a disabled feature, no selection, or an LLM failure, emits
/// `transforms:failed` (or an empty `transforms:applied` for the no-selection
/// hint the toast renders as "No text selected") and returns the empty result.
/// NEVER throws past this layer — the renderer's `invokeOrDefault` would mask it
/// and the toast would never fire.
#[tauri::command]
#[specta::specta]
pub async fn apply_transform(
    app: AppHandle,
    llm_manager: State<'_, Arc<LlmManager>>,
    context: State<'_, Arc<ContextManager>>,
) -> Result<TransformApplyResult, String> {
    let settings = read_settings(&app);

    // Gate: feature disabled / no model → emit failure, return empty (mirrors
    // `requireEnabled` → broadcast `transforms:failed`).
    if !is_transforms_enabled(&settings) {
        emit_failed(&app, "LLM text transformation is disabled");
        return Ok(TransformApplyResult::empty());
    }

    // Capture the current selection.
    let (selected, source) = capture_selection(context.inner().as_ref(), &app);
    if selected.trim().is_empty() {
        // No-selection: WinSTT broadcasts `transforms:failed { "No text selected" }`
        // AND returns an `ApplyResult` with empty before/after. The toast treats
        // an empty `transforms:applied` as "no-selection" too, but the byte-exact
        // WinSTT shape emits FAILED here, so mirror that.
        emit_failed(&app, "No text selected");
        return Ok(TransformApplyResult {
            before: String::new(),
            after: String::new(),
            source,
        });
    }

    // Compose the transforms system prompt (presets + enabled custom modifiers).
    let presets = transforms_presets(
        &settings.llm.transforms.presets,
        &settings.llm.transforms.custom_modifiers,
    );
    let system_prompt = build_system_prompt(&presets);
    let effort = to_llm_effort(settings.llm.transforms.base.thinking_effort);

    let mgr = llm_manager.inner().clone();
    let request_id = mgr.next_request_id();
    let endpoint = settings.llm.endpoint.clone();
    let model = settings.llm.transforms.base.model.clone();

    // Run the LLM. On a hard error, emit failure + return empty (mirrors `runLlm`'s
    // catch → broadcast `transforms:failed` → rethrow, surfaced as the toast).
    let transformed = match mgr
        .ollama_transform(&endpoint, &model, &system_prompt, &selected, effort, &request_id)
        .await
    {
        Ok(out) => out,
        Err(reason) => {
            emit_failed(&app, &reason);
            return Ok(TransformApplyResult {
                before: selected,
                after: String::new(),
                source,
            });
        }
    };

    // Paste replaces the still-highlighted selection (clipboard + Ctrl+V).
    let _ = crate::clipboard::paste(transformed.clone(), app.clone());

    let result = TransformApplyResult {
        before: selected,
        after: transformed,
        source,
    };
    emit_applied(&app, &result);
    Ok(result)
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
/// an explicit `config` overrides the feature's saved presets/modifiers/model.
/// Mirrors `handlePreview` → `processText(text, "", feature, config)`.
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

    // Resolve system-prompt / model / effort — config override first, else the
    // feature's saved settings.
    let (system_prompt, effort, model) = if let Some(cfg) = config {
        let presets = transforms_presets(&cfg.presets, &cfg.custom_modifiers);
        let sys = build_system_prompt(&presets);
        let effort = parse_effort(&cfg.thinking_effort);
        let model = if cfg.model.trim().is_empty() {
            saved_model(&settings, is_dictation)
        } else {
            cfg.model.clone()
        };
        (sys, effort, model)
    } else {
        let (presets_src, customs_src, base_effort, model) = if is_dictation {
            (
                &settings.llm.dictation.presets,
                &settings.llm.dictation.custom_modifiers,
                settings.llm.dictation.base.thinking_effort,
                settings.llm.dictation.base.model.clone(),
            )
        } else {
            (
                &settings.llm.transforms.presets,
                &settings.llm.transforms.custom_modifiers,
                settings.llm.transforms.base.thinking_effort,
                settings.llm.transforms.base.model.clone(),
            )
        };
        let presets = transforms_presets(presets_src, customs_src);
        let sys = build_system_prompt(&presets);
        (sys, to_llm_effort(base_effort), model)
    };

    let mgr = llm_manager.inner().clone();
    let request_id = mgr.next_request_id();
    let endpoint = settings.llm.endpoint.clone();

    // The preview always exercises the transform-on-text path (no selection/paste).
    let out = mgr
        .ollama_transform(&endpoint, &model, &system_prompt, &text, effort, &request_id)
        .await
        .unwrap_or_else(|_| text.clone());
    Ok(out)
}

fn saved_model(settings: &WinsttSettings, is_dictation: bool) -> String {
    if is_dictation {
        settings.llm.dictation.base.model.clone()
    } else {
        settings.llm.transforms.base.model.clone()
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
}
