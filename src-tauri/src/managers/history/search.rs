use std::thread;
use std::time::Duration;

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};

use super::HistoryManager;

const BACKFILL_BATCH_SIZE: i64 = 1000;

impl HistoryManager {
    pub(super) fn spawn_fts_backfill(&self) {
        let db_path = self.db_path.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let result = (|| -> Result<()> {
                let mut conn = Connection::open(db_path)?;
                conn.busy_timeout(Duration::from_secs(5))?;
                while backfill_batch(&mut conn)? {
                    thread::sleep(Duration::from_millis(25));
                }
                Ok(())
            })();
            if let Err(error) = result {
                log::warn!("[history] FTS backfill failed: {error}");
            }
        });
    }
}

pub(crate) fn fts_ready(conn: &Connection) -> rusqlite::Result<bool> {
    let exists = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='transcription_fts')",
        [],
        |row| row.get::<_, bool>(0),
    )?;
    if !exists {
        return Ok(false);
    }
    let state = conn
        .query_row(
            "SELECT
                (SELECT value FROM search_meta WHERE key='fts_backfill_done_id'),
                (SELECT value FROM search_meta WHERE key='fts_backfill_target')",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?;
    Ok(matches!(state, Some((done, target)) if done >= target))
}

pub(crate) fn backfill_batch(conn: &mut Connection) -> rusqlite::Result<bool> {
    let (done, target) = conn.query_row(
        "SELECT
            (SELECT value FROM search_meta WHERE key='fts_backfill_done_id'),
            (SELECT value FROM search_meta WHERE key='fts_backfill_target')",
        [],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )?;
    if done >= target {
        return Ok(false);
    }
    let next = done.saturating_add(BACKFILL_BATCH_SIZE).min(target);
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT OR IGNORE INTO transcription_fts(rowid, transcription_text, post_processed_text)
         SELECT id, transcription_text, coalesce(post_processed_text, '')
         FROM transcription_history WHERE id > ?1 AND id <= ?2 ORDER BY id",
        params![done, next],
    )?;
    tx.execute(
        "UPDATE search_meta SET value=?1 WHERE key='fts_backfill_done_id'",
        [next],
    )?;
    tx.commit()?;
    Ok(next < target)
}

fn query_tokens(raw: &str) -> Vec<String> {
    raw.split(|character: char| !character.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(|token| token.replace('"', "\"\""))
        .collect()
}

pub(crate) fn fts_prefix_query(raw: &str) -> Option<String> {
    let tokens = query_tokens(raw);
    (!tokens.is_empty()).then(|| {
        tokens
            .iter()
            .map(|token| format!("\"{token}\"*"))
            .collect::<Vec<_>>()
            .join(" ")
    })
}

pub(crate) fn fts_relaxed_query(raw: &str) -> Option<String> {
    let tokens = query_tokens(raw);
    (!tokens.is_empty()).then(|| {
        tokens
            .iter()
            .map(|token| {
                let chars: Vec<char> = token.chars().collect();
                let end = if chars.len() >= 4 {
                    chars.len().saturating_sub(2).max(3)
                } else {
                    chars.len()
                };
                let prefix: String = chars[..end].iter().collect();
                format!("\"{prefix}\"*")
            })
            .collect::<Vec<_>>()
            .join(" OR ")
    })
}

pub(crate) fn like_pattern(raw: &str) -> String {
    let escaped = raw
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::managers::history::{MIGRATIONS, Migrations};

    fn migrated_conn() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open db");
        Migrations::new(MIGRATIONS.to_vec())
            .to_latest(&mut conn)
            .expect("migrate db");
        conn
    }

    #[test]
    fn bundled_sqlite_has_fts5_enabled() {
        let conn = Connection::open_in_memory().expect("open db");
        conn.execute("CREATE VIRTUAL TABLE fts5_probe USING fts5(content)", [])
            .expect("create FTS5 table");
    }

    #[test]
    fn fts_query_builders_escape_operators_and_handle_empty_input() {
        assert_eq!(
            fts_prefix_query("AND hello* (world)"),
            Some("\"AND\"* \"hello\"* \"world\"*".into())
        );
        assert_eq!(fts_relaxed_query("testing"), Some("\"testi\"*".into()));
        assert_eq!(fts_prefix_query("***"), None);
        assert_eq!(fts_prefix_query("你好"), Some("\"你好\"*".into()));
        assert_eq!(
            fts_prefix_query("NOT:near - (emoji😀)"),
            Some("\"NOT\"* \"near\"* \"emoji\"*".into())
        );
        assert_eq!(
            fts_relaxed_query("four longer"),
            Some("\"fou\"* OR \"long\"*".into())
        );
    }

    #[test]
    fn like_pattern_escapes_sql_wildcards() {
        assert_eq!(like_pattern(r"50%_off\now"), r"%50\%\_off\\now%");
    }

    #[test]
    fn triggers_keep_all_fts_tables_in_sync() {
        let conn = migrated_conn();
        conn.execute("INSERT INTO transcription_history(file_name,timestamp,title,transcription_text) VALUES('a',1,'t','hello world')", []).expect("insert transcription");
        conn.execute("INSERT INTO transform_history(timestamp,title,before_text,after_text,source) VALUES(1,'t','before','after','test')", []).expect("insert transform");
        conn.execute("INSERT INTO tts_history(timestamp,title,text,model,characters) VALUES(1,'t','spoken words','m',12)", []).expect("insert tts");
        let transcription: i64 = conn
            .query_row(
                "SELECT count(*) FROM transcription_fts WHERE transcription_fts MATCH '\"hello\"*'",
                [],
                |row| row.get(0),
            )
            .expect("match transcription");
        let transform: i64 = conn
            .query_row(
                "SELECT count(*) FROM transform_fts WHERE transform_fts MATCH '\"after\"*'",
                [],
                |row| row.get(0),
            )
            .expect("match transform");
        let tts: i64 = conn
            .query_row(
                "SELECT count(*) FROM tts_fts WHERE tts_fts MATCH '\"spoken\"*'",
                [],
                |row| row.get(0),
            )
            .expect("match tts");
        assert_eq!((transcription, transform, tts), (1, 1, 1));

        conn.execute(
            "UPDATE transcription_history SET post_processed_text='clean result' WHERE id=1",
            [],
        )
        .expect("update transcription");
        let updated: i64 = conn
            .query_row(
                "SELECT count(*) FROM transcription_fts WHERE transcription_fts MATCH '\"clean\"*'",
                [],
                |row| row.get(0),
            )
            .expect("match update");
        assert_eq!(updated, 1);

        conn.execute(
            "UPDATE transform_history SET after_text='changed transform' WHERE id=1",
            [],
        )
        .expect("update transform");
        conn.execute(
            "UPDATE tts_history SET text='changed speech' WHERE id=1",
            [],
        )
        .expect("update tts");
        let changed_transform: i64 = conn
            .query_row(
                "SELECT count(*) FROM transform_fts WHERE transform_fts MATCH '\"changed\"*'",
                [],
                |row| row.get(0),
            )
            .expect("match transform update");
        let changed_tts: i64 = conn
            .query_row(
                "SELECT count(*) FROM tts_fts WHERE tts_fts MATCH '\"changed\"*'",
                [],
                |row| row.get(0),
            )
            .expect("match tts update");
        assert_eq!((changed_transform, changed_tts), (1, 1));

        conn.execute("DELETE FROM transcription_history WHERE id=1", [])
            .expect("delete transcription");
        conn.execute("DELETE FROM transform_history WHERE id=1", [])
            .expect("delete transform");
        conn.execute("DELETE FROM tts_history WHERE id=1", [])
            .expect("delete tts");
        let deleted: i64 = conn
            .query_row(
                "SELECT count(*) FROM transcription_fts WHERE transcription_fts MATCH '\"clean\"*'",
                [],
                |row| row.get(0),
            )
            .expect("match delete");
        assert_eq!(deleted, 0);
        let deleted_transform: i64 = conn
            .query_row(
                "SELECT count(*) FROM transform_fts WHERE transform_fts MATCH '\"changed\"*'",
                [],
                |row| row.get(0),
            )
            .expect("match transform delete");
        let deleted_tts: i64 = conn
            .query_row(
                "SELECT count(*) FROM tts_fts WHERE tts_fts MATCH '\"changed\"*'",
                [],
                |row| row.get(0),
            )
            .expect("match tts delete");
        assert_eq!((deleted_transform, deleted_tts), (0, 0));
    }

    #[test]
    fn backfill_batches_converge_and_preserve_triggered_rows() {
        let mut conn = migrated_conn();
        conn.execute("INSERT INTO transcription_history(file_name,timestamp,title,transcription_text) VALUES('new',1,'t','trigger row')", []).expect("trigger insert");
        conn.execute(
            "UPDATE search_meta SET value=1 WHERE key='fts_backfill_target'",
            [],
        )
        .expect("set target");
        assert!(!backfill_batch(&mut conn).expect("backfill"));
        assert!(fts_ready(&conn).expect("ready"));
        let count: i64 = conn.query_row("SELECT count(*) FROM transcription_fts WHERE transcription_fts MATCH '\"trigger\"*'", [], |row| row.get(0)).expect("count");
        assert_eq!(count, 1);
    }
}
