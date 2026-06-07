//! Retention/cleanup logic for [`HistoryManager`].
//!
//! This sibling submodule adds an `impl HistoryManager` block holding the
//! retention/cleanup operations (count- and time-based) plus the free
//! [`clamp_history_limit`] helper and the unit tests that exercise the
//! read/cleanup helpers.

use anyhow::Result;
use chrono::Utc;
use log::{debug, error};
use rusqlite::params;
use std::fs;

use super::HistoryManager;
use crate::winstt::settings_schema::RecordingRetention;

impl HistoryManager {
    pub fn cleanup_old_entries(&self) -> Result<()> {
        let settings = crate::winstt::commands::settings::read_settings_raw(&self.app_handle);
        let retention_period = settings.general.recording_retention;

        match retention_period {
            RecordingRetention::Never => {
                // Don't delete anything
                Ok(())
            }
            RecordingRetention::Cap => {
                let limit = clamp_history_limit(settings.general.history_max_entries);
                self.cleanup_by_count(limit)?;
                self.cleanup_transforms_by_count(limit)
            }
            _ => {
                // Use time-based logic
                self.cleanup_by_time(retention_period)?;
                self.cleanup_transforms_by_time(retention_period)
            }
        }
    }

    fn delete_entries_and_files(&self, entries: &[(i64, String)]) -> Result<usize> {
        if entries.is_empty() {
            return Ok(0);
        }

        let conn = self.get_connection()?;
        let mut deleted_count = 0;

        for (id, file_name) in entries {
            // Delete database entry
            conn.execute(
                "DELETE FROM transcription_history WHERE id = ?1",
                params![id],
            )?;

            // Delete WAV file
            let file_path = self.recordings_dir.join(file_name);
            if file_path.exists() {
                if let Err(e) = fs::remove_file(&file_path) {
                    error!("Failed to delete WAV file {}: {}", file_name, e);
                } else {
                    debug!("Deleted old WAV file: {}", file_name);
                    deleted_count += 1;
                }
            }
        }

        Ok(deleted_count)
    }

    fn cleanup_by_count(&self, limit: usize) -> Result<()> {
        let conn = self.get_connection()?;

        // Get all entries that are not saved, ordered by timestamp desc
        let mut stmt = conn.prepare(
            "SELECT id, file_name FROM transcription_history WHERE saved = 0 ORDER BY timestamp DESC"
        )?;

        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>("id")?, row.get::<_, String>("file_name")?))
        })?;

        let mut entries: Vec<(i64, String)> = Vec::new();
        for row in rows {
            entries.push(row?);
        }

        if entries.len() > limit {
            let entries_to_delete = &entries[limit..];
            let deleted_count = self.delete_entries_and_files(entries_to_delete)?;

            if deleted_count > 0 {
                debug!("Cleaned up {} old history entries by count", deleted_count);
            }
        }

        Ok(())
    }

    fn delete_transform_entries_by_ids(&self, ids: &[i64]) -> Result<usize> {
        if ids.is_empty() {
            return Ok(0);
        }

        let conn = self.get_connection()?;
        let mut deleted_count = 0;
        for id in ids {
            let deleted =
                conn.execute("DELETE FROM transform_history WHERE id = ?1", params![id])?;
            deleted_count += deleted;
        }
        Ok(deleted_count)
    }

    fn cleanup_transforms_by_count(&self, limit: usize) -> Result<()> {
        let conn = self.get_connection()?;
        let mut stmt =
            conn.prepare("SELECT id FROM transform_history ORDER BY timestamp DESC, id DESC")?;

        let rows = stmt.query_map([], |row| row.get::<_, i64>("id"))?;

        let mut ids: Vec<i64> = Vec::new();
        for row in rows {
            ids.push(row?);
        }

        if ids.len() > limit {
            let ids_to_delete = &ids[limit..];
            let deleted_count = self.delete_transform_entries_by_ids(ids_to_delete)?;

            if deleted_count > 0 {
                debug!(
                    "Cleaned up {} old transform history entries by count",
                    deleted_count
                );
            }
        }

        Ok(())
    }

    fn cleanup_by_time(&self, retention_period: RecordingRetention) -> Result<()> {
        let conn = self.get_connection()?;

        // Calculate cutoff timestamp (current time minus retention period)
        let now = Utc::now().timestamp();
        let cutoff_timestamp = match retention_period {
            RecordingRetention::Days3 => now - (3 * 24 * 60 * 60), // 3 days in seconds
            RecordingRetention::Weeks2 => now - (2 * 7 * 24 * 60 * 60), // 2 weeks in seconds
            RecordingRetention::Months3 => now - (3 * 30 * 24 * 60 * 60), // 3 months in seconds (approximate)
            // Non-time variants are pre-filtered by `cleanup_old_entries`; handle them
            // explicitly (instead of `_ => unreachable!()`) so a new retention variant
            // is a compile error here rather than a runtime panic.
            RecordingRetention::Never | RecordingRetention::Cap => return Ok(()),
        };

        // Get all unsaved entries older than the cutoff timestamp
        let mut stmt = conn.prepare(
            "SELECT id, file_name FROM transcription_history WHERE saved = 0 AND timestamp < ?1",
        )?;

        let rows = stmt.query_map(params![cutoff_timestamp], |row| {
            Ok((row.get::<_, i64>("id")?, row.get::<_, String>("file_name")?))
        })?;

        let mut entries_to_delete: Vec<(i64, String)> = Vec::new();
        for row in rows {
            entries_to_delete.push(row?);
        }

        let deleted_count = self.delete_entries_and_files(&entries_to_delete)?;

        if deleted_count > 0 {
            debug!(
                "Cleaned up {} old history entries based on retention period",
                deleted_count
            );
        }

        Ok(())
    }

    fn cleanup_transforms_by_time(&self, retention_period: RecordingRetention) -> Result<()> {
        let now = Utc::now().timestamp();
        let cutoff_timestamp = match retention_period {
            RecordingRetention::Days3 => now - (3 * 24 * 60 * 60),
            RecordingRetention::Weeks2 => now - (2 * 7 * 24 * 60 * 60),
            RecordingRetention::Months3 => now - (3 * 30 * 24 * 60 * 60),
            RecordingRetention::Never | RecordingRetention::Cap => return Ok(()),
        };

        let conn = self.get_connection()?;
        let mut stmt = conn.prepare("SELECT id FROM transform_history WHERE timestamp < ?1")?;
        let rows = stmt.query_map(params![cutoff_timestamp], |row| row.get::<_, i64>("id"))?;

        let mut ids_to_delete: Vec<i64> = Vec::new();
        for row in rows {
            ids_to_delete.push(row?);
        }

        let deleted_count = self.delete_transform_entries_by_ids(&ids_to_delete)?;

        if deleted_count > 0 {
            debug!(
                "Cleaned up {} old transform history entries based on retention period",
                deleted_count
            );
        }

        Ok(())
    }
}

fn clamp_history_limit(limit: i64) -> usize {
    limit.clamp(10, 10_000) as usize
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::{params, Connection};

    fn setup_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "CREATE TABLE transcription_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_name TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                saved BOOLEAN NOT NULL DEFAULT 0,
                title TEXT NOT NULL,
                transcription_text TEXT NOT NULL,
                post_processed_text TEXT,
                post_process_prompt TEXT,
                post_process_requested BOOLEAN NOT NULL DEFAULT 0,
                llm_meta TEXT,
                dictionary_fixes INTEGER,
                history_tag TEXT,
                privacy_markers_json TEXT
            );",
        )
        .expect("create transcription_history table");
        conn
    }

    fn insert_entry(conn: &Connection, timestamp: i64, text: &str, post_processed: Option<&str>) {
        conn.execute(
            "INSERT INTO transcription_history (
                file_name,
                timestamp,
                saved,
                title,
                transcription_text,
                post_processed_text,
                post_process_prompt,
                post_process_requested
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                format!("handy-{}.wav", timestamp),
                timestamp,
                false,
                format!("Recording {}", timestamp),
                text,
                post_processed,
                Option::<String>::None,
                false,
            ],
        )
        .expect("insert history entry");
    }

    #[test]
    fn get_latest_entry_returns_none_when_empty() {
        let conn = setup_conn();
        let entry = HistoryManager::get_latest_entry_with_conn(&conn).expect("fetch latest entry");
        assert!(entry.is_none());
    }

    #[test]
    fn get_latest_entry_returns_newest_entry() {
        let conn = setup_conn();
        insert_entry(&conn, 100, "first", None);
        insert_entry(&conn, 200, "second", Some("processed"));

        let entry = HistoryManager::get_latest_entry_with_conn(&conn)
            .expect("fetch latest entry")
            .expect("entry exists");

        assert_eq!(entry.timestamp, 200);
        assert_eq!(entry.transcription_text, "second");
        assert_eq!(entry.post_processed_text.as_deref(), Some("processed"));
    }

    #[test]
    fn get_latest_completed_entry_skips_empty_entries() {
        let conn = setup_conn();
        insert_entry(&conn, 100, "completed", None);
        insert_entry(&conn, 200, "", None);

        let entry = HistoryManager::get_latest_completed_entry_with_conn(&conn)
            .expect("fetch latest completed entry")
            .expect("completed entry exists");

        assert_eq!(entry.timestamp, 100);
        assert_eq!(entry.transcription_text, "completed");
    }

    #[test]
    fn clamp_history_limit_matches_winstt_schema_bounds() {
        assert_eq!(clamp_history_limit(1), 10);
        assert_eq!(clamp_history_limit(1000), 1000);
        assert_eq!(clamp_history_limit(50_000), 10_000);
    }
}
