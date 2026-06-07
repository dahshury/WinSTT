//! Write/mutation operations for [`HistoryManager`].
//!
//! This sibling submodule adds an `impl HistoryManager` block holding the
//! create/update/delete operations plus small formatting helpers; it emits
//! [`HistoryUpdatePayload`] events for real-time frontend updates.

use anyhow::{anyhow, Result};
use chrono::{DateTime, Local, Utc};
use log::{debug, error};
use rusqlite::params;
use std::fs;
use std::path::PathBuf;
use tauri_specta::Event;

use super::{HistoryEntry, HistoryManager, HistoryUpdatePayload, TransformHistoryDbEntry};

impl HistoryManager {
    /// Save a new history entry to the database.
    /// The WAV file should already have been written to the recordings directory.
    #[allow(clippy::too_many_arguments)]
    pub fn save_entry(
        &self,
        file_name: String,
        transcription_text: String,
        post_process_requested: bool,
        post_processed_text: Option<String>,
        post_process_prompt: Option<String>,
        llm_meta: Option<String>,
        dictionary_fixes: Option<i64>,
        history_tag: Option<String>,
        privacy_markers_json: Option<String>,
        stt_model: Option<String>,
    ) -> Result<HistoryEntry> {
        let timestamp = Utc::now().timestamp();
        let title = self.format_timestamp_title(timestamp);

        let conn = self.get_connection()?;
        conn.execute(
            "INSERT INTO transcription_history (
                file_name,
                timestamp,
                saved,
                title,
                transcription_text,
                post_processed_text,
                post_process_prompt,
                post_process_requested,
                llm_meta,
                dictionary_fixes,
                history_tag,
                privacy_markers_json,
                stt_model
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                &file_name,
                timestamp,
                false,
                &title,
                &transcription_text,
                &post_processed_text,
                &post_process_prompt,
                post_process_requested,
                &llm_meta,
                dictionary_fixes,
                &history_tag,
                &privacy_markers_json,
                &stt_model,
            ],
        )?;

        let entry = HistoryEntry {
            id: conn.last_insert_rowid(),
            file_name,
            timestamp,
            saved: false,
            title,
            transcription_text,
            post_processed_text,
            post_process_prompt,
            post_process_requested,
            llm_meta,
            dictionary_fixes,
            history_tag,
            privacy_markers_json,
            stt_model,
        };

        debug!("Saved history entry with id {}", entry.id);

        self.cleanup_old_entries()?;

        // Emit typed event for real-time frontend updates
        if let Err(e) = (HistoryUpdatePayload::Added {
            entry: entry.clone(),
        })
        .emit(&self.app_handle)
        {
            error!("Failed to emit history-updated event: {}", e);
        }

        Ok(entry)
    }

    pub fn save_transform_entry(
        &self,
        before_text: String,
        after_text: String,
        source: String,
        llm_meta: Option<String>,
    ) -> Result<TransformHistoryDbEntry> {
        let timestamp = Utc::now().timestamp();
        let title = self.format_timestamp_title(timestamp);

        let conn = self.get_connection()?;
        conn.execute(
            "INSERT INTO transform_history (
                timestamp,
                title,
                before_text,
                after_text,
                source,
                llm_meta
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                timestamp,
                &title,
                &before_text,
                &after_text,
                &source,
                &llm_meta,
            ],
        )?;

        let entry = TransformHistoryDbEntry {
            id: conn.last_insert_rowid(),
            timestamp,
            title,
            before_text,
            after_text,
            source,
            llm_meta,
        };

        debug!("Saved transform history entry with id {}", entry.id);

        self.cleanup_old_entries()?;

        Ok(entry)
    }

    /// Update an existing history entry with new transcription results (used by retry).
    #[allow(clippy::too_many_arguments)]
    pub fn update_transcription(
        &self,
        id: i64,
        transcription_text: String,
        post_processed_text: Option<String>,
        post_process_prompt: Option<String>,
        llm_meta: Option<String>,
        dictionary_fixes: Option<i64>,
        history_tag: Option<String>,
        privacy_markers_json: Option<String>,
    ) -> Result<HistoryEntry> {
        let conn = self.get_connection()?;
        let updated = conn.execute(
            "UPDATE transcription_history
             SET transcription_text = ?1,
                 post_processed_text = ?2,
                 post_process_prompt = ?3,
                 llm_meta = ?4,
                 dictionary_fixes = ?5,
                 history_tag = ?6,
                 privacy_markers_json = ?7
             WHERE id = ?8",
            params![
                transcription_text,
                post_processed_text,
                post_process_prompt,
                llm_meta,
                dictionary_fixes,
                history_tag,
                privacy_markers_json,
                id
            ],
        )?;

        if updated == 0 {
            return Err(anyhow!("History entry {} not found", id));
        }

        let entry = conn
            .query_row(
                "SELECT id, file_name, timestamp, saved, title, transcription_text, post_processed_text, post_process_prompt, post_process_requested, llm_meta, dictionary_fixes, history_tag, privacy_markers_json, stt_model
                 FROM transcription_history WHERE id = ?1",
                params![id],
                Self::map_history_entry,
            )?;

        debug!("Updated transcription for history entry {}", id);

        if let Err(e) = (HistoryUpdatePayload::Updated {
            entry: entry.clone(),
        })
        .emit(&self.app_handle)
        {
            error!("Failed to emit history-updated event: {}", e);
        }

        Ok(entry)
    }

    pub async fn toggle_saved_status(&self, id: i64) -> Result<()> {
        let conn = self.get_connection()?;

        // Get current saved status
        let current_saved: bool = conn.query_row(
            "SELECT saved FROM transcription_history WHERE id = ?1",
            params![id],
            |row| row.get("saved"),
        )?;

        let new_saved = !current_saved;

        conn.execute(
            "UPDATE transcription_history SET saved = ?1 WHERE id = ?2",
            params![new_saved, id],
        )?;

        debug!("Toggled saved status for entry {}: {}", id, new_saved);

        // Emit history updated event
        if let Err(e) = (HistoryUpdatePayload::Toggled { id }).emit(&self.app_handle) {
            error!("Failed to emit history-updated event: {}", e);
        }

        Ok(())
    }

    pub fn get_audio_file_path(&self, file_name: &str) -> PathBuf {
        self.recordings_dir.join(file_name)
    }

    pub async fn delete_entry(&self, id: i64) -> Result<()> {
        let conn = self.get_connection()?;

        // Get the entry to find the file name
        if let Some(entry) = self.get_entry_by_id(id).await? {
            // Delete the audio file first
            let file_path = self.get_audio_file_path(&entry.file_name);
            if file_path.exists() {
                if let Err(e) = fs::remove_file(&file_path) {
                    error!("Failed to delete audio file {}: {}", entry.file_name, e);
                    // Continue with database deletion even if file deletion fails
                }
            }
        }

        // Delete from database
        conn.execute(
            "DELETE FROM transcription_history WHERE id = ?1",
            params![id],
        )?;

        debug!("Deleted history entry with id: {}", id);

        // Emit history updated event
        if let Err(e) = (HistoryUpdatePayload::Deleted { id }).emit(&self.app_handle) {
            error!("Failed to emit history-updated event: {}", e);
        }

        Ok(())
    }

    pub fn delete_transform_entry(&self, id: i64) -> Result<bool> {
        let conn = self.get_connection()?;
        let deleted = conn.execute("DELETE FROM transform_history WHERE id = ?1", params![id])?;
        if deleted > 0 {
            debug!("Deleted transform history entry with id: {}", id);
        }
        Ok(deleted > 0)
    }

    fn format_timestamp_title(&self, timestamp: i64) -> String {
        if let Some(utc_datetime) = DateTime::from_timestamp(timestamp, 0) {
            // Convert UTC to local timezone
            let local_datetime = utc_datetime.with_timezone(&Local);
            local_datetime.format("%B %e, %Y - %l:%M%p").to_string()
        } else {
            format!("Recording {}", timestamp)
        }
    }
}
