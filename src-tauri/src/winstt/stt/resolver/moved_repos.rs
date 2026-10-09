// Hugging Face repos that MOVED to a new owner after WinSTT shipped them.
//
// The catalog always names the CURRENT repo id, but the hf-hub cache is keyed by the id a file was
// downloaded under (`models--{owner}--{name}`). A user who fetched a model before the move holds a
// complete snapshot under the OLD folder that the probe (`cache_probe`), the loader
// (`resolver::resolve`) and startup recovery all look past — the model reads "not downloaded" and
// startup recovery would even switch the selection away from it. HF keeps the git history across a
// move (same commits, same blob etags), so the old folder IS a valid cache of the new repo: adopt it
// by renaming the folder rather than re-downloading the weights. `snapshots/*` link into `blobs/` by
// RELATIVE path inside the repo folder, so the rename keeps them intact.
//
// Only STT needs this: TTS models are fetched into `%LOCALAPPDATA%/winstt/tts/<catalog-id>/`, a
// layout keyed by the catalog id, so a TTS repo move changes the download URL and nothing on disk.

use std::path::{Path, PathBuf};

/// `(old_repo_id, new_repo_id)` for every STT catalog repo that changed owner.
/// The Audio8 org moved its repos to `Edge0` (verified against the HF API: the old ids answer
/// 307 → the new ones, which answer 200).
pub const MOVED_HF_REPOS: &[(&str, &str)] = &[
    (
        "Audio8/Audio8-ASR-0.1B-onnx-runtime",
        "Edge0/Audio8-ASR-0.1B-onnx-runtime",
    ),
    (
        "Audio8/ark-asr-0.6b-int8-onnx",
        "Edge0/ark-asr-0.6b-int8-onnx",
    ),
];

/// The hf-hub cache folder name for a model repo id (`owner/name` → `models--owner--name`).
fn hub_folder(repo_id: &str) -> String {
    format!("models--{}", repo_id.replace('/', "--"))
}

/// Rename every pre-move cache folder under `hub` to its post-move name. A folder is adopted only
/// when the new name does not exist yet — once the user has (re)downloaded under the new id that
/// cache is authoritative and the stale one is left for the normal cache cleanup. Returns the
/// `(from, to)` pairs that were renamed.
pub fn adopt_moved_repo_caches_in(hub: &Path) -> Vec<(PathBuf, PathBuf)> {
    let mut adopted = Vec::new();
    for (old_id, new_id) in MOVED_HF_REPOS {
        let from = hub.join(hub_folder(old_id));
        let to = hub.join(hub_folder(new_id));
        if !from.is_dir() || to.exists() {
            continue;
        }
        match std::fs::rename(&from, &to) {
            Ok(()) => {
                log::info!(
                    "[stt-cache] adopted pre-move cache {old_id} → {new_id} ({})",
                    to.display()
                );
                adopted.push((from, to));
            }
            Err(err) => log::warn!(
                "[stt-cache] could not adopt pre-move cache {} → {}: {err}",
                from.display(),
                to.display()
            ),
        }
    }
    adopted
}

/// [`adopt_moved_repo_caches_in`] against the live hf-hub cache. Runs once at startup, BEFORE the
/// STT selection is reconciled against the cache (otherwise a selected pre-move model would read
/// as missing and be switched away from).
pub fn adopt_moved_repo_caches() {
    match hf_hub::HFClient::new() {
        Ok(client) => {
            adopt_moved_repo_caches_in(client.cache_dir());
        }
        Err(err) => {
            log::warn!("[stt-cache] hf client init failed, skipping moved-repo adoption: {err}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(hub: &Path, repo_id: &str, file: &str) -> PathBuf {
        let snap = hub
            .join(hub_folder(repo_id))
            .join("snapshots")
            .join("abc123");
        std::fs::create_dir_all(&snap).unwrap();
        std::fs::write(snap.join(file), b"weights").unwrap();
        snap.join(file)
    }

    #[test]
    fn every_move_targets_a_catalog_repo() {
        // The table is only useful while the catalog names the NEW id; a stale table entry (or a
        // catalog row reverted to the old owner) would rename a cache nobody reads.
        for (old_id, new_id) in MOVED_HF_REPOS {
            assert!(
                crate::winstt::catalog::STT_CATALOG
                    .iter()
                    .any(|e| e.onnx_model_name == *new_id),
                "{new_id} is not a catalog repo"
            );
            assert!(
                !crate::winstt::catalog::STT_CATALOG
                    .iter()
                    .any(|e| e.onnx_model_name == *old_id),
                "{old_id} is still referenced by the catalog"
            );
        }
    }

    #[test]
    fn renames_a_pre_move_cache_to_the_new_owner() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), "Audio8/ark-asr-0.6b-int8-onnx", "model.onnx");
        let adopted = adopt_moved_repo_caches_in(dir.path());
        assert_eq!(adopted.len(), 1);
        let moved = dir
            .path()
            .join("models--Edge0--ark-asr-0.6b-int8-onnx/snapshots/abc123/model.onnx");
        assert_eq!(std::fs::read(moved).unwrap(), b"weights");
        assert!(
            !dir.path()
                .join("models--Audio8--ark-asr-0.6b-int8-onnx")
                .exists()
        );
        // Idempotent: nothing left to adopt on the next boot.
        assert!(adopt_moved_repo_caches_in(dir.path()).is_empty());
    }

    #[test]
    fn keeps_an_existing_post_move_cache() {
        let dir = tempfile::tempdir().unwrap();
        seed(
            dir.path(),
            "Audio8/Audio8-ASR-0.1B-onnx-runtime",
            "old.onnx",
        );
        seed(dir.path(), "Edge0/Audio8-ASR-0.1B-onnx-runtime", "new.onnx");
        assert!(adopt_moved_repo_caches_in(dir.path()).is_empty());
        let new_snap = dir
            .path()
            .join("models--Edge0--Audio8-ASR-0.1B-onnx-runtime/snapshots/abc123");
        assert!(new_snap.join("new.onnx").is_file());
        assert!(!new_snap.join("old.onnx").exists());
    }

    #[test]
    fn missing_hub_is_a_no_op() {
        let dir = tempfile::tempdir().unwrap();
        assert!(adopt_moved_repo_caches_in(&dir.path().join("absent")).is_empty());
    }
}
