// Per-provider cloud latency metrics.
//
// Every cloud round-trip (STT upload, TTS synthesis, voice/subscription
// catalog fetches, LLM chat, credential verify) records one sample keyed by
// `(provider, operation)`. Aggregates live in a process-wide map (same
// OnceLock+Mutex idiom as `observability`) and are surfaced two ways:
//   - `diag_cloud_metrics` command → the diagnostics UI / support bundle.
//   - one structured `[cloud-metrics]` log line per sample, greppable in
//     winstt.log next to the existing `[stt-ui]` timings.
//
// This is a latency/outcome ledger, not an error timeline — failures still go
// through `observability::IssueBuilder` / `emit_cloud_failure` for toasts.

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::winstt::sync_ext::MutexExt;

/// Rolling aggregate for one `(provider, operation)` pair.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CloudOpStats {
    pub provider: String,
    pub operation: String,
    pub count: u64,
    pub error_count: u64,
    pub last_ms: u64,
    pub avg_ms: f64,
    pub min_ms: u64,
    pub max_ms: u64,
    /// Unix ms of the most recent sample.
    pub last_at_ms: u64,
    /// Most recent failure message (trimmed), if any sample failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

fn store() -> &'static Mutex<BTreeMap<(String, String), CloudOpStats>> {
    static STORE: OnceLock<Mutex<BTreeMap<(String, String), CloudOpStats>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

const MAX_ERROR_LEN: usize = 200;

/// Record one cloud round-trip sample. `error` carries the failure message for
/// an unsuccessful call (`None` = success). Also emits the `[cloud-metrics]`
/// log line so latency regressions show up in plain log greps.
pub fn record(provider: &str, operation: &str, elapsed: Duration, error: Option<&str>) {
    let ms = elapsed.as_millis() as u64;
    let ok = error.is_none();
    log::info!("[cloud-metrics] provider={provider} op={operation} ms={ms} ok={ok}");

    let mut map = store().lock_recover();
    let entry = map
        .entry((provider.to_string(), operation.to_string()))
        .or_insert_with(|| CloudOpStats {
            provider: provider.to_string(),
            operation: operation.to_string(),
            count: 0,
            error_count: 0,
            last_ms: 0,
            avg_ms: 0.0,
            min_ms: u64::MAX,
            max_ms: 0,
            last_at_ms: 0,
            last_error: None,
        });
    entry.count += 1;
    entry.last_ms = ms;
    // Cumulative mean — exact, no decay; the diagnostics view resets with the app.
    entry.avg_ms += (ms as f64 - entry.avg_ms) / entry.count as f64;
    entry.min_ms = entry.min_ms.min(ms);
    entry.max_ms = entry.max_ms.max(ms);
    entry.last_at_ms = now_unix_ms();
    if let Some(error) = error {
        entry.error_count += 1;
        entry.last_error = Some(error.chars().take(MAX_ERROR_LEN).collect());
    }
}

/// Time an async cloud call and record it. The error is rendered via the
/// closure so non-`Display` error types stay usable.
pub async fn timed<T, E, Fut>(
    provider: &str,
    operation: &str,
    fut: Fut,
    describe_err: impl Fn(&E) -> String,
) -> Result<T, E>
where
    Fut: Future<Output = Result<T, E>>,
{
    let started = std::time::Instant::now();
    let result = fut.await;
    let error = result.as_ref().err().map(&describe_err);
    record(provider, operation, started.elapsed(), error.as_deref());
    result
}

/// Snapshot every aggregate, ordered by (provider, operation).
pub fn snapshot() -> Vec<CloudOpStats> {
    store().lock_recover().values().cloned().collect()
}

/// Clear all aggregates (diagnostics "reset" button). Returns how many rows
/// were dropped.
pub fn clear() -> usize {
    let mut map = store().lock_recover();
    let n = map.len();
    map.clear();
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    // The store is process-global; use unique provider keys per test so
    // parallel test threads can't interleave counts.

    #[test]
    fn record_accumulates_and_tracks_errors() {
        record("test-p1", "op", Duration::from_millis(100), None);
        record("test-p1", "op", Duration::from_millis(300), Some("boom"));
        let stats = snapshot()
            .into_iter()
            .find(|s| s.provider == "test-p1" && s.operation == "op")
            .expect("aggregate exists");
        assert_eq!(stats.count, 2);
        assert_eq!(stats.error_count, 1);
        assert_eq!(stats.last_ms, 300);
        assert_eq!(stats.min_ms, 100);
        assert_eq!(stats.max_ms, 300);
        assert!((stats.avg_ms - 200.0).abs() < f64::EPSILON);
        assert_eq!(stats.last_error.as_deref(), Some("boom"));
    }

    #[test]
    fn long_error_messages_are_truncated() {
        let long = "x".repeat(500);
        record("test-p2", "op", Duration::from_millis(1), Some(&long));
        let stats = snapshot()
            .into_iter()
            .find(|s| s.provider == "test-p2")
            .expect("aggregate exists");
        assert_eq!(stats.last_error.map(|e| e.len()), Some(MAX_ERROR_LEN));
    }

    #[tokio::test]
    async fn timed_records_success_and_failure() {
        let ok: Result<u32, String> =
            timed("test-p3", "op", async { Ok(7u32) }, |e: &String| e.clone()).await;
        assert_eq!(ok.unwrap(), 7);
        let err: Result<u32, String> = timed(
            "test-p3",
            "op",
            async { Err("nope".to_string()) },
            |e: &String| e.clone(),
        )
        .await;
        assert!(err.is_err());
        let stats = snapshot()
            .into_iter()
            .find(|s| s.provider == "test-p3")
            .expect("aggregate exists");
        assert_eq!(stats.count, 2);
        assert_eq!(stats.error_count, 1);
    }
}
