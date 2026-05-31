// PORT IMPL — WU-10 (app/PORT/10_frontend_port_plan.md §6 WU-10 + §1b History rows).
//
// History command surface for the WinSTT renderer. The WinSTT renderer drives
// history through TWO disjoint channel groups (both routed by the WU-0 adapter,
// `shared/api/electron-tauri-adapter.ts`):
//
//   1. The dedicated `views/history` window + the `entities/transcription-history`
//      client → the SQLite-store channels:  history:list / add / delete-row /
//      toggle / recent / load-audio-by-row  + the  history:row-{added,deleted,
//      toggled}  events. Shape = `HistoryEntry` (NUMBER id, `fileName`,
//      `transcriptionText`, `postProcessedText`, `saved`, `title`, epoch-SECONDS
//      `timestamp`).
//
//   2. The settings panel + karaoke `HistoryTable` (word-timestamp playback) via
//      `shared/api/ipc-client.ts` → the legacy electron-store channels:
//      history:get-all / clear / delete / load-audio / align-audio  +  the
//      history:{added,deleted}  events. Shape = `TranscriptionHistoryEntry`
//      (STRING id, `text`, `wordCount`, `durationMs`, `audioFilePath?`,
//      `originalText?`, `llmModel?`, epoch-MILLIS `timestamp`).
//
// Per the plan we back BOTH surfaces with Handy's single `managers::history::
// HistoryManager` (SQLite) and reshape its rows into each renderer shape, so
// there is one source of truth on disk. Every payload here is camelCase (matches
// the verbatim-ported renderer) and derives `specta::Type` for tauri-specta
// bindings. NEW FILE — registration (collect_commands![] + the event bridge call)
// is reported for lib.rs in the WU output, not edited here (HARD RULE).
//
// Event delivery: Handy's `HistoryManager` already emits the collected
// `HistoryUpdatePayload` (tag="action") on save/delete/toggle from `actions.rs`
// (Handy-owned, not editable). `install_history_event_bridge` re-emits each of
// those as the WinSTT-shaped plain events the adapter listens for, so the reused
// renderer's `onTranscriptionHistoryAdded` / `HISTORY_ROW_*` listeners fire
// unchanged. The orchestrator calls it once in `initialize_core_logic`.

use std::path::PathBuf;
use std::sync::Arc;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_specta::Event;

use crate::managers::history::{HistoryEntry as DbHistoryEntry, HistoryManager, HistoryUpdatePayload};

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

/// Effective user-facing text: the post-processed (LLM-cleaned) text when present
/// and non-empty, else the raw transcript. Mirrors the renderer's `effectiveText`
/// + the legacy store's `shouldKeepOriginalText` policy.
fn effective_text(entry: &DbHistoryEntry) -> &str {
    match entry.post_processed_text.as_deref() {
        Some(cleaned) if !cleaned.trim().is_empty() => cleaned,
        _ => &entry.transcription_text,
    }
}

/// Map a Handy DB row → the legacy `TranscriptionHistoryEntry` shape (STRING id,
/// MILLIS timestamp). `audioFilePath` is set only when the WAV is on disk so the
/// renderer renders the play button exactly when playback can succeed.
fn to_transcription_entry(mgr: &HistoryManager, entry: &DbHistoryEntry) -> TranscriptionHistoryEntry {
    let text = effective_text(entry).to_string();
    // `originalText` enables "Copy Original" — surface it whenever the LLM ran and
    // produced post-processed text (matches `shouldKeepOriginalText` with llmRan).
    let original_text = match entry.post_processed_text.as_deref() {
        Some(cleaned) if !cleaned.trim().is_empty() => Some(entry.transcription_text.clone()),
        _ => None,
    };
    let audio_file_path = if entry.file_name.is_empty() {
        None
    } else {
        let path = mgr.get_audio_file_path(&entry.file_name);
        if path.exists() {
            path.to_str().map(|s| s.to_string())
        } else {
            None
        }
    };
    TranscriptionHistoryEntry {
        id: entry.id.to_string(),
        word_count: count_words(&text),
        text,
        // Handy stores `Utc::now().timestamp()` (SECONDS); the legacy renderer
        // shape is MILLIS (`new Date(ms)`), so scale up.
        timestamp: entry.timestamp.saturating_mul(1000),
        duration_ms: 0,
        audio_file_path,
        original_text,
        // The DB has no LLM-model column; `post_process_prompt` is the closest
        // signal but isn't the model id, so omit (renderer hides the chip).
        llm_model: None,
    }
}

/// Map a Handy DB row → the entity `HistoryRow` shape (NUMBER id, SECONDS
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
    }
}

/// Standard RFC4648 base64 (with `=` padding). Inlined to avoid pulling the
/// `base64` crate (not in Cargo.toml; `00_cargo_additions.md` doesn't list it) —
/// the only base64 in-tree is `families.rs`'s decoder, so we provide the encoder
/// here. The output drives an `<audio src="data:audio/wav;base64,...">`.
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[((n >> 6) & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[(n & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn wav_to_data_uri(path: &PathBuf) -> Option<String> {
    if !path.exists() {
        return None;
    }
    match std::fs::read(path) {
        Ok(bytes) => {
            let b64 = base64_encode(&bytes);
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
    let conn = open_db(&app)?;
    let lim = limit.clamp(1, 100);
    let off = offset.max(0);
    let fetch = lim + 1;
    let mut stmt = conn
        .prepare(
            "SELECT id, file_name, timestamp, saved, title, transcription_text, \
             post_processed_text, post_process_prompt, post_process_requested \
             FROM transcription_history ORDER BY id DESC LIMIT ?1 OFFSET ?2",
        )
        .map_err(|e| e.to_string())?;
    let mut entries: Vec<DbHistoryEntry> = stmt
        .query_map(rusqlite::params![fetch, off], map_db_row)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
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
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, file_name, timestamp, saved, title, transcription_text, \
             post_processed_text, post_process_prompt, post_process_requested \
             FROM transcription_history ORDER BY id DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<DbHistoryEntry> = stmt
        .query_map(rusqlite::params![n], map_db_row)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
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
        )
        .map_err(|e| e.to_string())?;
    Ok(Some(to_history_row(&entry)))
}

// ── Group 2: legacy electron-store channels (settings panel + karaoke table) ────

/// `history:get-all` — every row reshaped to the legacy `TranscriptionHistoryEntry`
/// shape (STRING id, MILLIS timestamp). Oldest-first to match the legacy
/// electron-store's append order; the renderer's `HistoryTable` reverses it.
#[tauri::command]
#[specta::specta]
pub async fn history_get_all(
    app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
) -> Result<Vec<TranscriptionHistoryEntry>, String> {
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, file_name, timestamp, saved, title, transcription_text, \
             post_processed_text, post_process_prompt, post_process_requested \
             FROM transcription_history ORDER BY id ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<DbHistoryEntry> = stmt
        .query_map([], map_db_row)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let mgr = history_manager.inner().as_ref();
    Ok(rows
        .iter()
        .map(|e| to_transcription_entry(mgr, e))
        .collect())
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
    let ids: Vec<i64> = {
        let conn = open_db(&app)?;
        let mut stmt = conn
            .prepare("SELECT id FROM transcription_history ORDER BY id ASC")
            .map_err(|e| e.to_string())?;
        let collected = stmt
            .query_map([], |row| row.get::<_, i64>(0))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        collected
    };
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

// ── Event bridge: collected HistoryUpdatePayload → WinSTT plain events ───────────

/// Re-emit Handy's collected `HistoryUpdatePayload` (fired by `actions.rs` /
/// `HistoryManager` on save / update / delete / toggle) as the WinSTT-shaped plain
/// events the WU-0 adapter listens for:
///   - `Added`   → `history:added` (legacy `TranscriptionHistoryEntry`)
///               + `history:row-added` (entity `HistoryRow`)
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
            let _ = handle.emit("history:deleted", serde_json::json!({ "id": id.to_string() }));
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
