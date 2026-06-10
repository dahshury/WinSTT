// Reference (authoritative):
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
//
// MODULE LAYOUT: the implementation is split across sibling submodules under
// `transforms/`:
//   • `capture`  — selection capture (UIA + clipboard-sandwich) + paste planning
//   • `provider` — provider routing / fan-out (OpenRouter fallback, Ollama)
//   • `convert`  — pure Settings→LLM type/effort/options conversions
// This root keeps the public command surface (the two `#[tauri::command]`s),
// `run_transform_pipeline`, the preview prompt/gate helpers, emit/history helpers,
// and the `TransformProcessingGuard`.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::managers::history::HistoryManager;
use crate::winstt::context::{ContextMode, ContextReader};
use crate::winstt::llm::{
    self, build_dictation_system_prompt, build_system_prompt, PresetEntry as LlmPresetEntry,
    PresetKey as LlmPresetKey,
};
use crate::winstt::managers::{ContextManager, LlmManager};
use crate::winstt::settings_schema::{
    CustomModifier as SettingsCustomModifier, LlmProvider, PresetEntry as SettingsPreset,
    WinsttSettings,
};

use super::llm as llm_commands;
use super::settings::read_settings;

mod capture;
mod convert;
mod provider;

use capture::{capture_selection, plan_transform_paste, TransformCapture, TransformPastePlan};
use convert::{
    openrouter_options, openrouter_options_from_preview, parse_effort, parse_provider, saved_model,
    to_llm_effort, transforms_presets,
};
use provider::{run_openrouter_preview_with_fallback, run_transform_provider};

// `capture_selection_text` is the TTS read-aloud hotkey's entry point; keep its
// crate path (`crate::winstt::commands::transforms::capture_selection_text`)
// stable for actions.rs.
pub use capture::capture_selection_text;

// ── event channel names (BYTE-IDENTICAL to WinSTT's IPC strings) ───────────────

const EVT_APPLIED: &str = "transforms:applied";
const EVT_FAILED: &str = "transforms:failed";
const EVT_PROCESSING_START: &str = "transforms:processing-start";
const EVT_PROCESSING_END: &str = "transforms:processing-end";

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

fn normalize_llm_text_output(text: &str) -> String {
    text.lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
}
fn finalize_preview_answer(settings: &WinsttSettings, answer: &str) -> String {
    let pairs = llm_commands::replacement_pairs(settings);
    llm::apply_replacement_pairs(&normalize_llm_text_output(answer), &pairs)
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
        after: normalize_llm_text_output(&transformed),
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
                        false,
                        &request_id,
                    )
                    .await
                    .map(|out| out.text)
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
    fn preview_system_prompt_uses_dictation_post_processing_layers() {
        let settings = WinsttSettings::default();
        let presets = transforms_presets(&settings.llm.dictation.presets, &[]);
        let prompt = preview_system_prompt(&settings, &presets);

        assert!(prompt.contains("How to interpret the dictation:"));
        assert!(prompt.contains("Output only the transformed text"));
        assert!(prompt.contains("Non-neutral tone/modifier instructions are active"));
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
        use crate::winstt::settings_schema::DictionaryEntry;
        let mut settings = WinsttSettings::default();
        settings.dictionary.push(DictionaryEntry {
            id: "github".to_string(),
            term: "github".to_string(),
            auto_added: None,
            replacement: Some("GitHub".to_string()),
        });

        assert_eq!(
            finalize_preview_answer(&settings, "push it to github"),
            "push it to GitHub"
        );
    }
}
