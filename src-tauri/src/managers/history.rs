//! Transcription and transform history persistence.
//!
//! Module root: holds the public data types, database migrations, the
//! [`HistoryManager`] struct definition, and the construction/DB-plumbing
//! `impl` block. The mutation/read/cleanup operations live in sibling
//! submodules ([`write`], [`read`], [`cleanup`]) that add further inherent
//! `impl HistoryManager` blocks; method resolution finds them regardless of
//! which file the block sits in. Keeping the public surface here preserves
//! every external path (`crate::managers::history::{HistoryManager,
//! HistoryEntry, HistoryUpdatePayload, TransformHistoryDbEntry,
//! PaginatedHistory}`) with zero re-export churn.

use anyhow::Result;
use log::{debug, info};
use rusqlite::Connection;
use rusqlite_migration::{M, Migrations};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;

mod cleanup;
mod read;
pub(crate) mod search;
mod write;

/// Database migrations for transcription and transform history.
/// Each migration is applied in order. The library tracks which migrations
/// have been applied using SQLite's user_version pragma.
///
/// Note: For users upgrading from tauri-plugin-sql, migrate_from_tauri_plugin_sql()
/// converts the old _sqlx_migrations table tracking to the user_version pragma,
/// ensuring migrations don't re-run on existing databases.
static MIGRATIONS: &[M<'_>] = &[
    M::up(
        "CREATE TABLE IF NOT EXISTS transcription_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_name TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            saved BOOLEAN NOT NULL DEFAULT 0,
            title TEXT NOT NULL,
            transcription_text TEXT NOT NULL
        );",
    ),
    M::up("ALTER TABLE transcription_history ADD COLUMN post_processed_text TEXT;"),
    M::up("ALTER TABLE transcription_history ADD COLUMN post_process_prompt TEXT;"),
    M::up(
        "ALTER TABLE transcription_history ADD COLUMN post_process_requested BOOLEAN NOT NULL DEFAULT 0;",
    ),
    // JSON telemetry of the LLM post-process pass — `{model, processingMs, tokens}`.
    // NULL when no LLM ran. Reshaped into the history footer's model/duration/speed chips.
    M::up("ALTER TABLE transcription_history ADD COLUMN llm_meta TEXT;"),
    M::up(
        "CREATE TABLE IF NOT EXISTS transform_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            title TEXT NOT NULL,
            before_text TEXT NOT NULL,
            after_text TEXT NOT NULL,
            source TEXT NOT NULL,
            llm_meta TEXT
        );",
    ),
    // Count of deterministic dictionary replacement-pair substitutions applied to
    // this transcription (the History "AI Impact" → dictionary-fixes stat). NULL
    // on rows written before this shipped and on entries where no replacement
    // pair fired.
    M::up("ALTER TABLE transcription_history ADD COLUMN dictionary_fixes INTEGER;"),
    M::up("ALTER TABLE transcription_history ADD COLUMN history_tag TEXT;"),
    M::up("ALTER TABLE transcription_history ADD COLUMN privacy_markers_json TEXT;"),
    // Identifier of the STT ("main") model that produced this transcription
    // (a catalog key like `tiny`, or a `provider:model` cloud-STT id). NULL on
    // rows written before this shipped and on renderer-driven manual adds where
    // no engine context is available.
    M::up("ALTER TABLE transcription_history ADD COLUMN stt_model TEXT;"),
    // Wall-clock time spent in the final speech-to-text decode/finalization
    // after recording stopped. NULL on rows written before this shipped and on
    // renderer-driven manual adds.
    M::up("ALTER TABLE transcription_history ADD COLUMN stt_processing_ms INTEGER;"),
    // USD billed for the cloud STT upload that produced this transcription.
    // NULL for local decodes and legacy rows. `stt_cost_is_estimate` marks
    // providers that report no billed amount (ElevenLabs), where the value is
    // derived from duration × published rate instead.
    M::up("ALTER TABLE transcription_history ADD COLUMN stt_cost_usd REAL;"),
    M::up(
        "ALTER TABLE transcription_history ADD COLUMN stt_cost_is_estimate BOOLEAN NOT NULL DEFAULT 0;",
    ),
    // Text-to-speech read-aloud runs, so the History tab can list TTS next to
    // STT with per-run cloud cost. `model` is the engine id (`<provider>:<id>`
    // for cloud, the local model key otherwise); `cost_usd` is NULL for local
    // synthesis and for cloud runs whose cost could not be resolved.
    M::up(
        "CREATE TABLE IF NOT EXISTS tts_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            title TEXT NOT NULL,
            text TEXT NOT NULL,
            model TEXT NOT NULL,
            voice TEXT,
            characters INTEGER NOT NULL,
            processing_ms INTEGER,
            cost_usd REAL,
            cost_is_estimate BOOLEAN NOT NULL DEFAULT 0
        );",
    ),
    // Basename of the synthesized audio saved under userData/recordings/ (WAV
    // for local f32 streams, MP3 for cloud mp3 streams), so read-aloud runs are
    // replayable from the History tab like STT recordings. NULL on rows written
    // before audio persistence shipped and on runs where capture failed.
    M::up("ALTER TABLE tts_history ADD COLUMN audio_file_name TEXT;"),
    M::up(
        "CREATE VIRTUAL TABLE transcription_fts USING fts5(
            transcription_text, post_processed_text,
            content='transcription_history', content_rowid='id',
            tokenize='unicode61 remove_diacritics 2', prefix='2 3');
        CREATE VIRTUAL TABLE transform_fts USING fts5(
            before_text, after_text,
            content='transform_history', content_rowid='id',
            tokenize='unicode61 remove_diacritics 2', prefix='2 3');
        CREATE VIRTUAL TABLE tts_fts USING fts5(
            text,
            content='tts_history', content_rowid='id',
            tokenize='unicode61 remove_diacritics 2', prefix='2 3');

        CREATE TRIGGER transcription_history_fts_ai AFTER INSERT ON transcription_history BEGIN
            INSERT INTO transcription_fts(rowid, transcription_text, post_processed_text)
            VALUES (new.id, new.transcription_text, coalesce(new.post_processed_text, ''));
        END;
        CREATE TRIGGER transcription_history_fts_ad AFTER DELETE ON transcription_history BEGIN
            INSERT INTO transcription_fts(transcription_fts, rowid, transcription_text, post_processed_text)
            VALUES ('delete', old.id, old.transcription_text, coalesce(old.post_processed_text, ''));
        END;
        CREATE TRIGGER transcription_history_fts_au AFTER UPDATE ON transcription_history BEGIN
            INSERT INTO transcription_fts(transcription_fts, rowid, transcription_text, post_processed_text)
            VALUES ('delete', old.id, old.transcription_text, coalesce(old.post_processed_text, ''));
            INSERT INTO transcription_fts(rowid, transcription_text, post_processed_text)
            VALUES (new.id, new.transcription_text, coalesce(new.post_processed_text, ''));
        END;

        CREATE TRIGGER transform_history_fts_ai AFTER INSERT ON transform_history BEGIN
            INSERT INTO transform_fts(rowid, before_text, after_text)
            VALUES (new.id, new.before_text, new.after_text);
        END;
        CREATE TRIGGER transform_history_fts_ad AFTER DELETE ON transform_history BEGIN
            INSERT INTO transform_fts(transform_fts, rowid, before_text, after_text)
            VALUES ('delete', old.id, old.before_text, old.after_text);
        END;
        CREATE TRIGGER transform_history_fts_au AFTER UPDATE ON transform_history BEGIN
            INSERT INTO transform_fts(transform_fts, rowid, before_text, after_text)
            VALUES ('delete', old.id, old.before_text, old.after_text);
            INSERT INTO transform_fts(rowid, before_text, after_text)
            VALUES (new.id, new.before_text, new.after_text);
        END;

        CREATE TRIGGER tts_history_fts_ai AFTER INSERT ON tts_history BEGIN
            INSERT INTO tts_fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER tts_history_fts_ad AFTER DELETE ON tts_history BEGIN
            INSERT INTO tts_fts(tts_fts, rowid, text) VALUES ('delete', old.id, old.text);
        END;
        CREATE TRIGGER tts_history_fts_au AFTER UPDATE ON tts_history BEGIN
            INSERT INTO tts_fts(tts_fts, rowid, text) VALUES ('delete', old.id, old.text);
            INSERT INTO tts_fts(rowid, text) VALUES (new.id, new.text);
        END;

        INSERT INTO transform_fts(rowid, before_text, after_text)
            SELECT id, before_text, after_text FROM transform_history;
        INSERT INTO tts_fts(rowid, text) SELECT id, text FROM tts_history;
        CREATE TABLE IF NOT EXISTS search_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
        INSERT INTO search_meta(key, value) VALUES
            ('fts_backfill_target', (SELECT coalesce(MAX(id), 0) FROM transcription_history)),
            ('fts_backfill_done_id', 0);",
    ),
    // Capture source of the transcription: NULL = mic dictation (every row
    // written before this shipped), 'listen' = a finished listen-mode session
    // (system-audio loopback, optionally mixed with the mic). Drives the
    // History UI's listen-session affordances (session post-processing).
    M::up("ALTER TABLE transcription_history ADD COLUMN source TEXT;"),
];

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
// Renderer-canonical paginated-history type is WinSTT `commands::history::PaginatedHistory`
// (camelCase, HistoryRow[]); suffix this legacy one's TS export to break the collision.
#[specta(rename = "PaginatedHistoryLegacy")]
pub struct PaginatedHistory {
    pub entries: Vec<HistoryEntry>,
    pub has_more: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(tag = "action")]
pub enum HistoryUpdatePayload {
    #[serde(rename = "added")]
    Added { entry: HistoryEntry },
    #[serde(rename = "updated")]
    Updated { entry: HistoryEntry },
    #[serde(rename = "deleted")]
    Deleted { id: i64 },
    #[serde(rename = "toggled")]
    Toggled { id: i64 },
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct HistoryEntry {
    pub id: i64,
    pub file_name: String,
    pub timestamp: i64,
    pub saved: bool,
    pub title: String,
    pub transcription_text: String,
    pub post_processed_text: Option<String>,
    pub post_process_prompt: Option<String>,
    pub post_process_requested: bool,
    /// JSON telemetry of the LLM pass (`{model, processingMs, tokens}`), or
    /// `None` when no LLM ran. Carried verbatim; parsed by the renderer-facing
    /// mapping in `winstt::commands::history`.
    pub llm_meta: Option<String>,
    /// Number of dictionary replacement-pair substitutions applied to this
    /// transcription. `None` for legacy rows (column added later); `Some(0)`
    /// when the pass ran but nothing matched. Summed into the History
    /// "AI Impact" → dictionary-fixes stat.
    pub dictionary_fixes: Option<i64>,
    /// Fixed classification tag for the transcription, when an LLM classified it.
    pub history_tag: Option<String>,
    /// JSON array of fixed privacy marker categories. Raw sensitive values are
    /// never stored here.
    pub privacy_markers_json: Option<String>,
    /// Identifier of the STT ("main") model that produced this transcription —
    /// a catalog key (e.g. `tiny`) or a `provider:model` cloud-STT id. `None`
    /// on legacy rows (column added later) and renderer-driven manual adds.
    pub stt_model: Option<String>,
    /// Wall-clock time spent by the STT model finalizing this transcription.
    /// `None` for legacy rows and renderer-driven manual adds.
    pub stt_processing_ms: Option<i64>,
    /// USD billed for the cloud STT upload. `None` for local decodes and rows
    /// written before cost tracking shipped.
    pub stt_cost_usd: Option<f64>,
    /// `true` when `stt_cost_usd` is a client-side estimate (providers that
    /// report no billed amount) rather than a provider-billed figure.
    pub stt_cost_is_estimate: bool,
    /// Where the transcription came from: `None` = mic dictation (also every
    /// legacy row), `Some("listen")` = a finished listen-mode session.
    pub source: Option<String>,
}

/// One text-to-speech read-aloud run, persisted so the History tab lists TTS
/// next to STT with per-run cloud cost.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct TtsHistoryDbEntry {
    pub id: i64,
    pub timestamp: i64,
    pub title: String,
    pub text: String,
    /// Engine id: `<provider>:<id>` for cloud synthesis, the local model key
    /// otherwise.
    pub model: String,
    pub voice: Option<String>,
    /// Characters synthesized (the unit most TTS providers bill on).
    pub characters: i64,
    pub processing_ms: Option<i64>,
    /// USD billed for the run. `None` for local synthesis and cloud runs whose
    /// cost could not be resolved.
    pub cost_usd: Option<f64>,
    pub cost_is_estimate: bool,
    /// Basename of the synthesized audio under the recordings dir (`.wav` or
    /// `.mp3`). `None` for legacy rows and runs whose audio wasn't captured.
    pub audio_file_name: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TransformHistoryDbEntry {
    pub id: i64,
    pub timestamp: i64,
    pub title: String,
    pub before_text: String,
    pub after_text: String,
    pub source: String,
    pub llm_meta: Option<String>,
}

pub struct HistoryManager {
    pub(super) app_handle: AppHandle,
    pub(super) recordings_dir: PathBuf,
    db_path: PathBuf,
}

impl HistoryManager {
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        // Create recordings directory in app data dir
        let app_data_dir = crate::portable::app_data_dir(app_handle)?;
        let recordings_dir = app_data_dir.join("recordings");
        let db_path = app_data_dir.join("history.db");

        // Ensure recordings directory exists
        if !recordings_dir.exists() {
            fs::create_dir_all(&recordings_dir)?;
            debug!("Created recordings directory: {:?}", recordings_dir);
        }

        let manager = Self {
            app_handle: app_handle.clone(),
            recordings_dir,
            db_path,
        };

        // Initialize database and run migrations synchronously
        manager.init_database()?;
        manager.spawn_fts_backfill();

        Ok(manager)
    }

    fn init_database(&self) -> Result<()> {
        debug!("Initializing database at {:?}", self.db_path);

        let mut conn = Connection::open(&self.db_path)?;

        // Handle migration from tauri-plugin-sql to rusqlite_migration
        // tauri-plugin-sql used _sqlx_migrations table, rusqlite_migration uses user_version pragma
        self.migrate_from_tauri_plugin_sql(&conn)?;

        // Create migrations object and run to latest version
        let migrations = Migrations::new(MIGRATIONS.to_vec());

        // Validate migrations in debug builds
        #[cfg(debug_assertions)]
        migrations.validate()?;

        // Get current version before migration
        let version_before: i32 =
            conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        debug!("Database version before migration: {}", version_before);

        // Apply any pending migrations
        migrations.to_latest(&mut conn)?;

        // Get version after migration
        let version_after: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;

        if version_after > version_before {
            info!(
                "Database migrated from version {} to {}",
                version_before, version_after
            );
        } else {
            debug!("Database already at latest version {}", version_after);
        }

        Ok(())
    }

    /// Migrate from tauri-plugin-sql's migration tracking to rusqlite_migration's.
    /// tauri-plugin-sql used a _sqlx_migrations table, while rusqlite_migration uses
    /// SQLite's user_version pragma. This function checks if the old system was in use
    /// and sets the user_version accordingly so migrations don't re-run.
    fn migrate_from_tauri_plugin_sql(&self, conn: &Connection) -> Result<()> {
        // Check if the old _sqlx_migrations table exists
        let has_sqlx_migrations: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !has_sqlx_migrations {
            return Ok(());
        }

        // Check current user_version
        let current_version: i32 =
            conn.pragma_query_value(None, "user_version", |row| row.get(0))?;

        if current_version > 0 {
            // Already migrated to rusqlite_migration system
            return Ok(());
        }

        // Get the highest version from the old migrations table
        let old_version: i32 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations WHERE success = 1",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        if old_version > 0 {
            info!(
                "Migrating from tauri-plugin-sql (version {}) to rusqlite_migration",
                old_version
            );

            // Set user_version to match the old migration state
            conn.pragma_update(None, "user_version", old_version)?;

            // Optionally drop the old migrations table (keeping it doesn't hurt)
            // conn.execute("DROP TABLE IF EXISTS _sqlx_migrations", [])?;

            info!(
                "Migration tracking converted: user_version set to {}",
                old_version
            );
        }

        Ok(())
    }

    pub(super) fn get_connection(&self) -> Result<Connection> {
        Ok(Connection::open(&self.db_path)?)
    }

    pub(crate) fn map_history_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<HistoryEntry> {
        Ok(HistoryEntry {
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
            stt_processing_ms: row.get("stt_processing_ms")?,
            stt_cost_usd: row.get("stt_cost_usd")?,
            stt_cost_is_estimate: row.get("stt_cost_is_estimate")?,
            source: row.get("source")?,
        })
    }

    pub(crate) fn map_tts_history_entry(
        row: &rusqlite::Row<'_>,
    ) -> rusqlite::Result<TtsHistoryDbEntry> {
        Ok(TtsHistoryDbEntry {
            id: row.get("id")?,
            timestamp: row.get("timestamp")?,
            title: row.get("title")?,
            text: row.get("text")?,
            model: row.get("model")?,
            voice: row.get("voice")?,
            characters: row.get("characters")?,
            processing_ms: row.get("processing_ms")?,
            cost_usd: row.get("cost_usd")?,
            cost_is_estimate: row.get("cost_is_estimate")?,
            audio_file_name: row.get("audio_file_name")?,
        })
    }

    pub(crate) fn map_transform_history_entry(
        row: &rusqlite::Row<'_>,
    ) -> rusqlite::Result<TransformHistoryDbEntry> {
        Ok(TransformHistoryDbEntry {
            id: row.get("id")?,
            timestamp: row.get("timestamp")?,
            title: row.get("title")?,
            before_text: row.get("before_text")?,
            after_text: row.get("after_text")?,
            source: row.get("source")?,
            llm_meta: row.get("llm_meta")?,
        })
    }

    pub fn recordings_dir(&self) -> &std::path::Path {
        &self.recordings_dir
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn migrated_conn() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open in-memory db");
        Migrations::new(MIGRATIONS.to_vec())
            .to_latest(&mut conn)
            .expect("apply migrations");
        conn
    }

    #[test]
    fn migrations_validate() {
        Migrations::new(MIGRATIONS.to_vec())
            .validate()
            .expect("migrations are internally consistent");
    }

    #[test]
    fn stt_cost_columns_roundtrip() {
        let conn = migrated_conn();
        conn.execute(
            "INSERT INTO transcription_history (
                file_name, timestamp, saved, title, transcription_text,
                stt_model, stt_cost_usd, stt_cost_is_estimate
            ) VALUES ('a.wav', 1, 0, 't', 'hello', 'openrouter:openai/whisper-1', 0.0002, 0)",
            [],
        )
        .expect("insert row");
        let entry = conn
            .query_row(
                "SELECT * FROM transcription_history WHERE id = 1",
                [],
                HistoryManager::map_history_entry,
            )
            .expect("map row");
        assert_eq!(entry.stt_cost_usd, Some(0.0002));
        assert!(!entry.stt_cost_is_estimate);
        // Legacy-shaped insert (no cost columns) maps to no-cost, not an error.
        conn.execute(
            "INSERT INTO transcription_history (
                file_name, timestamp, saved, title, transcription_text
            ) VALUES ('b.wav', 2, 0, 't', 'local')",
            [],
        )
        .expect("insert legacy row");
        let legacy = conn
            .query_row(
                "SELECT * FROM transcription_history WHERE id = 2",
                [],
                HistoryManager::map_history_entry,
            )
            .expect("map legacy row");
        assert_eq!(legacy.stt_cost_usd, None);
        assert!(!legacy.stt_cost_is_estimate);
    }

    #[test]
    fn tts_history_roundtrip() {
        let conn = migrated_conn();
        conn.execute(
            "INSERT INTO tts_history (
                timestamp, title, text, model, voice, characters,
                processing_ms, cost_usd, cost_is_estimate
            ) VALUES (5, 'run', 'read me', 'openrouter:hexgrad/kokoro-82m', 'af_alloy', 55, 1800, 0.0000341, 0)",
            [],
        )
        .expect("insert tts row");
        let entry = conn
            .query_row(
                "SELECT * FROM tts_history WHERE id = 1",
                [],
                HistoryManager::map_tts_history_entry,
            )
            .expect("map tts row");
        assert_eq!(entry.model, "openrouter:hexgrad/kokoro-82m");
        assert_eq!(entry.voice.as_deref(), Some("af_alloy"));
        assert_eq!(entry.characters, 55);
        assert_eq!(entry.processing_ms, Some(1800));
        assert_eq!(entry.cost_usd, Some(0.0000341));
        assert!(!entry.cost_is_estimate);
        // Legacy-shaped insert (no audio column value) maps to no audio.
        assert_eq!(entry.audio_file_name, None);
    }
}
