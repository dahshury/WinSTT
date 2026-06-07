// Cache deletion (per-quant + whole-model) over hf-hub's `scan_cache`, plus the quant->file
// attribution predicate and the `key()` composite-key helper (shared by the impl, the delete
// functions, and the tests). None of these touch `DownloadManager`'s private state.

use crate::winstt::stt::resolver;
use crate::winstt::stt::Quantization;

/// Composite key for the in-flight registry: `model@quant` (matches the renderer's `quantKey`).
pub(super) fn key(model: &str, quant: &str) -> String {
    format!("{model}@{quant}")
}

/// Resolve the HF cache repo subdir for `model_id` (`<cache>/models--owner--name/`) by scanning the
/// cache. Returns `None` when the repo isn't cached.
async fn cached_repo_path(model_id: &str) -> Option<std::path::PathBuf> {
    let client = hf_hub::HFClient::new().ok()?;
    let scan = client.scan_cache().send().await.ok()?;
    let key =
        resolver::resolve_repo(model_id).map(|(o, n)| format!("{o}/{n}").to_ascii_lowercase())?;
    scan.repos
        .iter()
        .find(|r| r.repo_id.to_ascii_lowercase() == key)
        .map(|r| r.repo_path.clone())
}

/// Delete just the files matching `quant` from the model's HF cache snapshot(s). Removes the
/// snapshot pointer files (`.onnx` graphs + their `.onnx_data*` sidecars) whose stem carries the
/// quant tag; the dedup blob GC is left to hf-hub (orphan blobs are harmless). Returns the number of
/// removed files. Mirrors the server's per-quant cache wipe.
pub(super) async fn delete_quant_files(
    model_id: &str,
    quant: Quantization,
) -> std::io::Result<usize> {
    let client = match hf_hub::HFClient::new() {
        Ok(c) => c,
        Err(e) => return Err(std::io::Error::other(e.to_string())),
    };
    let scan = match client.scan_cache().send().await {
        Ok(s) => s,
        Err(e) => return Err(std::io::Error::other(e.to_string())),
    };
    let key = match resolver::resolve_repo(model_id)
        .map(|(o, n)| format!("{o}/{n}").to_ascii_lowercase())
    {
        Some(k) => k,
        None => return Ok(0),
    };
    let repo = match scan
        .repos
        .iter()
        .find(|r| r.repo_id.to_ascii_lowercase() == key)
    {
        Some(r) => r,
        None => return Ok(0),
    };

    let mut removed = 0usize;
    for rev in &repo.revisions {
        for f in &rev.files {
            let name = f.file_name.replace('\\', "/");
            if !file_belongs_to_quant(&name, quant) {
                continue;
            }
            // Remove the snapshot pointer file (Windows = a copy; deleting it frees the snapshot
            // slot — the orphaned blob is GC'd by hf-hub or harmless until then).
            if f.file_path.exists() {
                std::fs::remove_file(&f.file_path)?;
                removed += 1;
            }
        }
    }
    Ok(removed)
}

/// Whether a cached file name belongs to `quant`: an `.onnx` graph whose stem carries the quant tag,
/// OR an external-data sidecar of such a graph. Default-quant deletion targets unsuffixed graphs.
pub(super) fn file_belongs_to_quant(name: &str, quant: Quantization) -> bool {
    let file = name.rsplit(['/', '\\']).next().unwrap_or(name);
    // Graph file: `.onnx` whose own quant tag equals the target.
    if file.ends_with(".onnx") {
        return resolver::file_quantization(file) == quant;
    }
    // Sidecar: `<graph_stem>.weights` — quant is on the graph stem.
    if let Some(graph_stem) = file.strip_suffix(".weights") {
        let last = graph_stem.rsplit(['_', '.']).next().unwrap_or("");
        let tag = Quantization::parse(last)
            .filter(|q| *q != Quantization::Default)
            .unwrap_or(Quantization::Default);
        return tag == quant;
    }
    // Sidecar: `<graph_stem>.onnx_data*` / `.onnx.data*` — quant is on the graph stem.
    if let Some(idx) = file.find(".onnx") {
        let graph_stem = &file[..idx]; // up to but excluding ".onnx"
                                       // The sidecar's graph stem is `graph_stem`; its quant tag is the last `_`/`.` component.
        let last = graph_stem.rsplit(['_', '.']).next().unwrap_or("");
        let tag = Quantization::parse(last)
            .filter(|q| *q != Quantization::Default)
            .unwrap_or(Quantization::Default);
        // Only treat as a sidecar when the name actually carries `.onnx_data` / `.onnx.data`.
        let is_sidecar = file.contains(".onnx_data") || file.contains(".onnx.data");
        return is_sidecar && tag == quant;
    }
    false
}

/// Delete the entire cache subdir for `model_id`'s repo (every quant + every revision). Mirrors the
/// server's whole-model cache wipe.
pub(super) async fn delete_repo_cache(model_id: &str) -> std::io::Result<()> {
    if let Some(path) = cached_repo_path(model_id).await {
        if path.exists() {
            std::fs::remove_dir_all(&path)?;
        }
    }
    Ok(())
}
