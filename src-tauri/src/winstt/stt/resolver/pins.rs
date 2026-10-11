//! Curated Hub commits and published LFS checksums, refreshed with tools/pin-stt-models.py.
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::winstt::stt::{SttError, SttResult};

#[derive(Deserialize)]
struct FilePin {
    size: Option<u64>,
    sha256: Option<String>,
}

#[derive(Deserialize)]
struct RepoPin {
    revision: String,
    files: BTreeMap<String, FilePin>,
}

static PINS: LazyLock<BTreeMap<String, RepoPin>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("model-pins.json")).expect("valid shipped model pins")
});

pub(crate) fn revision(owner: &str, name: &str) -> &'static str {
    PINS.get(&format!("{owner}/{name}"))
        .map_or("main", |pin| pin.revision.as_str())
}

/// Use the same immutable file inventory for progress and content verification.
pub(crate) fn file_sizes(owner: &str, name: &str) -> Option<BTreeMap<String, u64>> {
    PINS.get(&format!("{owner}/{name}")).map(|pin| {
        pin.files
            .iter()
            .filter_map(|(path, file)| file.size.map(|size| (path.clone(), size)))
            .collect()
    })
}

/// Hash during a managed download, never during ordinary offline engine loads.
/// Custom repositories remain user-controlled and do not inherit curated expectations.
pub(crate) async fn verify(
    owner: &str,
    name: &str,
    repo_path: &str,
    path: PathBuf,
) -> SttResult<PathBuf> {
    let Some(repo) = PINS.get(&format!("{owner}/{name}")) else {
        return Ok(path);
    };
    let pin = repo.files.get(repo_path).ok_or_else(|| {
        SttError::Resolve(format!(
            "file {repo_path} is absent from the pinned inventory for {owner}/{name}"
        ))
    })?;
    tokio::task::spawn_blocking(move || {
        verify_file(&path, pin)?;
        Ok(path)
    })
    .await
    .map_err(|e| SttError::Resolve(format!("model verification task: {e}")))?
}

fn verify_file(path: &Path, pin: &FilePin) -> SttResult<()> {
    let check = || -> Result<(), String> {
        let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let actual_size = file.metadata().map_err(|e| e.to_string())?.len();
        if pin.size.is_some_and(|expected| expected != actual_size) {
            return Err(format!(
                "size mismatch: expected {:?}, found {actual_size}",
                pin.size
            ));
        }
        if let Some(expected) = &pin.sha256 {
            let mut digest = Sha256::new();
            let mut buffer = [0u8; 64 * 1024];
            loop {
                let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
                if count == 0 {
                    break;
                }
                digest.update(&buffer[..count]);
            }
            if format!("{:x}", digest.finalize()) != *expected {
                return Err("SHA-256 mismatch".into());
            }
        }
        Ok(())
    };
    check().map_err(|e| SttError::Resolve(format!("model integrity check failed for {}: {e}; remove the damaged cached file and download again", path.display())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_file_sizes_are_available_without_network() {
        let (owner, name) = super::super::globs::resolve_repo_for_quant(
            "onnx-community/whisper-tiny",
            crate::winstt::stt::Quantization::Default,
        )
        .unwrap();
        let sizes = file_sizes(&owner, &name).unwrap();
        assert!(!sizes.is_empty());
        assert_eq!(file_sizes("user", "custom"), None);
    }

    #[tokio::test]
    async fn curated_download_cannot_publish_an_unlisted_file() {
        let (owner, name) = super::super::globs::resolve_repo_for_quant(
            "onnx-community/whisper-tiny",
            crate::winstt::stt::Quantization::Default,
        )
        .unwrap();
        let temp = tempfile::NamedTempFile::new().unwrap();
        assert!(
            verify(&owner, &name, "unlisted-graph.onnx", temp.path().into())
                .await
                .is_err()
        );
        assert!(
            verify("user", "custom", "model.onnx", temp.path().into())
                .await
                .is_ok()
        );
    }

    #[test]
    fn every_catalog_repo_and_quant_override_has_an_immutable_pin() {
        for entry in crate::winstt::catalog::STT_CATALOG {
            for quant in [
                crate::winstt::stt::Quantization::Default,
                crate::winstt::stt::Quantization::Fp16,
                crate::winstt::stt::Quantization::Int8,
                crate::winstt::stt::Quantization::Q4,
            ] {
                let (owner, name) =
                    super::super::globs::resolve_repo_for_quant(entry.onnx_model_name, quant)
                        .unwrap();
                let sha = revision(&owner, &name);
                assert_eq!(sha.len(), 40, "{owner}/{name}");
                assert!(sha.bytes().all(|byte| byte.is_ascii_hexdigit()));
            }
        }
        assert_eq!(revision("user", "custom"), "main");
    }

    #[test]
    fn detects_same_size_corruption_and_truncated_downloads() {
        let temp = tempfile::NamedTempFile::new().unwrap();
        let pin = FilePin {
            size: Some(3),
            sha256: Some(format!("{:x}", Sha256::digest(b"abc"))),
        };
        std::fs::write(temp.path(), b"abc").unwrap();
        verify_file(temp.path(), &pin).unwrap();
        std::fs::write(temp.path(), b"abd").unwrap();
        assert!(
            verify_file(temp.path(), &pin)
                .unwrap_err()
                .to_string()
                .contains("SHA-256")
        );
        std::fs::write(temp.path(), b"ab").unwrap();
        assert!(
            verify_file(temp.path(), &pin)
                .unwrap_err()
                .to_string()
                .contains("size mismatch")
        );
    }
}
