// HF resolve/CDN header parsing + repo file-size fetch used to seed the progress denominator and
// the cache-layout identity (etag/commit/size). Pure helpers over reqwest types + serde_json — they
// never touch `DownloadManager`'s private state.

use std::collections::BTreeMap;

use crate::winstt::stt::resolver;

/// Outcome of our own per-file streaming download. `Failed` is NOT an error — it means "fall back
/// to hf-hub for this file" (private repo, missing HEAD metadata, IO error); the bytes still land.
pub(super) enum StreamOutcome {
    Completed,
    Cancelled,
    Paused,
    Failed,
    /// A cryptographic content identity supplied by HF did not match the completed artifact.
    /// Unlike `Failed`, this must not silently fall back and claim a successful install.
    IntegrityFailed(String),
}

pub(super) fn is_safe_hf_cache_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn is_safe_hf_commit(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The file's content ETag, from HF's `x-linked-etag` (LFS/xet) else the plain `etag`, normalized
/// the way hf-hub does (drop the weak `W/` prefix + surrounding quotes) — this is the `blobs/<etag>`
/// filename, so it MUST match hf-hub byte-for-byte or the cache pointer won't resolve.
pub(super) fn header_etag(h: &reqwest::header::HeaderMap) -> Option<String> {
    h.get("x-linked-etag")
        .or_else(|| h.get(reqwest::header::ETAG))
        .and_then(|v| v.to_str().ok())
        // Exact parity with hf-hub's `extract_etag`: drop ONE leading `W/`, then strip quotes.
        .map(|raw| {
            raw.strip_prefix("W/")
                .unwrap_or(raw)
                .trim_matches('"')
                .to_string()
        })
        .filter(|s| is_safe_hf_cache_component(s))
}

/// The commit hash the revision resolved to (`x-repo-commit`) — the `snapshots/<commit>/` dir name.
pub(super) fn header_commit(h: &reqwest::header::HeaderMap) -> Option<String> {
    h.get("x-repo-commit")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .filter(|s| is_safe_hf_commit(s))
}

/// File size in bytes: `x-linked-size` (LFS/xet logical size) else `content-length`.
pub(super) fn header_size(h: &reqwest::header::HeaderMap) -> Option<u64> {
    h.get("x-linked-size")
        .or_else(|| h.get(reqwest::header::CONTENT_LENGTH))
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
}

/// Authoritative byte size of every file in `model`'s repo, fetched in ONE request
/// (`/api/models/{owner}/{name}?blobs=true` → `siblings[].size`). This is the only single-call
/// source that sizes BOTH LFS and plain files: a per-file HEAD exposes `x-linked-size` only for LFS
/// blobs (plain files return no size header), and `?expand=siblings` omits sizes entirely. Used to
/// seed the download progress denominator with the full plan total up front (so the bar is one
/// smooth 0→100% instead of resetting as each planned file begins). Best-effort: any error
/// (offline, private/gated repo, an off-catalog/local model with no `owner/name`) yields an empty
/// map and the caller falls back to the per-file growing total.
pub(super) async fn fetch_repo_file_sizes(
    http: &reqwest::Client,
    model: &str,
) -> BTreeMap<String, u64> {
    let Some((owner, name)) = resolver::resolve_repo(model) else {
        return BTreeMap::new();
    };
    // The model-info endpoint (`/api/models/…`), NOT the resolve host path the file streamer uses.
    let url = format!("https://huggingface.co/api/models/{owner}/{name}?blobs=true");
    // Bound the whole probe with reqwest's REQUEST-level `.timeout()`: this seeds the progress
    // denominator and runs BEFORE any streaming, so a stalled metadata fetch (the `http` client only
    // sets `connect_timeout`) must not hang the download before the first byte. This is an `async fn`
    // driven by the worker's single top-level `block_on`, so the timeout timer is constructed while
    // the request drives — inside the runtime context — not eagerly on a bare thread. On any
    // error/timeout → empty map (the caller falls back to the per-file growing total).
    let Ok(resp) = http
        .get(&url)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
    else {
        return BTreeMap::new();
    };
    if !resp.status().is_success() {
        return BTreeMap::new();
    }
    match resp.json::<serde_json::Value>().await {
        Ok(body) => parse_sibling_sizes(&body),
        Err(_) => BTreeMap::new(),
    }
}

/// Parse `siblings[].{rfilename,size}` out of a `?blobs=true` model-info JSON body into a
/// `repo_path → size` map (paths normalized to forward slashes to match the download plan's keys).
/// Siblings without a numeric `size` (e.g. a response that wasn't `?blobs=true`) are skipped, so a
/// caller seeds only the files whose totals are actually known.
pub(crate) fn parse_sibling_sizes(body: &serde_json::Value) -> BTreeMap<String, u64> {
    let mut out = BTreeMap::new();
    if let Some(siblings) = body.get("siblings").and_then(|s| s.as_array()) {
        for s in siblings {
            if let (Some(path), Some(size)) = (
                s.get("rfilename").and_then(|v| v.as_str()),
                s.get("size").and_then(|v| v.as_u64()),
            ) && let Ok(path) = resolver::validate_repo_path(path)
            {
                out.insert(path, size);
            }
        }
    }
    out
}

/// Write `refs/main` = commit so a revision-keyed (`main`) cache-only resolve maps to the snapshot
/// dir we wrote the file into. Idempotent: only writes when missing or pointing at a different
/// commit. (The snapshot file itself is the final content — there's no blob pointer to create.)
pub(super) fn ensure_cache_ref(ref_file: &std::path::Path, commit: &str) -> std::io::Result<()> {
    if let Some(parent) = ref_file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let needs_write = std::fs::read_to_string(ref_file).map_or(true, |s| s.trim() != commit);
    if needs_write {
        std::fs::write(ref_file, commit)?;
    }
    Ok(())
}
