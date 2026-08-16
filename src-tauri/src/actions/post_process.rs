use crate::winstt::context::{ContextMode, WindowContextSnapshot};
use crate::winstt::llm::DictationSideEffects;
use crate::winstt::managers::{ContextManager, LlmManager};
use crate::winstt::settings_schema::{LlmProvider, RecordingMode, WinsttSettings};
use ferrous_opencc::{OpenCC, config::BuiltinConfig};
use log::{debug, error, warn};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri::Manager;

/// The dictation session currently offering the "skip post-processing" action.
/// A session id (rather than a boolean) prevents a late Alt+S release/click from
/// leaking into the next dictation.
static ACTIVE_POST_PROCESSING_SESSION: AtomicU64 = AtomicU64::new(0);
static SKIP_POST_PROCESSING_SESSION: AtomicU64 = AtomicU64::new(0);

/// Wakes the dictation post-processing watcher the instant an escape hatch
/// fires (Alt+S skip, Esc/X session cancel) — a callback, not a poll. The
/// atomics above stay the source of truth; this only says "re-check them now".
/// `notify_one` stores a permit when no watcher is registered yet, so a wake
/// that lands before (or between) the watcher's awaits is never lost — a stale
/// permit from a prior session costs one spurious flag re-check, nothing more.
static POST_PROCESSING_ESCAPE: std::sync::LazyLock<tokio::sync::Notify> =
    std::sync::LazyLock::new(tokio::sync::Notify::new);

/// Foreground-restoration completion for the overlay-click skip path. Alt+S
/// never populates this slot because it does not move focus. The session id
/// prevents a late window callback from delaying a later dictation.
static POST_PROCESSING_FOCUS_RESTORE: std::sync::LazyLock<
    std::sync::Mutex<
        Option<(
            u64,
            crate::winstt::commands::preview::ForegroundRestoreCompletion,
        )>,
    >,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(None));

/// Wake the post-processing watcher to re-check its escape flags. Called by
/// every path that can make them true while an LLM cleanup is in flight.
pub(crate) fn notify_post_processing_escape() {
    POST_PROCESSING_ESCAPE.notify_one();
}

fn begin_post_processing_skip_window(session_id: u64) {
    *POST_PROCESSING_FOCUS_RESTORE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    SKIP_POST_PROCESSING_SESSION.store(0, Ordering::Release);
    ACTIVE_POST_PROCESSING_SESSION.store(session_id, Ordering::Release);
}

fn finish_post_processing_skip_window(session_id: u64) {
    let _ = ACTIVE_POST_PROCESSING_SESSION.compare_exchange(
        session_id,
        0,
        Ordering::AcqRel,
        Ordering::Acquire,
    );
    let _ = SKIP_POST_PROCESSING_SESSION.compare_exchange(
        session_id,
        0,
        Ordering::AcqRel,
        Ordering::Acquire,
    );
    let mut restore = POST_PROCESSING_FOCUS_RESTORE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if restore
        .as_ref()
        .is_some_and(|(owner, _)| *owner == session_id)
    {
        restore.take();
    }
}

fn post_processing_skip_requested(session_id: u64) -> bool {
    SKIP_POST_PROCESSING_SESSION.load(Ordering::Acquire) == session_id
}

/// Request a raw-transcript finish for the currently active dictation cleanup.
/// Cancelling the LLM manager drops the in-flight network/local generation, but
/// deliberately leaves the transcription coordinator alive so its normal
/// history + paste path can finish with the original STT text.
pub(crate) fn request_post_processing_skip(app: &AppHandle, restore_focus: bool) -> bool {
    let session_id = ACTIVE_POST_PROCESSING_SESSION.load(Ordering::Acquire);
    if session_id == 0 {
        return false;
    }
    SKIP_POST_PROCESSING_SESSION.store(session_id, Ordering::Release);
    if restore_focus && let Some(completion) = super::pinned_foreground::restore_focus() {
        *POST_PROCESSING_FOCUS_RESTORE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some((session_id, completion));
    }
    notify_post_processing_escape();
    if let Some(llm) = app.try_state::<Arc<LlmManager>>() {
        llm.cancel_all();
    }
    debug!("Skipping post-processing for dictation session {session_id}");
    true
}

/// Arms Alt+S only for the LLM cleanup window and guarantees teardown on every
/// return/unwind path.
pub(super) struct PostProcessingSkipGuard {
    app: AppHandle,
    session_id: u64,
}

impl PostProcessingSkipGuard {
    pub(super) fn new(app: &AppHandle, session_id: u64) -> Self {
        begin_post_processing_skip_window(session_id);
        crate::shortcut::register_skip_post_processing_shortcut(app);
        Self {
            app: app.clone(),
            session_id,
        }
    }
}

impl Drop for PostProcessingSkipGuard {
    fn drop(&mut self) {
        finish_post_processing_skip_window(self.session_id);
        crate::shortcut::unregister_skip_post_processing_shortcut(&self.app);
    }
}

/// Telemetry captured while the LLM post-processes a transcription, surfaced in
/// the history footer (model + how long it took + generation speed + cloud
/// cost). `model` is the configured model id (the renderer derives the maker
/// logo from it); the token/cost fields are `None` when the provider didn't
/// report `usage` (local Ollama, Apple Intelligence).
pub(crate) struct PostProcessMeta {
    pub model: String,
    pub duration_ms: i64,
    pub completion_tokens: Option<i64>,
    pub prompt_tokens: Option<i64>,
    pub cost_usd: Option<f64>,
    pub error: Option<String>,
}

fn dictation_llm_model(settings: &WinsttSettings) -> String {
    let base = &settings.llm.dictation.base;
    match base.provider {
        LlmProvider::Openrouter => base.openrouter_model.trim().to_string(),
        LlmProvider::AppleIntelligence => "apple-intelligence".to_string(),
        LlmProvider::Ollama => base.model.trim().to_string(),
    }
}

fn has_winstt_dictation_model(settings: &WinsttSettings) -> bool {
    let base = &settings.llm.dictation.base;
    match base.provider {
        LlmProvider::Openrouter => !settings.llm.openrouter_api_key.trim().is_empty(),
        // FoundationModels is selected by the OS; there is no user model id.
        // The bridge performs the authoritative device/OS availability check.
        LlmProvider::AppleIntelligence => true,
        LlmProvider::Ollama => !base.model.trim().is_empty(),
    }
}

fn dictation_post_processing_enabled(settings: &WinsttSettings) -> bool {
    settings.llm.dictation.enabled && settings.general.recording_mode != RecordingMode::Listen
}

fn should_run_winstt_dictation_llm(settings: &WinsttSettings) -> bool {
    dictation_post_processing_enabled(settings) && has_winstt_dictation_model(settings)
}

pub(super) fn should_run_winstt_dictation_llm_from_app(app: &AppHandle) -> bool {
    let mut settings = crate::winstt::commands::settings::read_settings(app);
    if let Some(profile) = super::app_profile::take_resolved(Duration::ZERO) {
        crate::winstt::app_profiles::apply_profile_to_settings(&mut settings, &profile.config);
    }
    should_run_winstt_dictation_llm(&settings)
}

/// One raw, policy-resolved context snapshot for the pinned dictation window,
/// captured ONCE and reused by every downstream consumer this pass needs (the
/// LLM prompt fragment, the biasing terms, and the deterministic caret join). It
/// carries the resolved [`WindowContextSnapshot`] plus the session's biasing
/// terms (computed from the SAME snapshot) so nothing recaptures.
struct CapturedContext {
    /// The deny/allow-resolved snapshot (caret-aware `Split` of the pinned
    /// window). Metadata-only when the app was denied.
    snapshot: WindowContextSnapshot,
    /// Session-scoped biasing terms extracted from `snapshot` (report R4). Also
    /// protects proper nouns / identifiers from continuation lowercasing.
    terms: Vec<String>,
}

/// Read → deny/allow policy → biasing-term extraction, ONCE per dictation. Runs
/// only when context awareness is on, the manager is available, and the pinned
/// dictation window is still valid (report R5b: never capture the window the
/// user alt-tabbed to during transcription). Returns `None` in every skip case,
/// so callers add nothing to the prompt and the caret join is a no-op.
fn capture_winstt_dictation_context_snapshot(
    app: &AppHandle,
    settings: &WinsttSettings,
) -> Option<CapturedContext> {
    if !settings.general.context_awareness {
        return None;
    }

    let Some(context) = app.try_state::<Arc<ContextManager>>() else {
        debug!("Context awareness is enabled but ContextManager is unavailable");
        return None;
    };

    // Stale-context rejection (report R5b). This capture runs only AFTER the
    // decode finishes, so the foreground may have changed since the user started
    // dictating. `TranscribeAction::start` pinned the foreground HWND at recording
    // start; resolve + re-validate it here. `None` means the pinned window is gone
    // (or its HWND was recycled to another process) — refuse to capture whatever
    // is focused NOW rather than feed the LLM context from the wrong window.
    let Some(hwnd) = super::pinned_foreground::validated_hwnd() else {
        debug!(
            "Context awareness is enabled but the pinned dictation window is no longer valid; skipping capture"
        );
        return None;
    };

    // Focused-field capture (competitor-parity: Wispr Flow / superwhisper read
    // the focused field + caret-nearby text + app identity via accessibility,
    // NOT a whole-window tree dump). `Split` gives caret-aware before/after text
    // of the focused field plus window/app/url metadata — without the `--tree`
    // UIA subtree walk that leaked sidebars/inbox rows and forced the per-app
    // reconstruction machinery. The OTP scrub + deny-list still apply. For a
    // "reply to this" the quoted thread sits in `afterCaret`, so reply context
    // survives within the field. Scoped to the PINNED window (`--hwnd`).
    let raw = context.read_hwnd_with_ocr(
        ContextMode::Split,
        hwnd,
        // Tier-2 OCR fallback (report R3): opt-in, off by default. The sidecar
        // only OCRs when this is set AND the `--split` UIA read found nothing
        // (canvas apps, remote desktops, games) AND the field isn't a password.
        settings.general.context_screen_ocr,
    );
    let snapshot = crate::winstt::context::apply_context_app_policy(
        &raw,
        settings.general.context_app_mode,
        &settings.general.context_deny_list,
        &settings.general.context_allow_list,
    );

    let terms = extract_context_biasing_terms(&snapshot);
    Some(CapturedContext { snapshot, terms })
}

/// Format the already-captured, policy-resolved snapshot into the compact JSON
/// LLM-cleanup prompt fragment. Pure — reuses the single capture, never reads.
fn format_captured_context(captured: &CapturedContext) -> String {
    crate::winstt::context::format_context_for_prompt(&captured.snapshot)
}

/// Session-scoped vocabulary-biasing terms extracted from an ALREADY-resolved
/// Tier-1 context snapshot (proper nouns + code identifiers on/near the focused
/// field). These feed the SAME per-session vocabulary-biasing path the user
/// dictionary uses — the encoder masked-LM corrector — so the dictation snaps
/// toward names the user is looking at (a variable in the editor, a `@handle` in
/// chat). This is report R4's "screen as dictionary" channel (Wispr's variable
/// recognition). The terms are NEVER persisted to the user dictionary and NEVER
/// reach the Whisper/STT prompt (context text there is poisonous). They also
/// protect proper nouns from the deterministic caret-join lowercasing.
///
/// Pure over the snapshot — the read+policy already happened in
/// [`capture_winstt_dictation_context_snapshot`], so this recomputes nothing.
fn extract_context_biasing_terms(resolved: &WindowContextSnapshot) -> Vec<String> {
    // Proximity order: field text / before-caret / selection (closest to the
    // caret) → after-caret → screen (farthest). `extract_context_terms` ranks
    // earlier slices as nearer. Numeric OTP codes can't survive extraction (it
    // keeps only word-shaped tokens), and the policy already redacted denied apps,
    // so no extra scrub is needed here.
    let before = resolved.text_before.as_deref().unwrap_or_default();
    let selection = resolved.selected_text.as_deref().unwrap_or_default();
    let after = resolved.text_after.as_deref().unwrap_or_default();
    let screen = resolved
        .ax_html
        .as_deref()
        .or(resolved.ocr_text.as_deref())
        .unwrap_or_default();
    let texts = [
        resolved.focused_text.as_str(),
        before,
        selection,
        after,
        screen,
    ];
    crate::winstt::context_terms::extract_context_terms(
        &texts,
        crate::winstt::context_terms::DEFAULT_TERM_CAP,
    )
}

/// Deterministic "caret join" post-pass applied to the final dictation text just
/// before it is prepared for insertion — on BOTH the LLM-cleaned path and the
/// raw/no-LLM path. Small local models ground the transcript but ignore two
/// cosmetic boundary rules the prompt asks for; enforce them here (see
/// [`crate::winstt::context::join_for_insertion`] /
/// [`crate::winstt::context::apply_ide_file_tags`]):
///   1. mid-sentence continuation casing (lowercase the first word after a
///      non-terminal `beforeCaret`, protecting proper nouns / `I` / acronyms);
///   2. IDE `@file` tagging (spoken "at &lt;filename&gt;" → "@&lt;filename&gt;"),
///      now WORKSPACE-WIDE: the KNOWN filename set is the captured context terms
///      UNION the real basenames of the pinned IDE window's workspace (resolved
///      from the per-window title + the editor's `workspaceStorage` pool), so a
///      spoken file that is NOT on screen still tags. An unambiguous tag is then
///      upgraded from bare `@name.ext` to a root-relative `@rel/path/name.ext`;
///   3. IDE descriptive-phrase tagging (spoken DESCRIPTION → "@rel/path"), e.g.
///      "the context manager" → "@src-tauri/src/…/context_manager.rs". Runs AFTER
///      2 so an exact-named file is already an `@…` tag and cannot be double-
///      tagged, and biases to ABSTAIN (unique-file gate) since a wrong tag is
///      worse than none.
///
/// Reuses the SINGLE snapshot + terms captured for this dictation — no recapture.
/// A no-op when no snapshot was available (context off / stale window / non-IDE
/// for the tag pass), so raw dictation without a capture is untouched. The whole
/// workspace lookup is fail-soft: root unknown / index empty or truncated /
/// non-Windows → the known set stays `= captured.terms` and no path upgrade runs,
/// i.e. byte-for-byte today's behavior.
fn apply_caret_join(text: &str, captured: &CapturedContext) -> String {
    use crate::winstt::context::workspace_index;

    let snapshot = &captured.snapshot;
    let is_ide = crate::winstt::context::is_ide_context(snapshot);

    // Resolve the pinned IDE window's workspace ROOT + index ONCE (cache reads;
    // None in every skip case). The root is kept (unlike `index_for_pinned`, which
    // discards it) because the descriptive-phrase resolver below needs it to key
    // its own per-root inverted-index cache. The `WorkspaceIndex` widens the
    // known-filename set, upgrades an unambiguous tag to a path, AND is the source
    // the descriptive resolver's `FileRefIndex` is built from — one build, reused.
    let workspace = if is_ide {
        workspace_index::resolve_root(&snapshot.window_title, snapshot.app_exe.as_deref()).map(
            |root| {
                let index = workspace_index::index_for_root(&root);
                (root, index)
            },
        )
    } else {
        None
    };
    // The `WorkspaceIndex` handle (without the root) for the tagging-union / path-
    // upgrade steps, mirroring the old `index_for_pinned` contract: `None` when the
    // root is unknown OR the index is empty (an empty index widens nothing and can
    // resolve no path).
    let workspace_index = workspace
        .as_ref()
        .map(|(_, index)| index.clone())
        .filter(|index| !index.is_empty());

    // Widen the KNOWN set: context terms ∪ the workspace filenames the user
    // ACTUALLY SPOKE (an extension-bearing filename token present in the output
    // that the workspace index contains) — never the whole (up-to-50k) index, so
    // the tagger's per-term full-text scan stays bounded by the utterance. We add
    // the SPOKEN spelling (not the on-disk one) so the case-sensitive tagger
    // actually matches the token in the text; the additive path-upgrade below then
    // rewrites the emitted tag to the index's on-disk canonical spelling / path.
    // Deduped case-insensitively against the existing context terms (which win, as
    // they carry the user's on-screen spelling). No workspace ⇒
    // `known == captured.terms` (byte-for-byte today's behavior).
    let known: Vec<String> = match &workspace_index {
        Some(idx) => {
            let mut known = captured.terms.clone();
            let existing: std::collections::HashSet<String> =
                known.iter().map(|t| t.to_lowercase()).collect();
            for spoken in crate::winstt::context::extract_taggable_filenames(text) {
                if existing.contains(&spoken.to_lowercase()) {
                    continue; // already a context term (user's spelling wins)
                }
                // Only union a spoken token that is a REAL workspace file.
                if idx.canonical_basename(&spoken).is_some() {
                    known.push(spoken);
                }
            }
            known
        }
        None => captured.terms.clone(),
    };

    // @file tagging first (IDE-gated), then the optional path upgrade, then the
    // descriptive-phrase resolver, then the caret join so the sigil is in place
    // before continuation casing looks at the first word.
    let tagged = crate::winstt::context::apply_ide_file_tags(text, is_ide, &known);
    let tagged = match &workspace_index {
        Some(idx) => crate::winstt::context::upgrade_tags_to_paths(&tagged, is_ide, |basename| {
            idx.unique_relpath(basename).map(str::to_string)
        }),
        None => tagged,
    };
    // Descriptive-phrase → workspace-file tagging (SHIPPED). Runs LAST in the tag
    // chain — AFTER the exact spoken-filename tagger and its path upgrade — so a
    // file the user named by its exact `name.ext` is already an `@…/path` tag and
    // its tokens sit inside that `@…` run (the resolver's shared `left_boundary_ok`
    // guard rejects splicing there → never double-tagged). Gated on `is_ide` AND a
    // resolved root with a NON-TRUNCATED, non-empty index: the `FileRefIndex` is
    // built from the SAME `WorkspaceIndex` (one enumeration, its own 60 s/4-root
    // cache), and the resolver itself abstains on truncation/emptiness. Fail-soft
    // to `tagged` unchanged whenever the root is unknown, the index truncated, or
    // no descriptive span resolves to a strictly-unique file — a WRONG tag is worse
    // than none, so the whole pass biases to ABSTAIN.
    let tagged = match &workspace {
        Some((root, index)) if !index.is_truncated() && !index.is_empty() => {
            use crate::winstt::context::file_reference_resolver;
            let ref_index = file_reference_resolver::ref_index_for_root(root, index);
            file_reference_resolver::resolve_descriptive_tags(&tagged, is_ide, &ref_index)
        }
        _ => tagged,
    };
    crate::winstt::context::join_for_insertion(
        &tagged,
        snapshot.text_before.as_deref(),
        snapshot.text_after.as_deref(),
        &captured.terms,
    )
}

/// Returns `(cleaned_text, telemetry, dictionary_fixes)` where `dictionary_fixes`
/// is the count of deterministic replacement-pair substitutions applied by the
/// cleanup pass (persisted for the History "AI Impact" stat).
async fn process_winstt_dictation_llm(
    app: &AppHandle,
    settings: &WinsttSettings,
    transcription: &str,
    context: String,
) -> Option<(String, PostProcessMeta, i64, DictationSideEffects)> {
    let Some(llm_manager) = app.try_state::<Arc<LlmManager>>() else {
        warn!("Dictation LLM is enabled but LlmManager is unavailable");
        return None;
    };

    let model = dictation_llm_model(settings);
    let started = Instant::now();

    match crate::winstt::commands::llm::process_dictation_text(
        app,
        llm_manager.inner().clone(),
        transcription.to_string(),
        context,
        settings,
    )
    .await
    {
        Ok(result) => {
            // Prefer the model the chat actually ran on (the fallback model
            // when the primary failed over) so the footer's cost matches the
            // model chip beside it.
            let model = result
                .llm_usage
                .as_ref()
                .map(|usage| usage.model.clone())
                .filter(|m| !m.trim().is_empty())
                .unwrap_or(model);
            Some((
                result.text,
                PostProcessMeta {
                    model,
                    duration_ms: started.elapsed().as_millis() as i64,
                    completion_tokens: result
                        .llm_usage
                        .as_ref()
                        .and_then(|usage| usage.completion_tokens),
                    prompt_tokens: result
                        .llm_usage
                        .as_ref()
                        .and_then(|usage| usage.prompt_tokens),
                    cost_usd: result.llm_usage.as_ref().and_then(|usage| usage.cost_usd),
                    error: result.failsoft_error.clone(),
                },
                result.dictionary_fixes as i64,
                result.side_effects,
            ))
        }
        Err(err) => {
            error!("Dictation LLM post-processing failed: {}", err);
            None
        }
    }
}

async fn maybe_convert_chinese_variant(
    selected_language: &str,
    transcription: &str,
) -> Option<String> {
    // Check if language is set to Simplified or Traditional Chinese. The language is sourced
    // from WinsttSettings.model.language (the single language store) by the caller — AppSettings
    // .selected_language is no longer written by the WinSTT renderer, so reading it here would
    // mean this zh-variant conversion never fired.
    let is_simplified = selected_language == "zh-Hans";
    let is_traditional = selected_language == "zh-Hant";

    if !is_simplified && !is_traditional {
        debug!("language is not Simplified or Traditional Chinese; skipping translation");
        return None;
    }

    debug!(
        "Starting Chinese translation using OpenCC for language: {}",
        selected_language
    );

    // Use OpenCC to convert based on selected language
    let config = if is_simplified {
        // Convert Traditional Chinese to Simplified Chinese
        BuiltinConfig::Tw2sp
    } else {
        // Convert Simplified Chinese to Traditional Chinese
        BuiltinConfig::S2tw
    };

    match OpenCC::from_config(config) {
        Ok(converter) => {
            let converted = converter.convert(transcription);
            debug!(
                "OpenCC translation completed. Input length: {}, Output length: {}",
                transcription.len(),
                converted.len()
            );
            Some(converted)
        }
        Err(e) => {
            error!(
                "Failed to initialize OpenCC converter: {}. Falling back to original transcription.",
                e
            );
            None
        }
    }
}

fn chinese_variant_language(model: &crate::winstt::settings_schema::ModelSettings) -> Option<&str> {
    if model.auto_detect_language || model.language_candidates.len() > 1 {
        return None;
    }
    model
        .language_candidates
        .first()
        .map(String::as_str)
        .or(Some(model.language.as_str()))
        .filter(|language| *language == "zh-Hans" || *language == "zh-Hant")
}

pub(crate) struct ProcessedTranscription {
    pub final_text: String,
    pub post_processed_text: Option<String>,
    pub post_process_requested: bool,
    /// JSON telemetry of the LLM pass (`{model, processingMs, tokens}`), or
    /// `None` when no LLM ran (raw transcript, Chinese-variant convert, or
    /// snippet-only expansion). Persisted to `transcription_history.llm_meta`
    /// and reshaped into the history footer's model/duration/speed chips.
    pub llm_meta: Option<String>,
    /// Number of dictionary replacement-pair substitutions the dictation
    /// cleanup applied. `None` when no cleanup pass ran (so legacy/raw entries
    /// stay NULL rather than a misleading 0); persisted to
    /// `transcription_history.dictionary_fixes` for the "AI Impact" stat.
    pub dictionary_fixes: Option<i64>,
    /// Fixed LLM-classified history category, when available.
    pub history_tag: Option<String>,
    /// Fixed privacy marker categories. Raw sensitive values are never stored.
    pub privacy_markers: Vec<String>,
}

fn raw_transcription_output(transcription: &str) -> ProcessedTranscription {
    ProcessedTranscription {
        final_text: transcription.to_string(),
        post_processed_text: None,
        post_process_requested: false,
        llm_meta: None,
        dictionary_fixes: None,
        history_tag: None,
        privacy_markers: Vec::new(),
    }
}

async fn skipped_transcription_output(
    transcription: &str,
    session_id: u64,
) -> ProcessedTranscription {
    let completion = {
        let mut restore = POST_PROCESSING_FOCUS_RESTORE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match restore.as_ref() {
            Some((owner, _)) if *owner == session_id => restore.take().map(|(_, value)| value),
            _ => None,
        }
    };
    if let Some(completion) = completion {
        completion.wait().await;
    }
    raw_transcription_output(transcription)
}

/// Outcome of racing the LLM cleanup against the user's escape hatches.
enum LlmAwaitOutcome<T> {
    Finished(T),
    Interrupted,
}

/// Await the LLM cleanup while watching the Alt+S skip flag and the session
/// cancel marker (Esc / overlay X). `LlmManager::cancel_all` is only observed
/// by the chat STREAM loop's cancellation ticks — the cleanup also passes
/// through phases that cannot see it at all: the `/api/show` capability probe
/// and the chat POST's header wait (Ollama holds the response headers while it
/// loads and prefills the model, up to the 120s request ceiling). A skip
/// pressed there used to sit unanswered while the island kept counting.
///
/// Racing the whole future against the [`POST_PROCESSING_ESCAPE`] notifier
/// answers the user immediately in EVERY phase — event-driven, no polling:
/// dropping the future closes the in-flight HTTP request (so Ollama aborts the
/// generation and frees the GPU) and the pipeline finishes with the raw
/// transcript.
async fn await_llm_watching_escape_hatches<F, T>(llm: F, session_id: u64) -> LlmAwaitOutcome<T>
where
    F: std::future::Future<Output = T>,
{
    tokio::pin!(llm);
    let escape_requested = || {
        post_processing_skip_requested(session_id)
            || crate::transcription_coordinator::is_dictation_session_cancelled(session_id)
    };
    loop {
        // Create the wake future BEFORE reading the flags: a notify landing
        // between the check and the select either stores a permit (no waiter
        // registered yet) or wakes this future, so it cannot be lost.
        let escape = POST_PROCESSING_ESCAPE.notified();
        if escape_requested() {
            return LlmAwaitOutcome::Interrupted;
        }
        tokio::select! {
            result = &mut llm => return LlmAwaitOutcome::Finished(result),
            // A wake — or a stale permit from a prior session — loops back to
            // re-check the flags, which stay the source of truth.
            () = escape => {}
        }
    }
}

pub(crate) async fn process_transcription_output(
    app: &AppHandle,
    transcription: &str,
    session_id: u64,
) -> ProcessedTranscription {
    if transcription.trim().is_empty() {
        return raw_transcription_output("");
    }
    if post_processing_skip_requested(session_id) {
        return skipped_transcription_output(transcription, session_id).await;
    }

    let mut winstt_settings = crate::winstt::commands::settings::read_settings(app);
    let active_profile = super::app_profile::take_resolved(Duration::from_millis(1500));
    if let Some(profile) = &active_profile {
        crate::winstt::app_profiles::apply_profile_to_settings(
            &mut winstt_settings,
            &profile.config,
        );
    }
    let dictation_post_processing = dictation_post_processing_enabled(&winstt_settings);
    let winstt_dictation_llm = should_run_winstt_dictation_llm(&winstt_settings);
    let post_process_requested = winstt_dictation_llm;
    let mut final_text = transcription.to_string();
    let mut post_processed_text: Option<String> = None;
    let mut llm_meta: Option<String> = None;
    let mut dictionary_fixes: Option<i64> = None;
    let mut history_tag: Option<String> = None;
    let mut privacy_markers: Vec<String> = Vec::new();

    // The raw/no-LLM encoder-dictionary block already reads a context snapshot
    // (report R4 biasing terms). Capture ONCE, up front, iff the snapshot will be
    // consumed by SOME path this pass — the LLM prompt, the raw encoder-dict
    // biasing, OR the deterministic caret join — so we never capture twice and
    // never add a capture to a raw path that had none (context off, or the
    // encoder-dict block gated off ⇒ no snapshot ⇒ join is a no-op, text
    // unchanged). `capture_*` self-gates on `context_awareness` + pinned-window
    // validity, so a `Some` here means a real snapshot is in hand.
    // The encoder path runs when the LLM is not the dictionary authority: LLM cleanup off, OR the
    // Vocabulary tab's per-section toggle offloads dictionary corrections from the LLM back to the
    // on-device model (`llm_handles_dictionary` = false ⇒ terms are kept OUT of the prompt).
    let raw_encoder_dict_will_run = (!winstt_dictation_llm
        || !winstt_settings.general.llm_handles_dictionary)
        && winstt_settings.general.encoder_dictionary_enabled
        && winstt_settings.general.recording_mode != RecordingMode::Listen;
    let captured_context = if winstt_dictation_llm || raw_encoder_dict_will_run {
        capture_winstt_dictation_context_snapshot(app, &winstt_settings)
    } else {
        None
    };

    if dictation_post_processing {
        // Source the language from the picker settings. In candidate mode, only a single selected
        // Chinese script variant is strong enough to run OpenCC; multi-candidate auto must not.
        if let Some(converted_text) = match chinese_variant_language(&winstt_settings.model) {
            Some(selected_language) => {
                maybe_convert_chinese_variant(selected_language, transcription).await
            }
            None => None,
        } {
            final_text = converted_text;
        }
    }

    // The LLM prompt fragment is formatted from the SINGLE capture above (never a
    // second read); "" when no snapshot was available so the prompt has no
    // <context>.
    let llm_context_fragment = captured_context
        .as_ref()
        .map(format_captured_context)
        .unwrap_or_default();
    let llm_result = if winstt_dictation_llm {
        match await_llm_watching_escape_hatches(
            process_winstt_dictation_llm(app, &winstt_settings, &final_text, llm_context_fragment),
            session_id,
        )
        .await
        {
            LlmAwaitOutcome::Finished(result) => result,
            // Alt+S (paste raw now) or a session cancel landed while the LLM was
            // still running. Return the untouched engine transcript immediately —
            // the caller's `cancelled_session_cleanup` re-check suppresses the
            // paste for the cancel case, so this output only reaches the paste
            // worker on the Alt+S path.
            LlmAwaitOutcome::Interrupted => {
                return skipped_transcription_output(transcription, session_id).await;
            }
        }
    } else {
        None
    };

    // Alt+S may have landed in the same instant the LLM finished. Return the
    // untouched engine transcript before any replacement, vocabulary, snippet,
    // or caret passes.
    if post_processing_skip_requested(session_id) {
        return skipped_transcription_output(transcription, session_id).await;
    }

    let mut llm_cleanup_succeeded = false;
    if let Some((processed_text, meta, dict_fixes, side_effects)) = llm_result {
        let llm_failed = meta.error.is_some();
        llm_cleanup_succeeded = !llm_failed;
        if llm_failed {
            final_text = processed_text;
        } else {
            post_processed_text = Some(processed_text.clone());
            final_text = processed_text;
            history_tag = side_effects.history_tag.clone();
            privacy_markers = side_effects.privacy_markers.clone();
        }
        dictionary_fixes = Some(dict_fixes);
        llm_meta = serde_json::to_string(&serde_json::json!({
            "model": meta.model,
            "processingMs": meta.duration_ms,
            "tokens": meta.completion_tokens,
            "promptTokens": meta.prompt_tokens,
            "costUsd": meta.cost_usd,
            "error": meta.error,
            "learnedProperNounCount": side_effects.learned_proper_nouns.len(),
            "learnedSnippetCount": side_effects.learned_snippets.len(),
            "suggestedModifierCount": side_effects.suggested_modifier_presets.len(),
            "appProfileRule": active_profile.as_ref().map(|profile| &profile.configuration_name),
        }))
        .ok();
    }

    // Replacement pairs are deterministic and model-independent. Apply them once
    // after LLM cleanup (as a safety net for ignored prompt instructions), or on
    // non-listen local paths. Listen mode stays raw unless LLM cleanup ran.
    if winstt_dictation_llm || winstt_settings.general.recording_mode != RecordingMode::Listen {
        let pairs = crate::winstt::commands::llm::replacement_pairs(&winstt_settings);
        if !pairs.is_empty() {
            let (replaced, n) =
                crate::winstt::llm::apply_replacement_pairs_counted(&final_text, &pairs);
            if n > 0 {
                final_text = replaced;
                post_processed_text = Some(final_text.clone());
                dictionary_fixes = Some(dictionary_fixes.unwrap_or(0) + n as i64);
            }
        }
    }

    // Context-aware encoder correction for VOCABULARY words ("veet"->"Vite", "video" stays "video").
    // This needs the ~310 MB masked-LM, so it stays gated on `encoder_dictionary_enabled`; the model
    // downloads on demand and the whole block is fail-soft (returns text unchanged until ready).
    if raw_encoder_dict_will_run {
        let mut terms: Vec<String> = winstt_settings
            .dictionary
            .iter()
            .filter(|d| d.replacement.as_deref().map_or("", str::trim).is_empty())
            .map(|d| d.term.clone())
            .filter(|t| !t.trim().is_empty())
            .collect();

        // Report R4: fold in session-scoped biasing terms from the on-screen
        // context (proper nouns + code identifiers near the caret) so the encoder
        // snaps the transcript toward names the user is looking at — Wispr's
        // "variable recognition" / Aqua's "screen as dictionary", via the SAME
        // vocabulary-biasing path. Deduped against the persisted user dictionary
        // (case-insensitive, user entries win). These are NEVER written back to
        // the dictionary and NEVER reach the STT prompt.
        let user_term_count = terms.len();
        let context_terms: Vec<String> = captured_context
            .as_ref()
            .map(|c| c.terms.clone())
            .unwrap_or_default();
        if !context_terms.is_empty() {
            let existing: std::collections::HashSet<String> =
                terms.iter().map(|t| t.to_lowercase()).collect();
            terms.extend(
                context_terms
                    .into_iter()
                    .filter(|t| !existing.contains(&t.to_lowercase())),
            );
        }

        if !terms.is_empty() {
            let encoder_started = Instant::now();
            debug!(
                "[stt-ui] encoder_dict_start chars={} terms={} user_terms={} context_terms={}",
                final_text.chars().count(),
                terms.len(),
                user_term_count,
                terms.len().saturating_sub(user_term_count)
            );
            let corrected =
                crate::winstt::encoder_dict::correct_vocabulary(app, &final_text, &terms).await;
            debug!(
                "[stt-ui] encoder_dict_complete duration_ms={} changed={}",
                encoder_started.elapsed().as_millis(),
                corrected != final_text
            );
            if corrected != final_text {
                final_text = corrected;
                post_processed_text = Some(final_text.clone());
            }
        }
    }

    if dictation_post_processing {
        if post_processed_text.is_none() && final_text != transcription {
            post_processed_text = Some(final_text.clone());
        }

        // WinSTT snippet expansion: deterministic fuzzy trigger→expansion on the finalized
        // text — the LAST step before paste (mirrors applyPostProcessing's replaceWithSnippets,
        // after dictionary correction). Uses the warm in-memory cache; no-op when no snippets.
        // Skipped when the LLM owns snippets AND actually ran: with `llm_handles_snippets` on,
        // the snippets were in the prompt and the model already expanded them in context —
        // re-running the fuzzy matcher here would double-expand (or mangle text the model chose
        // to leave alone). On LLM failure (or the toggle offloading snippets to the deterministic
        // path) this expander is the guarantee, exactly as before.
        let llm_owns_snippets =
            llm_cleanup_succeeded && winstt_settings.general.llm_handles_snippets;
        if !llm_owns_snippets
            && let Some(snippets) = app.try_state::<Arc<crate::winstt::snippets::SnippetsManager>>()
        {
            let expanded = snippets.expand_cached(&final_text);
            if expanded != final_text {
                final_text = expanded;
                post_processed_text = Some(final_text.clone());
            }
        }
    }

    // Deterministic caret join: the FINAL boundary adjustment, applied to both the
    // LLM-cleaned and raw paths using the single captured snapshot + terms. Small
    // local models ignore mid-sentence continuation casing and IDE @file tagging;
    // enforce them here. No-op when no snapshot was captured (context off / stale
    // window), so raw dictation without a capture is left byte-for-byte unchanged.
    // Idempotent, so it is safe even if the LLM already produced the right shape.
    if let Some(captured) = captured_context.as_ref() {
        let joined = apply_caret_join(&final_text, captured);
        if joined != final_text {
            final_text = joined;
            post_processed_text = Some(final_text.clone());
        }
    }

    ProcessedTranscription {
        final_text,
        post_processed_text,
        post_process_requested,
        llm_meta,
        dictionary_fixes,
        history_tag,
        privacy_markers,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    static SKIP_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn post_processing_skip_is_scoped_to_one_dictation_session() {
        let _guard = SKIP_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        begin_post_processing_skip_window(41);
        assert!(!post_processing_skip_requested(41));

        SKIP_POST_PROCESSING_SESSION.store(41, Ordering::Release);
        assert!(post_processing_skip_requested(41));
        assert!(!post_processing_skip_requested(42));

        finish_post_processing_skip_window(41);
        assert!(!post_processing_skip_requested(41));
        assert_eq!(ACTIVE_POST_PROCESSING_SESSION.load(Ordering::Acquire), 0);
    }

    #[test]
    fn raw_skip_output_keeps_only_the_engine_transcript() {
        let output = raw_transcription_output("untouched STT text");
        assert_eq!(output.final_text, "untouched STT text");
        assert!(output.post_processed_text.is_none());
        assert!(!output.post_process_requested);
        assert!(output.llm_meta.is_none());
    }

    #[tokio::test]
    #[expect(
        clippy::await_holding_lock,
        reason = "test-only serialization of the global skip-window statics; single-task runtime"
    )]
    async fn skip_flag_interrupts_a_pending_llm_await() {
        let _guard = SKIP_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        begin_post_processing_skip_window(77);
        SKIP_POST_PROCESSING_SESSION.store(77, Ordering::Release);

        // The LLM future never resolves (models a header wait / wedged probe);
        // the pre-armed skip flag alone must break the await.
        let outcome = await_llm_watching_escape_hatches(std::future::pending::<()>(), 77).await;
        assert!(matches!(outcome, LlmAwaitOutcome::Interrupted));

        finish_post_processing_skip_window(77);
    }

    #[tokio::test]
    #[expect(
        clippy::await_holding_lock,
        reason = "test-only serialization of the global skip-window statics; single-task runtime"
    )]
    async fn escape_notify_interrupts_a_running_await_without_polling() {
        let _guard = SKIP_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        begin_post_processing_skip_window(88);

        // Alt+S lands only AFTER the watcher is already parked on the pending
        // LLM future — the notify wake (not a poll tick, no timers here) must
        // trigger the flag re-check.
        let watcher = await_llm_watching_escape_hatches(std::future::pending::<()>(), 88);
        let alt_s = async {
            tokio::task::yield_now().await;
            SKIP_POST_PROCESSING_SESSION.store(88, Ordering::Release);
            notify_post_processing_escape();
        };
        let (outcome, ()) = tokio::join!(watcher, alt_s);
        assert!(matches!(outcome, LlmAwaitOutcome::Interrupted));

        finish_post_processing_skip_window(88);
    }

    #[tokio::test]
    #[expect(
        clippy::await_holding_lock,
        reason = "test-only serialization of the global skip-window statics; single-task runtime"
    )]
    async fn finished_llm_await_passes_the_result_through() {
        let _guard = SKIP_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // No skip window armed and a session id no test cancels: the completed
        // future's value must come back untouched.
        let outcome = await_llm_watching_escape_hatches(async { 42 }, u64::MAX).await;
        assert!(matches!(outcome, LlmAwaitOutcome::Finished(42)));
    }

    fn settings_with_dictation_model(enabled: bool) -> WinsttSettings {
        let mut settings = WinsttSettings::default();
        settings.llm.dictation.enabled = enabled;
        settings.llm.dictation.base.model = "qwen2.5:7b".into();
        settings
    }

    #[test]
    fn dictation_post_processing_toggle_is_the_master_gate() {
        let mut settings = settings_with_dictation_model(false);
        assert!(!dictation_post_processing_enabled(&settings));
        assert!(!should_run_winstt_dictation_llm(&settings));

        settings.llm.dictation.enabled = true;
        assert!(dictation_post_processing_enabled(&settings));
        assert!(should_run_winstt_dictation_llm(&settings));

        settings.general.recording_mode = RecordingMode::Listen;
        assert!(!dictation_post_processing_enabled(&settings));
        assert!(!should_run_winstt_dictation_llm(&settings));
    }

    #[test]
    fn missing_model_keeps_llm_off_even_when_toggle_is_on() {
        let mut settings = WinsttSettings::default();
        settings.llm.dictation.enabled = true;

        assert!(dictation_post_processing_enabled(&settings));
        assert!(!should_run_winstt_dictation_llm(&settings));
    }

    #[test]
    fn apple_intelligence_needs_no_model_id() {
        let mut settings = WinsttSettings::default();
        settings.llm.dictation.enabled = true;
        settings.llm.dictation.base.provider = LlmProvider::AppleIntelligence;
        settings.llm.dictation.base.model.clear();

        assert!(should_run_winstt_dictation_llm(&settings));
        assert_eq!(dictation_llm_model(&settings), "apple-intelligence");
    }
}
