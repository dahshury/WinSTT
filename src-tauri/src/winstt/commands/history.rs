// History command surface for the WinSTT renderer. The WinSTT renderer drives
// history through TWO disjoint channel groups (both routed by the WU-0 adapter,
// `shared/api/native-bridge-adapter.ts`):
//
//   1. The dedicated `views/history` window + the `entities/transcription-history`
//      client → the SQLite-store channels:  history:list / add / delete-row /
//      toggle / recent / load-audio-by-row  + the  history:row-{added,deleted,
//      toggled}  events. Shape = `HistoryEntry` (NUMBER id, `fileName`,
//      `transcriptionText`, `postProcessedText`, `saved`, `title`, epoch-SECONDS
//      `timestamp`).
//
//   2. The settings panel + karaoke `HistoryTable` (word-timestamp playback) via
//      `shared/api/ipc-client.ts` → the legacy persisted store channels:
//      history:get-all / clear / delete / load-audio / align-audio  +  the
//      history:{added,deleted}  events. Shape = `TranscriptionHistoryEntry`
//      (STRING id, `text`, `wordCount`, `durationMs`, `audioFilePath?`,
//      `originalText?`, `llmModel?`, epoch-MILLIS `timestamp`).
//
// Per the plan we back BOTH surfaces with the single `managers::history::
// HistoryManager` (SQLite) and reshape its rows into each renderer shape, so
// there is one source of truth on disk. Every payload here is camelCase (matches
// the verbatim-ported renderer) and derives `specta::Type` for tauri-specta
// bindings. NEW FILE — registration (collect_commands![] + the event bridge call)
// is reported for lib.rs in the WU output, not edited here (HARD RULE).
//
// Event delivery: `HistoryManager` already emits the collected
// `HistoryUpdatePayload` (tag="action") on save/delete/toggle from `actions.rs`.
// `install_history_event_bridge` re-emits each update as the WinSTT-shaped plain
// events the adapter listens for, so the reused
// renderer's `onTranscriptionHistoryAdded` / `HISTORY_ROW_*` listeners fire
// unchanged. The orchestrator calls it once in `initialize_core_logic`.

use std::path::PathBuf;
use std::sync::Arc;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_specta::Event;

use crate::managers::history::{
    HistoryEntry as DbHistoryEntry, HistoryManager, HistoryUpdatePayload, TransformHistoryDbEntry,
};

const EVT_TRANSFORM_HISTORY_ADDED: &str = "transform-history:added";
const EVT_TRANSFORM_HISTORY_DELETED: &str = "transform-history:deleted";

/// Hard cap on the unbounded `history_get_all` read. The legacy settings panel
/// loads the full set into a renderer store (no pagination) to compute its
/// AI-Impact / Voice-Profile stats, so we still return "all" — but bounded to
/// the newest `HISTORY_GET_ALL_CAP` rows so a runaway history can't blow up
/// memory or the IPC payload. The cap is logged when hit so it's diagnosable.
const HISTORY_GET_ALL_CAP: i64 = 5000;

// ── Renderer-facing payload shapes (camelCase, byte-identical to WinSTT) ────────

/// Legacy `TranscriptionHistoryEntry` (ipc-client.ts) — the karaoke `HistoryTable`
/// + the settings panel sync. STRING id, epoch-MILLIS timestamp.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionHistoryEntry {
    pub id: String,
    pub text: String,
    pub timestamp: i64,
    pub word_count: i64,
    pub duration_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llm_model: Option<String>,
    /// Recorded post-processing error when an LLM was requested but failed soft.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llm_error: Option<String>,
    /// LLM post-processing wall-time in ms (the footer's "processing time"),
    /// when an LLM ran.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llm_processing_ms: Option<i64>,
    /// LLM generation speed (output tokens / processing second), when the
    /// provider reported token usage and the pass took a measurable duration.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llm_tokens_per_second: Option<f64>,
    /// Count of dictionary replacement-pair substitutions applied to this
    /// transcription. Omitted on legacy rows (column added later); summed into
    /// the History "AI Impact" → dictionary-fixes stat.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dictionary_fixes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_tag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub privacy_markers: Option<Vec<String>>,
    /// Human-friendly name of the STT ("main") model that produced this
    /// transcription (e.g. `Whisper Tiny`), resolved from the stored model id.
    /// Omitted on legacy rows and renderer-driven manual adds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stt_model: Option<String>,
}

/// Legacy-table compatible transform row for the settings History tab. It uses
/// the same core fields as `TranscriptionHistoryEntry` so the current table,
/// copy controls, and before/after diff view can be shared unchanged.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TransformHistoryEntry {
    pub id: String,
    pub text: String,
    pub timestamp: i64,
    pub word_count: i64,
    pub duration_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llm_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llm_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llm_processing_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llm_tokens_per_second: Option<f64>,
    pub source: String,
}

/// Entity `HistoryEntry` (entities/transcription-history/model) — the dedicated
/// history window + paginated list. NUMBER id, epoch-SECONDS timestamp.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRow {
    pub id: i64,
    pub file_name: String,
    pub timestamp: i64,
    pub saved: bool,
    pub title: String,
    pub transcription_text: String,
    pub post_processed_text: Option<String>,
    pub post_process_prompt: Option<String>,
    pub post_process_requested: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_tag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub privacy_markers: Option<Vec<String>>,
}

/// `PaginatedHistory` (camelCase `hasMore`) returned by `history_list`.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PaginatedHistory {
    pub entries: Vec<HistoryRow>,
    pub has_more: bool,
}

/// `{ deleted }` envelope for `history_delete` / `history_delete_row`.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeletedResult {
    pub deleted: bool,
}

/// `{ saved }` envelope for `history_toggle`. `null` when the row is missing.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ToggleResult {
    pub saved: Option<bool>,
}

/// `{ cleared: true }` envelope for `history_clear`.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClearResult {
    pub cleared: bool,
}

// ── Reshaping helpers ───────────────────────────────────────────────────────────

fn count_words(text: &str) -> i64 {
    text.split_whitespace().count() as i64
}

fn parse_privacy_markers(raw: Option<&str>) -> Vec<String> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    let Some(arr) = value.as_array() else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

fn optional_privacy_markers(raw: Option<&str>) -> Option<Vec<String>> {
    let markers = parse_privacy_markers(raw);
    if markers.is_empty() {
        None
    } else {
        Some(markers)
    }
}

/// Effective user-facing text: the post-processed (LLM-cleaned) text when present
/// and non-empty, else the raw transcript. Mirrors the renderer's `effectiveText`
/// + the legacy store's `shouldKeepOriginalText` policy.
fn effective_text(entry: &DbHistoryEntry) -> &str {
    match entry.post_processed_text.as_deref() {
        Some(cleaned) if !cleaned.trim().is_empty() => cleaned,
        _ => &entry.transcription_text,
    }
}

/// Map a DB row -> the legacy `TranscriptionHistoryEntry` shape (STRING id,
/// MILLIS timestamp). `audioFilePath` is set only when the WAV is on disk so the
/// renderer renders the play button exactly when playback can succeed.
fn to_transcription_entry(
    mgr: &HistoryManager,
    entry: &DbHistoryEntry,
) -> TranscriptionHistoryEntry {
    let text = effective_text(entry).to_string();
    // `originalText` enables "Copy Original" — surface it whenever the LLM ran and
    // produced post-processed text (matches `shouldKeepOriginalText` with llmRan).
    let original_text = match entry.post_processed_text.as_deref() {
        Some(cleaned) if !cleaned.trim().is_empty() => Some(entry.transcription_text.clone()),
        _ => None,
    };
    // Resolve the saved WAV once: it drives both the play button (`audioFilePath`)
    // and the recording duration. Duration is derived from the WAV header here
    // rather than stored in the DB so it backfills rows written before duration
    // was tracked; `0` means "no recording on disk" (cloud-STT / legacy rows),
    // which the History WPM/speaking-time stats treat as "unknown".
    let recording_path = if entry.file_name.is_empty() {
        None
    } else {
        let path = mgr.get_audio_file_path(&entry.file_name);
        path.exists().then_some(path)
    };
    let duration_ms = recording_path
        .as_deref()
        .and_then(crate::audio_toolkit::wav_duration_ms)
        .map_or(0, |ms| ms as i64);
    let audio_file_path = recording_path.and_then(|p| p.to_str().map(str::to_string));
    // Reshape the stored LLM telemetry JSON (`{model, processingMs, tokens}`)
    // into the footer's model / processing-time / speed chips. tokens/s is
    // computed here so the renderer only formats; it's omitted when the
    // provider reported no tokens or the pass was sub-millisecond.
    let meta = entry
        .llm_meta
        .as_deref()
        .map(parse_llm_meta)
        .unwrap_or_default();
    let llm_failed = meta.error.is_some();
    let llm_tokens_per_second = if llm_failed {
        None
    } else {
        tokens_per_second(meta.tokens, meta.processing_ms)
    };
    // Resolve the stored STT model id to its catalog display name (e.g.
    // `tiny` → "Whisper Tiny"); cloud ids fall back to the raw id. Blank ids
    // collapse to `None` so the renderer simply omits the chip.
    let stt_model = entry
        .stt_model
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(crate::winstt::catalog::display_name_for_id);
    TranscriptionHistoryEntry {
        id: entry.id.to_string(),
        word_count: count_words(&text),
        text,
        // History rows store `Utc::now().timestamp()` (SECONDS); the legacy renderer
        // shape is MILLIS (`new Date(ms)`), so scale up.
        timestamp: entry.timestamp.saturating_mul(1000),
        duration_ms,
        audio_file_path,
        original_text,
        llm_model: meta.model,
        llm_error: meta.error,
        llm_processing_ms: if llm_failed { None } else { meta.processing_ms },
        llm_tokens_per_second,
        dictionary_fixes: entry.dictionary_fixes,
        history_tag: entry.history_tag.clone(),
        privacy_markers: optional_privacy_markers(entry.privacy_markers_json.as_deref()),
        stt_model,
    }
}

fn to_transform_entry(entry: &TransformHistoryDbEntry) -> TransformHistoryEntry {
    let meta = entry
        .llm_meta
        .as_deref()
        .map(parse_llm_meta)
        .unwrap_or_default();
    let llm_tokens_per_second = tokens_per_second(meta.tokens, meta.processing_ms);
    TransformHistoryEntry {
        id: entry.id.to_string(),
        word_count: count_words(&entry.after_text),
        text: entry.after_text.clone(),
        timestamp: entry.timestamp.saturating_mul(1000),
        duration_ms: 0,
        original_text: if entry.before_text.trim().is_empty() {
            None
        } else {
            Some(entry.before_text.clone())
        },
        llm_model: meta.model,
        llm_error: meta.error,
        llm_processing_ms: meta.processing_ms,
        llm_tokens_per_second,
        source: entry.source.clone(),
    }
}

pub fn emit_transform_history_added(app: &AppHandle, entry: &TransformHistoryDbEntry) {
    let payload = to_transform_entry(entry);
    let _ = app.emit(EVT_TRANSFORM_HISTORY_ADDED, &payload);
}

fn emit_transform_history_deleted(app: &AppHandle, id: i64) {
    let _ = app.emit(
        EVT_TRANSFORM_HISTORY_DELETED,
        serde_json::json!({ "id": id.to_string() }),
    );
}

/// Parsed `llm_meta` telemetry. All fields optional so a malformed / partial
/// blob degrades to "no chips" rather than failing the whole list.
#[derive(Default)]
struct LlmMeta {
    model: Option<String>,
    error: Option<String>,
    processing_ms: Option<i64>,
    tokens: Option<i64>,
}

/// LLM generation speed (output tokens / processing second). `None` when the
/// provider reported no tokens or the pass was sub-millisecond.
fn tokens_per_second(tokens: Option<i64>, processing_ms: Option<i64>) -> Option<f64> {
    match (tokens, processing_ms) {
        (Some(tokens), Some(ms)) if tokens > 0 && ms > 0 => {
            Some(tokens as f64 / (ms as f64 / 1000.0))
        }
        _ => None,
    }
}

fn parse_llm_meta(raw: &str) -> LlmMeta {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return LlmMeta::default();
    };
    LlmMeta {
        model: value
            .get("model")
            .and_then(|m| m.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty()),
        error: value
            .get("error")
            .and_then(|m| m.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty()),
        processing_ms: value.get("processingMs").and_then(|m| m.as_i64()),
        tokens: value.get("tokens").and_then(|t| t.as_i64()),
    }
}

/// Map a DB row -> the entity `HistoryRow` shape (NUMBER id, SECONDS
/// timestamp). 1:1 with `managers::history::HistoryEntry`, camelCase-renamed.
fn to_history_row(entry: &DbHistoryEntry) -> HistoryRow {
    HistoryRow {
        id: entry.id,
        file_name: entry.file_name.clone(),
        timestamp: entry.timestamp,
        saved: entry.saved,
        title: entry.title.clone(),
        transcription_text: entry.transcription_text.clone(),
        post_processed_text: entry.post_processed_text.clone(),
        post_process_prompt: entry.post_process_prompt.clone(),
        post_process_requested: entry.post_process_requested,
        history_tag: entry.history_tag.clone(),
        privacy_markers: optional_privacy_markers(entry.privacy_markers_json.as_deref()),
    }
}

fn wav_to_data_uri(path: &PathBuf) -> Option<String> {
    if !path.exists() {
        return None;
    }
    match std::fs::read(path) {
        Ok(bytes) => {
            let b64 = super::base64_encode(&bytes);
            Some(format!("data:audio/wav;base64,{b64}"))
        }
        Err(_) => None,
    }
}

/// Resolve the on-disk `history.db` path (same as `HistoryManager::new`) so the
/// offset-paginated `history_list` can run an OFFSET query the manager doesn't
/// expose. Read-only; the manager owns all writes.
fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::portable::app_data_dir(app).map_err(|e| e.to_string())?;
    Ok(dir.join("history.db"))
}

fn open_db(app: &AppHandle) -> Result<Connection, String> {
    Connection::open(db_path(app)?).map_err(|e| e.to_string())
}

/// Run a read-only rusqlite closure on the blocking pool. rusqlite is
/// synchronous, so opening the connection and running the query inside an
/// `async fn` would stall the tokio worker; this hops to `spawn_blocking`
/// (mirrors the `tts.rs` / `download.rs` pattern) and folds the join + DB
/// errors into one `String`.
async fn spawn_db<T, F>(app: &AppHandle, work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&Connection) -> rusqlite::Result<T> + Send + 'static,
{
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db(&app)?;
        work(&conn).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("history db task panicked: {e}"))?
}

fn map_db_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DbHistoryEntry> {
    Ok(DbHistoryEntry {
        id: row.get("id")?,
        file_name: row.get("file_name")?,
        timestamp: row.get("timestamp")?,
        saved: row.get("saved")?,
        title: row.get("title")?,
        transcription_text: row.get("transcription_text")?,
        post_processed_text: row.get("post_processed_text")?,
        post_process_prompt: row.get("post_process_prompt")?,
        post_process_requested: row.get("post_process_requested")?,
        llm_meta: row.get("llm_meta")?,
        dictionary_fixes: row.get("dictionary_fixes")?,
        history_tag: row.get("history_tag")?,
        privacy_markers_json: row.get("privacy_markers_json")?,
        stt_model: row.get("stt_model")?,
    })
}

// ── Group 1: SQLite-store channels (dedicated history window) ───────────────────

/// `history:list` — offset-paginated rows, newest first. `{ offset, limit }` →
/// `{ entries, hasMore }`. Over-fetches one row to compute `hasMore` cheaply.
#[tauri::command]
#[specta::specta]
pub async fn history_list(
    app: AppHandle,
    offset: i64,
    limit: i64,
) -> Result<PaginatedHistory, String> {
    let lim = limit.clamp(1, 100);
    let off = offset.max(0);
    let fetch = lim + 1;
    // rusqlite is synchronous; run the open + query off the async pump so the
    // tokio worker isn't blocked (matches `tts.rs` / `download.rs`).
    let mut entries = spawn_db(&app, move |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, file_name, timestamp, saved, title, transcription_text, \
             post_processed_text, post_process_prompt, post_process_requested, llm_meta, \
             dictionary_fixes, history_tag, privacy_markers_json, stt_model \
             FROM transcription_history ORDER BY id DESC LIMIT ?1 OFFSET ?2",
        )?;
        // Bind before the closure ends so the row-iterator's borrow of `stmt`
        // is released before `stmt` is dropped.
        let rows = stmt
            .query_map(rusqlite::params![fetch, off], map_db_row)?
            .collect::<rusqlite::Result<Vec<DbHistoryEntry>>>()?;
        Ok(rows)
    })
    .await?;
    let has_more = entries.len() as i64 > lim;
    if has_more {
        entries.pop();
    }
    Ok(PaginatedHistory {
        entries: entries.iter().map(to_history_row).collect(),
        has_more,
    })
}

/// `history:recent` — the `n` newest rows (tray submenu / quick re-paste).
#[tauri::command]
#[specta::specta]
pub async fn history_recent(app: AppHandle, value: Option<i64>) -> Result<Vec<HistoryRow>, String> {
    let n = value.unwrap_or(5).clamp(1, 100);
    let rows = spawn_db(&app, move |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, file_name, timestamp, saved, title, transcription_text, \
             post_processed_text, post_process_prompt, post_process_requested, llm_meta, \
             dictionary_fixes, history_tag, privacy_markers_json, stt_model \
             FROM transcription_history ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![n], map_db_row)?
            .collect::<rusqlite::Result<Vec<DbHistoryEntry>>>()?;
        Ok(rows)
    })
    .await?;
    Ok(rows.iter().map(to_history_row).collect())
}

/// `history:delete-row` — delete one row (NUMBER id) → `{ deleted }`. Routes
/// through the manager so the WAV is unlinked + `HistoryUpdatePayload::Deleted`
/// fires (the bridge re-emits `history:row-deleted`).
#[tauri::command]
#[specta::specta]
pub async fn history_delete_row(
    history_manager: State<'_, Arc<HistoryManager>>,
    id: i64,
) -> Result<DeletedResult, String> {
    let exists = history_manager
        .get_entry_by_id(id)
        .await
        .map_err(|e| e.to_string())?
        .is_some();
    if !exists {
        return Ok(DeletedResult { deleted: false });
    }
    history_manager
        .delete_entry(id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(DeletedResult { deleted: true })
}

/// `history:toggle` — flip a row's `saved` (pin) flag → `{ saved }` (the NEW
/// value), or `{ saved: null }` when the row is missing.
#[tauri::command]
#[specta::specta]
pub async fn history_toggle(
    history_manager: State<'_, Arc<HistoryManager>>,
    id: i64,
) -> Result<ToggleResult, String> {
    let Some(entry) = history_manager
        .get_entry_by_id(id)
        .await
        .map_err(|e| e.to_string())?
    else {
        return Ok(ToggleResult { saved: None });
    };
    history_manager
        .toggle_saved_status(id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(ToggleResult {
        saved: Some(!entry.saved),
    })
}

/// `history:load-audio-by-row` — WAV for a row (NUMBER id) as a data URI, or null.
#[tauri::command]
#[specta::specta]
pub async fn history_load_audio_by_row(
    history_manager: State<'_, Arc<HistoryManager>>,
    id: i64,
) -> Result<Option<String>, String> {
    let Some(entry) = history_manager
        .get_entry_by_id(id)
        .await
        .map_err(|e| e.to_string())?
    else {
        return Ok(None);
    };
    if entry.file_name.is_empty() {
        return Ok(None);
    }
    let path = history_manager.get_audio_file_path(&entry.file_name);
    Ok(wav_to_data_uri(&path))
}

/// `history:add` — persist a row. The renderer rarely calls this directly (the
/// dictation coordinator owns saves), but the channel is routed so we honor it.
/// `{ text, postProcessedText?, postProcessPrompt?, postProcessRequested? }`.
#[tauri::command]
#[specta::specta]
pub async fn history_add(
    history_manager: State<'_, Arc<HistoryManager>>,
    text: Option<String>,
    post_processed_text: Option<String>,
    post_process_prompt: Option<String>,
    post_process_requested: Option<bool>,
) -> Result<Option<HistoryRow>, String> {
    let transcription_text = text.unwrap_or_default();
    if transcription_text.trim().is_empty() {
        return Ok(None);
    }
    let entry = history_manager
        .save_entry(
            String::new(),
            transcription_text,
            post_process_requested.unwrap_or(false),
            post_processed_text,
            post_process_prompt,
            // Manual renderer-driven add — no LLM telemetry or engine context.
            None,
            None,
            None,
            None,
            None,
        )
        .map_err(|e| e.to_string())?;
    Ok(Some(to_history_row(&entry)))
}

// ── Group 2: legacy persisted store channels (settings panel + karaoke table) ────

/// `history:get-all` — every row reshaped to the legacy `TranscriptionHistoryEntry`
/// shape (STRING id, MILLIS timestamp). Oldest-first to match the legacy
/// persisted store's append order; the renderer's `HistoryTable` reverses it.
#[tauri::command]
#[specta::specta]
pub async fn history_get_all(
    app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
) -> Result<Vec<TranscriptionHistoryEntry>, String> {
    // Clone the `Arc` so the reshape (which does a per-row `path.exists()`
    // filesystem stat for the audio button) can run inside the blocking task
    // alongside the query, off the async pump.
    let mgr = history_manager.inner().clone();
    // Newest-first + bounded so a runaway history can't blow up the payload;
    // re-sort oldest-first afterwards to match the legacy append order the
    // renderer's `HistoryTable` expects.
    let mut rows = spawn_db(&app, move |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, file_name, timestamp, saved, title, transcription_text, \
             post_processed_text, post_process_prompt, post_process_requested, llm_meta, \
             dictionary_fixes, history_tag, privacy_markers_json, stt_model \
             FROM transcription_history ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![HISTORY_GET_ALL_CAP], map_db_row)?
            .collect::<rusqlite::Result<Vec<DbHistoryEntry>>>()?;
        Ok(rows)
    })
    .await?;
    if rows.len() as i64 >= HISTORY_GET_ALL_CAP {
        log::warn!(
            "[history] history_get_all hit the {HISTORY_GET_ALL_CAP}-row cap; \
             older rows are omitted from the settings History view"
        );
    }
    rows.reverse();
    let entries = tauri::async_runtime::spawn_blocking(move || {
        rows.iter()
            .map(|e| to_transcription_entry(mgr.as_ref(), e))
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| format!("history reshape task panicked: {e}"))?;
    Ok(entries)
}

/// `history:clear` — delete every row (and its WAV) → `{ cleared: true }`.
#[tauri::command]
#[specta::specta]
pub async fn history_clear(
    app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
) -> Result<ClearResult, String> {
    // Collect ids first, then delete via the manager so each WAV is unlinked and
    // a `Deleted` event fires per row (the bridge fans them to the renderer).
    let ids: Vec<i64> = spawn_db(&app, |conn| {
        let mut stmt = conn.prepare("SELECT id FROM transcription_history ORDER BY id ASC")?;
        let ids = stmt
            .query_map([], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(ids)
    })
    .await?;
    for id in ids {
        // Best-effort: a row vanishing under us (concurrent delete) is not fatal.
        let _ = history_manager.delete_entry(id).await;
    }
    Ok(ClearResult { cleared: true })
}

/// `history:delete` (STRING id) — legacy delete → `{ deleted }`.
#[tauri::command]
#[specta::specta]
pub async fn history_delete(
    history_manager: State<'_, Arc<HistoryManager>>,
    id: String,
) -> Result<DeletedResult, String> {
    let Ok(numeric) = id.parse::<i64>() else {
        return Ok(DeletedResult { deleted: false });
    };
    let exists = history_manager
        .get_entry_by_id(numeric)
        .await
        .map_err(|e| e.to_string())?
        .is_some();
    if !exists {
        return Ok(DeletedResult { deleted: false });
    }
    history_manager
        .delete_entry(numeric)
        .await
        .map_err(|e| e.to_string())?;
    Ok(DeletedResult { deleted: true })
}

/// `history:load-audio` (STRING id) — WAV for a legacy entry as a data URI, or null.
#[tauri::command]
#[specta::specta]
pub async fn history_load_audio(
    history_manager: State<'_, Arc<HistoryManager>>,
    id: String,
) -> Result<Option<String>, String> {
    let Ok(numeric) = id.parse::<i64>() else {
        return Ok(None);
    };
    let Some(entry) = history_manager
        .get_entry_by_id(numeric)
        .await
        .map_err(|e| e.to_string())?
    else {
        return Ok(None);
    };
    if entry.file_name.is_empty() {
        return Ok(None);
    }
    let path = history_manager.get_audio_file_path(&entry.file_name);
    Ok(wav_to_data_uri(&path))
}

/// `transform-history:get-all` — every transform row reshaped to the same table
/// shape as transcription history: final text plus `originalText` for the diff.
#[tauri::command]
#[specta::specta]
pub async fn transform_history_get_all(
    history_manager: State<'_, Arc<HistoryManager>>,
) -> Result<Vec<TransformHistoryEntry>, String> {
    let rows = history_manager
        .get_transform_history_entries()
        .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(to_transform_entry).collect())
}

/// `transform-history:clear` — delete all transform rows. Uses the same
/// `ClearResult` envelope as transcription history so the frontend can share
/// the clear-confirm flow.
#[tauri::command]
#[specta::specta]
pub async fn transform_history_clear(
    app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
) -> Result<ClearResult, String> {
    let rows = history_manager
        .get_transform_history_entries()
        .map_err(|e| e.to_string())?;
    for entry in rows {
        if history_manager
            .delete_transform_entry(entry.id)
            .map_err(|e| e.to_string())?
        {
            emit_transform_history_deleted(&app, entry.id);
        }
    }
    Ok(ClearResult { cleared: true })
}

/// `transform-history:delete` (STRING id) — delete one transform row.
#[tauri::command]
#[specta::specta]
pub async fn transform_history_delete(
    app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    id: String,
) -> Result<DeletedResult, String> {
    let Ok(numeric) = id.parse::<i64>() else {
        return Ok(DeletedResult { deleted: false });
    };
    let deleted = history_manager
        .delete_transform_entry(numeric)
        .map_err(|e| e.to_string())?;
    if deleted {
        emit_transform_history_deleted(&app, numeric);
    }
    Ok(DeletedResult { deleted })
}

// ── Event bridge: collected HistoryUpdatePayload → WinSTT plain events ───────────

/// Re-emit the collected `HistoryUpdatePayload` (fired by `actions.rs` /
/// `HistoryManager` on save / update / delete / toggle) as the WinSTT-shaped plain
/// events the WU-0 adapter listens for:
///   - `Added`   → `history:added` (legacy `TranscriptionHistoryEntry`)
///     + `history:row-added` (entity `HistoryRow`)
///   - `Deleted` → `history:deleted` `{ id: "<n>" }`  +  `history:row-deleted` `{ id: <n> }`
///   - `Toggled` → `history:row-toggled` `{ id, saved }`
///   - `Updated` → `history:row-added` (renderer upserts on the same id)
///
/// Called once from `initialize_core_logic` (reported for lib.rs wiring). The
/// `HistoryManager` must already be in managed state so we can reshape the
/// `Added` payload's WAV path; we read it back off the `AppHandle`.
pub fn install_history_event_bridge(app: &AppHandle) {
    let handle = app.clone();
    let _ = HistoryUpdatePayload::listen(app, move |event| match event.payload {
        HistoryUpdatePayload::Added { entry } | HistoryUpdatePayload::Updated { entry } => {
            let mgr = handle.state::<Arc<HistoryManager>>();
            let legacy = to_transcription_entry(mgr.inner().as_ref(), &entry);
            let _ = handle.emit("history:added", &legacy);
            let row = to_history_row(&entry);
            let _ = handle.emit("history:row-added", &row);
        }
        HistoryUpdatePayload::Deleted { id } => {
            let _ = handle.emit(
                "history:deleted",
                serde_json::json!({ "id": id.to_string() }),
            );
            let _ = handle.emit("history:row-deleted", serde_json::json!({ "id": id }));
        }
        HistoryUpdatePayload::Toggled { id } => {
            // The renderer needs the NEW saved flag; read it back off the DB
            // synchronously (this listener runs on the event loop — avoid nesting
            // an async runtime). A read failure degrades to `false`.
            let saved = read_saved_flag(&handle, id).unwrap_or(false);
            let _ = handle.emit(
                "history:row-toggled",
                serde_json::json!({ "id": id, "saved": saved }),
            );
        }
    });
}

/// Synchronous read of one row's `saved` flag (used by the Toggled bridge arm).
fn read_saved_flag(app: &AppHandle, id: i64) -> Option<bool> {
    let conn = open_db(app).ok()?;
    conn.query_row(
        "SELECT saved FROM transcription_history WHERE id = ?1",
        rusqlite::params![id],
        |row| row.get::<_, bool>(0),
    )
    .ok()
}
