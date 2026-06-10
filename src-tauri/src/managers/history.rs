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
use rusqlite_migration::{Migrations, M};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;

mod cleanup;
mod read;
mod write;

/// Database migrations for transcription and transform history.
/// Each migration is applied in order. The library tracks which migrations
/// have been applied using SQLite's user_version pragma.
///
/// Note: For users upgrading from tauri-plugin-sql, migrate_from_tauri_plugin_sql()
/// converts the old _sqlx_migrations table tracking to the user_version pragma,
/// ensuring migrations don't re-run on existing databases.
static MIGRATIONS: &[M] = &[
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
    M::up("ALTER TABLE transcription_history ADD COLUMN post_process_requested BOOLEAN NOT NULL DEFAULT 0;"),
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

        Ok(manager)
    }

    fn init_database(&self) -> Result<()> {
        info!("Initializing database at {:?}", self.db_path);

        let mut conn = Connection::open(&self.db_path)?;

        // Handle migration from tauri-plugin-sql to rusqlite_migration
        // tauri-plugin-sql used _sqlx_migrations table, rusqlite_migration uses user_version pragma
        self.migrate_from_tauri_plugin_sql(&conn)?;

        // Create migrations object and run to latest version
        let migrations = Migrations::new(MIGRATIONS.to_vec());

        // Validate migrations in debug builds
        #[cfg(debug_assertions)]
        migrations.validate().expect("Invalid migrations");

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

    pub(super) fn map_history_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<HistoryEntry> {
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
        })
    }

    pub(super) fn map_transform_history_entry(
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
