//! Write/mutation operations for [`HistoryManager`].
//!
//! This sibling submodule adds an `impl HistoryManager` block holding the
//! create/update/delete operations plus small formatting helpers; it emits
//! [`HistoryUpdatePayload`] events for real-time frontend updates.

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Local, Utc};
use log::{debug, error};
use rusqlite::params;
use std::fs;
use std::path::{Component, Path, PathBuf};
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

    pub fn try_get_audio_file_path(&self, file_name: &str) -> Result<PathBuf> {
        resolve_history_audio_file_path(&self.recordings_dir, file_name)
    }

    pub fn get_audio_file_path(&self, file_name: &str) -> PathBuf {
        self.recordings_dir.join(file_name)
    }

    pub async fn delete_entry(&self, id: i64) -> Result<()> {
        let conn = self.get_connection()?;

        // Get the entry to find the file name
        if let Some(entry) = self.get_entry_by_id(id).await? {
            // Delete the audio file first
            match self.try_get_audio_file_path(&entry.file_name) {
                Ok(file_path) if file_path.exists() => {
                    if let Err(e) = fs::remove_file(&file_path) {
                        error!("Failed to delete audio file {}: {}", entry.file_name, e);
                        // Continue with database deletion even if file deletion fails
                    }
                }
                Ok(_) => {}
                Err(e) => {
                    error!(
                        "Skipping audio file deletion for invalid history file name {}: {}",
                        entry.file_name, e
                    );
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

fn resolve_history_audio_file_path(recordings_dir: &Path, file_name: &str) -> Result<PathBuf> {
    validate_history_audio_file_name(file_name)?;

    let candidate = recordings_dir.join(file_name);
    ensure_recording_path_is_contained(recordings_dir, &candidate)?;
    Ok(candidate)
}

fn validate_history_audio_file_name(file_name: &str) -> Result<()> {
    if file_name.is_empty() || file_name.trim().is_empty() {
        return Err(anyhow!("History audio file name must not be empty"));
    }
    if file_name != file_name.trim() || file_name.ends_with('.') {
        return Err(anyhow!(
            "History audio file name must not have leading or trailing whitespace or dots"
        ));
    }
    if file_name.contains('/') || file_name.contains('\\') {
        return Err(anyhow!(
            "History audio file name must be a basename without path separators"
        ));
    }
    if file_name
        .chars()
        .any(|ch| ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
    {
        return Err(anyhow!(
            "History audio file name contains unsupported characters"
        ));
    }

    let mut components = Path::new(file_name).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) => Ok(()),
        _ => Err(anyhow!(
            "History audio file name must be a single normal path component"
        )),
    }
}

fn ensure_recording_path_is_contained(recordings_dir: &Path, candidate: &Path) -> Result<()> {
    let recordings_dir = recordings_dir
        .canonicalize()
        .with_context(|| format!("Recordings directory does not exist: {:?}", recordings_dir))?;

    let candidate_to_check = match fs::symlink_metadata(candidate) {
        Ok(_) => candidate
            .canonicalize()
            .with_context(|| format!("Failed to resolve recording path: {:?}", candidate))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let parent = candidate
                .parent()
                .ok_or_else(|| anyhow!("History audio path has no parent directory"))?;
            let parent = parent.canonicalize().with_context(|| {
                format!("Recording parent directory does not exist: {:?}", parent)
            })?;
            let file_name = candidate
                .file_name()
                .ok_or_else(|| anyhow!("History audio path has no file name"))?;
            parent.join(file_name)
        }
        Err(e) => return Err(e).with_context(|| format!("Failed to inspect {:?}", candidate)),
    };

    if candidate_to_check.starts_with(&recordings_dir) {
        Ok(())
    } else {
        Err(anyhow!(
            "History audio path escapes the recordings directory"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_history_audio_file_path;
    use std::fs;
    #[cfg(any(unix, windows))]
    use std::io;
    use tempfile::TempDir;

    #[test]
    fn history_audio_path_accepts_basename_in_recordings_dir() {
        let temp_dir = TempDir::new().expect("temp dir");
        let expected = temp_dir.path().join("entry.wav");
        fs::write(&expected, b"RIFF").expect("write wav placeholder");

        let resolved =
            resolve_history_audio_file_path(temp_dir.path(), "entry.wav").expect("valid basename");

        assert_eq!(resolved, expected);
    }

    #[test]
    fn history_audio_path_allows_missing_basename_for_legacy_rows() {
        let temp_dir = TempDir::new().expect("temp dir");
        let expected = temp_dir.path().join("missing.wav");

        let resolved = resolve_history_audio_file_path(temp_dir.path(), "missing.wav")
            .expect("valid missing basename");

        assert_eq!(resolved, expected);
    }

    #[test]
    fn history_audio_path_rejects_traversal_and_nested_paths() {
        let temp_dir = TempDir::new().expect("temp dir");

        for file_name in [
            "",
            "   ",
            ".",
            "..",
            "../secret.wav",
            "..\\secret.wav",
            "nested/entry.wav",
            "nested\\entry.wav",
            "C:\\temp\\entry.wav",
            "C:entry.wav",
            "entry.wav:ads",
            "bad?.wav",
            " entry.wav",
            "entry.wav ",
            "entry.",
        ] {
            assert!(
                resolve_history_audio_file_path(temp_dir.path(), file_name).is_err(),
                "{file_name:?} should be rejected"
            );
        }
    }

    #[test]
    fn history_audio_path_rejects_existing_symlink_escape_when_supported() {
        let temp_dir = TempDir::new().expect("temp dir");
        let outside_dir = TempDir::new().expect("outside temp dir");
        let outside_file = outside_dir.path().join("outside.wav");
        fs::write(&outside_file, b"RIFF").expect("write outside wav placeholder");
        let link = temp_dir.path().join("entry.wav");

        if create_file_symlink(&outside_file, &link).is_err() {
            return;
        }

        assert!(resolve_history_audio_file_path(temp_dir.path(), "entry.wav").is_err());
    }

    #[test]
    fn history_audio_path_rejects_broken_symlink_when_supported() {
        let temp_dir = TempDir::new().expect("temp dir");
        let outside_dir = TempDir::new().expect("outside temp dir");
        let missing_target = outside_dir.path().join("missing.wav");
        let link = temp_dir.path().join("entry.wav");

        if create_file_symlink(&missing_target, &link).is_err() {
            return;
        }

        assert!(resolve_history_audio_file_path(temp_dir.path(), "entry.wav").is_err());
    }

    #[cfg(unix)]
    fn create_file_symlink(target: &std::path::Path, link: &std::path::Path) -> io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_file_symlink(target: &std::path::Path, link: &std::path::Path) -> io::Result<()> {
        std::os::windows::fs::symlink_file(target, link)
    }
}
