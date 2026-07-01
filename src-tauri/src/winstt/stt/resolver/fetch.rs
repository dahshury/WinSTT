// The async hf-hub resolution + download pipeline (resolver sections 6 and 6b): request/plan types,
// resolve/resolve_blocking, local-dir and remote/cached-offline resolution, and the
// DownloadManager-facing plan/download/cache APIs.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::globs::{file_globs, glob_match, pick_kaldi_tiebreak, resolve_repo};
use super::sidecars::{is_sidecar_for, verify_external_data_complete};
use crate::winstt::stt::{EngineKind, Quantization, ResolvedModel, SttError, SttResult};

// ---------------------------------------------------------------------------
// 6. The resolver (async hf-hub) + blocking wrapper
// ---------------------------------------------------------------------------

/// Inputs to one resolution. `effective_quant` is the quant the loader ACTUALLY wants AFTER the
/// catalog's int8-preferred / fp16-auto / DML resolution (see `catalog::resolve_quantization` and
/// `mod::resolve_quantization_auto`); the picker badge must check THIS, not the raw requested quant
/// (memory project_effective_quantization_bridge).
#[derive(Clone, Debug)]
pub struct ResolveRequest {
    pub model_id: String,
    pub kind: EngineKind,
    pub effective_quant: Quantization,
    /// Local custom-model dir (offline). When set, HF is bypassed and files are resolved from disk
    /// (spec §10). `model_id` still drives the engine kind.
    pub local_dir: Option<PathBuf>,
    /// Resolve from cache only (never hit the network). The first pass uses this; on a miss /
    /// incomplete-shard we retry with `false` exactly once.
    pub local_files_only: bool,
}

/// One repo file we intend to fetch: its POSIX repo path and whether it's a hard requirement.
#[derive(Clone, Debug)]
struct PlannedFile {
    /// Logical key (`encoder`, …) for the required files; `None` for the config/sidecar extras.
    key: Option<&'static str>,
    /// POSIX repo path (an `rfilename` from `ModelInfo.siblings`).
    repo_path: String,
}

/// Resolve a model to its on-disk file set (async — uses the hf-hub async client).
///
/// Flow (port of resolver.py `resolve_model` + `_download_model` + onnxasr `_refetch_hf_snapshot`):
///   1. If `local_dir` is set → resolve files from disk only (no HF).
///   2. Else: list the repo tree, match every `file_globs(kind, quant)` glob against it, pick the
///      one matching path per logical key (>1 match = error, 0 = ModelFileNotFound), and ALSO plan
///      every `<stem>.onnx_data*` / `<stem>.weights` sidecar + `config.json`/`config.yaml`.
///   3. Download each planned file (`local_files_only` first), forming the path map.
///   4. Verify external-data completeness on every downloaded `.onnx`. If any shard is missing AND
///      we were cache-only → flip to a network refetch and retry the WHOLE plan ONCE (spec §2.3).
pub async fn resolve(req: &ResolveRequest) -> SttResult<ResolvedModel> {
    if let Some(dir) = &req.local_dir {
        return resolve_local_dir(dir, &req.model_id, req.kind, req.effective_quant);
    }

    // Pass 1 — honour the caller's cache-only flag (mirrors resolver.py: try local_files_only=True).
    // It is "good" only if it resolved AND every `.onnx` has complete external data.
    //
    // OFFLINE-FIRST (CRITICAL): a 100%-cached model must load with ZERO network. We derive
    // the planned file set straight from the ON-DISK hf-hub snapshot (`scan_cache`) and glob-match it
    // there — `repo.info().send()` (the HTTP tree listing) is NEVER touched on this pass. A genuine
    // cache miss / incomplete shard falls through to the single network pass below.
    if req.local_files_only {
        if let Ok(resolved) = resolve_cached_offline(req).await {
            if all_onnx_complete(&resolved) {
                return Ok(resolved);
            }
            // else: cache present but an `.onnx_data_N` shard is missing → fall through to refetch.
        }
        // Pass 2 — exactly ONE network attempt (cache-only miss OR the partial-shard refetch).
        let refetched = resolve_remote(req, false).await?;
        if all_onnx_complete(&refetched) {
            return Ok(refetched);
        }
        return Err(SttError::Resolve(format!(
            "external-data shards still incomplete after refetch for {}",
            req.model_id
        )));
    }

    // Caller explicitly asked for a network resolve from the start: one attempt, must be complete.
    let resolved = resolve_remote(req, false).await?;
    if all_onnx_complete(&resolved) {
        Ok(resolved)
    } else {
        Err(SttError::Resolve(format!(
            "external-data shards incomplete for {} after network resolve",
            req.model_id
        )))
    }
}

/// Blocking convenience for callers without an async context (engine load on a worker thread).
/// Drives `resolve` on the supplied tokio runtime handle. The coordinator owns a `Handle` (Tauri's
/// async runtime); pass `tokio::runtime::Handle::current()` from inside Tauri, or a dedicated
/// `Runtime::new()?.handle()`.
pub fn resolve_blocking(
    handle: &tokio::runtime::Handle,
    req: &ResolveRequest,
) -> SttResult<ResolvedModel> {
    // CONTRACT: call this from a NON-runtime thread (the engine load runs on a dedicated
    // `std::thread` / `spawn_blocking` worker), so `Handle::block_on` is valid. If you must call it
    // from inside a runtime worker, wrap with `tokio::task::block_in_place(|| handle.block_on(..))`
    // (multi-thread runtime only) at the call site instead.
    handle.block_on(resolve(req))
}

/// Resolve a custom local-dir model (offline; no HF). Globs the dir for each required file.
fn resolve_local_dir(
    dir: &Path,
    model_id: &str,
    kind: EngineKind,
    quant: Quantization,
) -> SttResult<ResolvedModel> {
    let mut files = BTreeMap::new();
    let entries = list_dir_posix(dir)
        .map_err(|e| SttError::Resolve(format!("scan {}: {e}", dir.display())))?;
    for fg in file_globs(model_id, kind, quant) {
        // Required keys must resolve; config-only extras are added below.
        let matched: Vec<&(String, PathBuf)> = entries
            .iter()
            .filter(|(rel, _)| glob_match(&fg.glob, rel))
            .collect();
        let rels: Vec<&String> = matched.iter().map(|(rel, _)| rel).collect();
        let chosen_rel = match pick_kaldi_tiebreak(kind, &rels) {
            Ok(Some(rel)) => Some((*rel).clone()),
            Ok(None) => None,
            Err(()) => {
                return Err(SttError::Resolve(format!(
                    "more than one file matched {} in {}",
                    fg.glob,
                    dir.display()
                )));
            }
        };
        let matched_one = chosen_rel
            .as_ref()
            .and_then(|rel| matched.iter().find(|(r, _)| r == rel));
        match matched_one {
            Some((_, abs)) => {
                files.insert(fg.key.to_string(), abs.clone());
            }
            None => {
                // `.ort` fallback (resolver.py find()): try the `.onnx`→`.ort` swap.
                if let Some(ort_glob) = fg.glob.strip_suffix(".onnx") {
                    let ort_glob = format!("{ort_glob}.ort");
                    if let Some((_, abs)) =
                        entries.iter().find(|(rel, _)| glob_match(&ort_glob, rel))
                    {
                        files.insert(fg.key.to_string(), abs.clone());
                        continue;
                    }
                }
                return Err(SttError::Resolve(format!(
                    "missing {} ({}) in {}",
                    fg.key,
                    fg.glob,
                    dir.display()
                )));
            }
        }
    }
    // config.json if present.
    let cfg = dir.join("config.json");
    if cfg.is_file() {
        files.insert("config".into(), cfg);
    }
    Ok(ResolvedModel {
        files,
        effective_quantization: quant,
    })
}

/// The remote resolve: list tree → glob → download each file (+ sidecars + config). `cache_only`
/// chooses `local_files_only` on every download (the first pass) vs a network fetch (the refetch).
async fn resolve_remote(req: &ResolveRequest, cache_only: bool) -> SttResult<ResolvedModel> {
    use hf_hub::HFClient;

    let (owner, name) = resolve_repo(&req.model_id).ok_or_else(|| {
        SttError::Resolve(format!("unknown model alias / repo: {}", req.model_id))
    })?;

    let client = HFClient::new().map_err(|e| SttError::Resolve(format!("hf client init: {e}")))?;
    let repo = client.model(owner.clone(), name.clone());

    // Enumerate the repo's file list (`ModelInfo.siblings[].rfilename`) so we can glob-match like
    // Python's `path.glob(...)` does against the snapshot — but without downloading everything first.
    let tree_paths = list_repo_tree(&repo).await?;

    // Plan the required (logical-key) files by matching each glob against the tree.
    let globs = file_globs(&req.model_id, req.kind, req.effective_quant);
    let mut planned: Vec<PlannedFile> = Vec::new();
    let mut onnx_stems: Vec<String> = Vec::new();
    for fg in &globs {
        let mut matches: Vec<&String> = tree_paths
            .iter()
            .filter(|p| glob_match(&fg.glob, p))
            .collect();
        // `.ort` fallback when the `.onnx` form has no match (resolver.py find()).
        if matches.is_empty() {
            if let Some(stem) = fg.glob.strip_suffix(".onnx") {
                let ort = format!("{stem}.ort");
                matches = tree_paths.iter().filter(|p| glob_match(&ort, p)).collect();
            }
        }
        let path = match pick_kaldi_tiebreak(req.kind, &matches) {
            Ok(Some(p)) => p,
            Ok(None) => {
                return Err(SttError::Resolve(format!(
                    "missing {} ({}) in {}/{}",
                    fg.key, fg.glob, owner, name
                )));
            }
            Err(()) => {
                return Err(SttError::Resolve(format!(
                    "more than one file matched {} in {}/{}",
                    fg.glob, owner, name
                )));
            }
        };
        if path.ends_with(".onnx") {
            if let Some(stem) = path.strip_suffix(".onnx") {
                onnx_stems.push(stem.to_string());
            }
        }
        planned.push(PlannedFile {
            key: Some(fg.key),
            repo_path: (*path).clone(),
        });
    }

    // Plan every external-data sidecar for each planned `.onnx`: `<stem>.onnx_data`, `.onnx.data`,
    // `<stem>.weights`, and the sharded `.onnx_data_N` / `.onnx.data_N`. We add only the sidecars
    // the tree actually lists (avoids a 404 on single-file graphs). Forward-slash patterns
    // throughout (the Win bug).
    for stem in &onnx_stems {
        for p in &tree_paths {
            if is_sidecar_for(stem, p) {
                planned.push(PlannedFile {
                    key: None,
                    repo_path: p.clone(),
                });
            }
        }
    }

    // Always pull config.json / config.yaml when present (resolver.py:145-147).
    for cfg in ["config.json", "config.yaml"] {
        if tree_paths.iter().any(|p| p == cfg) {
            planned.push(PlannedFile {
                key: None,
                repo_path: cfg.to_string(),
            });
        }
    }

    // Download everything; build the logical-key → local-path map.
    let mut files: BTreeMap<String, PathBuf> = BTreeMap::new();
    let mut config_local: Option<PathBuf> = None;
    for pf in &planned {
        let local = download_one(&repo, &pf.repo_path, cache_only).await?;
        if let Some(key) = pf.key {
            files.insert(key.to_string(), local.clone());
        } else if pf.repo_path == "config.json" {
            config_local = Some(local);
        }
    }
    if let Some(cfg) = config_local {
        files.insert("config".into(), cfg);
    }

    Ok(ResolvedModel {
        files,
        effective_quantization: req.effective_quant,
    })
}

/// Download one repo file (cache-aware). Returns the local cached path.
async fn download_one(
    repo: &hf_hub::HFRepository<hf_hub::RepoTypeModel>,
    repo_path: &str,
    cache_only: bool,
) -> SttResult<PathBuf> {
    repo.download_file()
        .filename(repo_path)
        .local_files_only(cache_only)
        .send()
        .await
        .map_err(|e| SttError::Resolve(format!("download {repo_path}: {e}")))
}

/// Resolve a model to its on-disk file set using ONLY the local hf-hub cache — never the network
/// (no `repo.info().send()`). This is the offline-first Pass-1 of `resolve()`: a 100%-cached model
/// loads/swaps with zero network latency and works when HF is unreachable.
///
/// It scans the local cache (`scan_cache`, an fs walk — the SAME walk `cache_probe.rs` uses), finds
/// the repo's cached `(posix_name, abs_path)` pairs across every revision, then runs the IDENTICAL
/// planning + glob-matching as `resolve_remote` against that on-disk file list. A cache miss (repo
/// absent, or a required logical file not yet downloaded) returns `Err` so `resolve()` falls through
/// to exactly one network pass.
async fn resolve_cached_offline(req: &ResolveRequest) -> SttResult<ResolvedModel> {
    use hf_hub::HFClient;

    let (owner, name) = resolve_repo(&req.model_id).ok_or_else(|| {
        SttError::Resolve(format!("unknown model alias / repo: {}", req.model_id))
    })?;
    let repo_key = format!("{owner}/{name}").to_ascii_lowercase();

    // Walk the local cache only — `scan_cache()` is a filesystem scan, no HTTP. A scan error or an
    // absent repo is a cache miss → caller does the one network pass.
    let client = HFClient::new().map_err(|e| SttError::Resolve(format!("hf client init: {e}")))?;
    let scan = client
        .scan_cache()
        .send()
        .await
        .map_err(|e| SttError::Resolve(format!("scan cache: {e}")))?;

    // Collect the repo's cached files as `(posix_repo_path, abs_pointer_path)` across all revisions
    // (dedup by repo path; first revision wins — pointer files refer to the same blob).
    let repo = scan
        .repos
        .iter()
        .find(|r| r.repo_id.to_ascii_lowercase() == repo_key)
        .ok_or_else(|| SttError::Resolve(format!("{owner}/{name} not in local cache")))?;
    let mut cached: Vec<(String, PathBuf)> = Vec::new();
    {
        let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for rev in &repo.revisions {
            for f in &rev.files {
                let posix = f.file_name.replace('\\', "/");
                if posix.is_empty() || !seen.insert(posix.clone()) {
                    continue;
                }
                cached.push((posix, f.file_path.clone()));
            }
        }
    }

    // Plan the required (logical-key) files by matching each glob against the cached file list —
    // the SAME planning logic as `resolve_remote`, just over the on-disk snapshot instead of the
    // remote tree. A missing required file is a cache miss (→ network pass).
    let globs = file_globs(&req.model_id, req.kind, req.effective_quant);
    let mut files: BTreeMap<String, PathBuf> = BTreeMap::new();
    for fg in &globs {
        // Match the glob (and the `.onnx`→`.ort` fallback) against the cached POSIX paths.
        let mut matches: Vec<&String> = cached
            .iter()
            .map(|(p, _)| p)
            .filter(|p| glob_match(&fg.glob, p))
            .collect();
        if matches.is_empty() {
            if let Some(stem) = fg.glob.strip_suffix(".onnx") {
                let ort = format!("{stem}.ort");
                matches = cached
                    .iter()
                    .map(|(p, _)| p)
                    .filter(|p| glob_match(&ort, p))
                    .collect();
            }
        }
        let chosen = match pick_kaldi_tiebreak(req.kind, &matches) {
            Ok(Some(p)) => (*p).clone(),
            Ok(None) => {
                // Required file not cached → genuine miss; let `resolve()` go to the network.
                return Err(SttError::Resolve(format!(
                    "missing {} ({}) in local cache {}/{}",
                    fg.key, fg.glob, owner, name
                )));
            }
            Err(()) => {
                return Err(SttError::Resolve(format!(
                    "more than one cached file matched {} in {}/{}",
                    fg.glob, owner, name
                )));
            }
        };
        let abs = cached
            .iter()
            .find(|(p, _)| *p == chosen)
            .map(|(_, abs)| abs.clone())
            .ok_or_else(|| {
                SttError::Resolve(format!(
                    "cache path lost for {} in {}/{}",
                    fg.key, owner, name
                ))
            })?;
        files.insert(fg.key.to_string(), abs);
    }

    // config.json (resolver.py:145-147): include it when cached so families that read decode params
    // from config (e.g. T-One vocab) have it. Optional — its absence is not a cache miss. The
    // external-data sidecars don't need enumerating into the map (they're not logical-key entries);
    // `resolve()`'s `all_onnx_complete` verifies them on disk next, relative to each `.onnx`'s dir.
    if let Some((_, abs)) = cached.iter().find(|(p, _)| p == "config.json") {
        files.insert("config".into(), abs.clone());
    }

    Ok(ResolvedModel {
        files,
        effective_quantization: req.effective_quant,
    })
}

// ---------------------------------------------------------------------------
// 6b. Per-quant download PLAN + progress-aware fetch (consumed by DownloadManager)
// ---------------------------------------------------------------------------

/// The full set of repo-relative POSIX paths a `(model_id, kind, quant)` download must fetch INTO
/// the HF cache: every required graph (`.onnx`) + its external-data sidecars + `config.json` /
/// `config.yaml` + the vocab/tokenizer text files. Mirrors `resolve_remote`'s planning step but
/// returns the path LIST (instead of downloading) so the DownloadManager can stream each file with
/// pause/cancel/progress. Lists the repo tree once over the network.
pub async fn plan_quant_download(
    model_id: &str,
    kind: EngineKind,
    quant: Quantization,
) -> SttResult<Vec<String>> {
    use hf_hub::HFClient;

    let (owner, name) = resolve_repo(model_id)
        .ok_or_else(|| SttError::Resolve(format!("unknown model alias / repo: {model_id}")))?;
    let client = HFClient::new().map_err(|e| SttError::Resolve(format!("hf client init: {e}")))?;
    let repo = client.model(owner.clone(), name.clone());
    let tree_paths = list_repo_tree(&repo).await?;

    let globs = file_globs(model_id, kind, quant);
    let mut planned: Vec<String> = Vec::new();
    let mut onnx_stems: Vec<String> = Vec::new();
    for fg in &globs {
        let mut matches: Vec<&String> = tree_paths
            .iter()
            .filter(|p| glob_match(&fg.glob, p))
            .collect();
        if matches.is_empty() {
            if let Some(stem) = fg.glob.strip_suffix(".onnx") {
                let ort = format!("{stem}.ort");
                matches = tree_paths.iter().filter(|p| glob_match(&ort, p)).collect();
            }
        }
        // Kaldi-scoped tie-break (zipformer default glob also matches `.int8` siblings); for any
        // other kind a unique match is chosen, and >1 falls back to `first()` (pre-existing behaviour).
        let path = match pick_kaldi_tiebreak(kind, &matches) {
            Ok(Some(p)) => p.clone(),
            Ok(None) => {
                return Err(SttError::Resolve(format!(
                    "missing {} ({}) in {owner}/{name}",
                    fg.key, fg.glob
                )));
            }
            Err(()) => match matches.first() {
                Some(p) => (*p).clone(),
                None => {
                    return Err(SttError::Resolve(format!(
                        "missing {} ({}) in {owner}/{name}",
                        fg.key, fg.glob
                    )));
                }
            },
        };
        if let Some(stem) = path.strip_suffix(".onnx") {
            onnx_stems.push(stem.to_string());
        }
        planned.push(path);
    }
    // External-data sidecars for each planned `.onnx`.
    for stem in &onnx_stems {
        for p in &tree_paths {
            if is_sidecar_for(stem, p) {
                planned.push(p.clone());
            }
        }
    }
    // config.json / config.yaml when present.
    for cfg in ["config.json", "config.yaml"] {
        if tree_paths.iter().any(|p| p == cfg) {
            planned.push(cfg.to_string());
        }
    }
    // De-dup (a sidecar could in theory also be a planned graph match — defensive).
    planned.sort();
    planned.dedup();
    Ok(planned)
}

/// Download ONE planned repo file INTO the HF cache, reporting byte-level progress via `progress`
/// (an hf-hub `ProgressHandler`). Returns the local cached path. `cache_only` skips the network
/// when the file is already present (used to short-circuit already-cached files cheaply).
pub async fn download_planned_file(
    model_id: &str,
    repo_path: &str,
    cache_only: bool,
    progress: impl Into<hf_hub::progress::Progress>,
) -> SttResult<PathBuf> {
    use hf_hub::HFClient;

    let (owner, name) = resolve_repo(model_id)
        .ok_or_else(|| SttError::Resolve(format!("unknown model alias / repo: {model_id}")))?;
    let client = HFClient::new().map_err(|e| SttError::Resolve(format!("hf client init: {e}")))?;
    let repo = client.model(owner, name);
    let progress: hf_hub::progress::Progress = progress.into();
    repo.download_file()
        .filename(repo_path)
        .local_files_only(cache_only)
        .progress(progress)
        .send()
        .await
        .map_err(|e| SttError::Resolve(format!("download {repo_path}: {e}")))
}

/// True iff `repo_path` is already present + complete in the HF cache (used to skip already-cached
/// files when resuming a partial per-quant download). A cache-only `download_file` succeeds iff the
/// file is cached; we then verify external-data completeness for `.onnx`.
pub async fn is_file_cached(model_id: &str, repo_path: &str) -> bool {
    struct Noop;
    impl hf_hub::progress::ProgressHandler for Noop {
        fn on_progress(&self, _e: &hf_hub::progress::ProgressEvent) {}
    }
    match download_planned_file(model_id, repo_path, true, Noop).await {
        Ok(p) => {
            if repo_path.ends_with(".onnx") {
                verify_external_data_complete(&p)
            } else {
                p.metadata().is_ok_and(|m| m.len() > 0)
            }
        }
        Err(_) => false,
    }
}

/// Collect the repo's POSIX file paths via `repo.info().send()` → `ModelInfo.siblings`, each a
/// `RepoSibling { rfilename: String, .. }` (the relative repo path — the same `siblings`/`rfilename`
/// surface the Python `huggingface_hub` exposes, which onnx-asr's resolver fnmatches). This is
/// preferred over `list_tree()` (whose `RepoTreeEntry` is an enum we'd have to destructure) because
/// `rfilename` is a flat `String` we can glob directly.
async fn list_repo_tree(
    repo: &hf_hub::HFRepository<hf_hub::RepoTypeModel>,
) -> SttResult<Vec<String>> {
    // The HF `/api/models/{id}` response includes `siblings` (rfilename) by default, so a
    // plain `info().send()` should populate `ModelInfo.siblings`. If the builder gates siblings
    // behind an expand flag (e.g. `.expand("siblings")` / `.files(true)`), add it on the next line.
    let info = repo
        .info()
        .send()
        .await
        .map_err(|e| SttError::Resolve(format!("repo info: {e}")))?;
    let siblings = info.siblings.unwrap_or_default();
    Ok(siblings
        .into_iter()
        .map(|s| s.rfilename.replace('\\', "/"))
        .filter(|p| !p.is_empty())
        .collect())
}

/// True iff every `.onnx` in the resolved set has complete external data on disk.
fn all_onnx_complete(resolved: &ResolvedModel) -> bool {
    resolved
        .files
        .values()
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("onnx"))
        .all(|p| verify_external_data_complete(p))
}

/// Recursively list a local dir, returning `(posix_relative_path, absolute_path)` pairs. Used by
/// the custom-model offline resolver so the same `glob_match` works on disk.
fn list_dir_posix(root: &Path) -> std::io::Result<Vec<(String, PathBuf)>> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) -> std::io::Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                walk(base, &path, out)?;
            } else if let Ok(rel) = path.strip_prefix(base) {
                let posix = rel.to_string_lossy().replace('\\', "/");
                out.push((posix, path));
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(root, root, &mut out)?;
    Ok(out)
}
