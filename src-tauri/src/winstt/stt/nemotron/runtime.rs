//! Optional native runtime. No Python, CUDA installation, or cloud transcription.
//! SALM is currently in NVIDIA's nightly channel. Resolve and verify its published
//! asset digest once, then retain that exact build and inventory for offline use.
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use sha2::{Digest, Sha256};

fn platform() -> Result<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Ok("windows-x86_64"),
        ("linux", "x86_64") => Ok("linux-x86_64"),
        ("linux", "aarch64") => Ok("linux-aarch64"),
        ("macos", "aarch64") => Ok("macos-aarch64"),
        ("macos", "x86_64") => Ok("macos-x86_64"),
        _ => bail!("NeMo Speech CPU runtime is not published for this platform"),
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Receipt {
    source_commit: String,
    archive_sha256: String,
    files: std::collections::BTreeMap<String, String>,
}

fn published_digest(release: &serde_json::Value, asset: &str) -> Result<(String, String)> {
    let commit = release["target_commitish"]
        .as_str()
        .context("missing native runtime source revision")?;
    if release["draft"] != false
        || release["tag_name"] != "nightly"
        || commit.len() != 40
        || !commit.bytes().all(|b| b.is_ascii_hexdigit())
    {
        bail!("invalid NVIDIA nightly release metadata");
    }
    let asset = release["assets"]
        .as_array()
        .context("missing native runtime assets")?
        .iter()
        .find(|a| a["name"] == asset)
        .context("NVIDIA has not published the optional CPU runtime for this platform")?;
    if !asset["size"]
        .as_u64()
        .is_some_and(|n| n > 0 && n <= 32 * 1024 * 1024)
    {
        bail!("optional CPU runtime has an unexpected archive size");
    }
    let digest = asset["digest"]
        .as_str()
        .and_then(|s| s.strip_prefix("sha256:"))
        .context("native runtime asset has no published SHA-256 digest")?;
    if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("invalid native runtime SHA-256 digest");
    }
    Ok((commit.to_string(), digest.to_ascii_lowercase()))
}

fn executable(root: &Path) -> PathBuf {
    root.join("bin").join(if cfg!(windows) {
        "nemo-speech.exe"
    } else {
        "nemo-speech"
    })
}

fn unpack(bytes: &[u8], zip: bool, destination: &Path) -> Result<()> {
    if zip {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes))?;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index)?;
            let relative = entry
                .enclosed_name()
                .context("unsafe runtime archive path")?;
            if entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
            {
                bail!("runtime archive contains a symlink");
            }
            let path = destination.join(relative);
            if entry.is_dir() {
                std::fs::create_dir_all(path)?;
                continue;
            }
            std::fs::create_dir_all(path.parent().context("runtime file has no parent")?)?;
            std::io::copy(&mut entry, &mut std::fs::File::create(path)?)?;
        }
    } else {
        let decoder = flate2::read::GzDecoder::new(Cursor::new(bytes));
        let mut archive = tar::Archive::new(decoder);
        let mut links = Vec::new();
        for entry in archive.entries()? {
            let mut entry = entry?;
            let ty = entry.header().entry_type();
            if ty.is_symlink() || ty.is_hard_link() {
                let path = entry.path()?.into_owned();
                if path.is_absolute()
                    || path.components().any(|c| {
                        !matches!(
                            c,
                            std::path::Component::Normal(_) | std::path::Component::CurDir
                        )
                    })
                {
                    bail!("unsafe runtime link path");
                }
                let target = entry
                    .link_name()?
                    .context("runtime link has no target")?
                    .into_owned();
                let link = destination.join(path);
                let source = if ty.is_hard_link() {
                    destination.join(target)
                } else {
                    link.parent()
                        .context("runtime link has no parent")?
                        .join(target)
                };
                links.push((link, source));
                continue;
            }
            if !ty.is_file() && !ty.is_dir() {
                bail!("runtime archive contains a link or special file");
            }
            if !entry.unpack_in(destination)? {
                bail!("unsafe runtime archive path");
            }
        }
        // Linux/macOS archives contain library aliases. Materialize only links
        // whose final regular-file target is inside the verified archive root.
        let root = destination.canonicalize()?;
        while !links.is_empty() {
            let previous = links.len();
            let mut pending = Vec::new();
            for (link, source) in links {
                let source = match source.canonicalize() {
                    Ok(path) => path,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        pending.push((link, source));
                        continue;
                    }
                    Err(error) => return Err(error.into()),
                };
                if !source.starts_with(&root) || !source.is_file() {
                    bail!("runtime link escapes its archive");
                }
                std::fs::create_dir_all(link.parent().context("runtime link has no parent")?)?;
                std::fs::copy(source, link)?;
            }
            if pending.len() == previous {
                bail!("runtime archive has unresolved library links");
            }
            links = pending;
        }
    }
    Ok(())
}

fn inventory(root: &Path) -> Result<std::collections::BTreeMap<String, String>> {
    let mut result = std::collections::BTreeMap::new();
    let mut directories = vec![root.to_path_buf()];
    while let Some(directory) = directories.pop() {
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            let ty = entry.file_type()?;
            if ty.is_symlink() {
                bail!("native runtime contains a symlink");
            }
            if ty.is_dir() {
                directories.push(entry.path());
            } else if ty.is_file() && entry.file_name() != ".verified.json" {
                let mut file = std::fs::File::open(entry.path())?;
                let mut hasher = Sha256::new();
                let mut buffer = [0u8; 65536];
                loop {
                    let count = file.read(&mut buffer)?;
                    if count == 0 {
                        break;
                    }
                    hasher.update(&buffer[..count]);
                }
                result.insert(
                    entry
                        .path()
                        .strip_prefix(root)?
                        .to_string_lossy()
                        .into_owned(),
                    format!("{:x}", hasher.finalize()),
                );
            }
        }
    }
    Ok(result)
}

/// Called on the app's model-preparation worker, before entering native
/// inference. Once installed, runtime preparation is entirely offline.
pub async fn ensure(root: &Path) -> Result<PathBuf> {
    let target = platform()?;
    let package = format!("nemo-speech-nightly-{target}-cpu");
    let destination = root.join(format!("nemotron-transcribe-{target}-cpu"));
    let marker = destination.join(".verified.json");
    if marker.is_file() && executable(&destination).is_file() {
        let expected: Receipt = serde_json::from_slice(&std::fs::read(&marker)?)?;
        if !expected.files.is_empty() && inventory(&destination)? == expected.files {
            return Ok(executable(&destination));
        }
        bail!(
            "NeMo runtime integrity check failed; remove its optional runtime folder and download it again"
        );
    }
    std::fs::create_dir_all(root)?;
    let suffix = if cfg!(windows) { "zip" } else { "tar.gz" };
    let asset_name = format!("{package}.{suffix}");
    let url =
        format!("https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/nightly/{asset_name}");
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::limited(8))
        .timeout(std::time::Duration::from_secs(300))
        .user_agent("WinSTT-optional-native-runtime")
        .build()?;
    let mut metadata = client
        .get("https://api.github.com/repos/NVIDIA/NeMo-Speech.cpp/releases/tags/nightly")
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await?
        .error_for_status()?;
    let mut manifest = Vec::new();
    while let Some(chunk) = metadata.chunk().await? {
        if manifest.len() + chunk.len() > 1024 * 1024 {
            bail!("native release metadata exceeds its size limit");
        }
        manifest.extend_from_slice(&chunk);
    }
    let (source_commit, digest) =
        published_digest(&serde_json::from_slice(&manifest)?, &asset_name)?;
    let mut response = client.get(url).send().await?.error_for_status()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > 32 * 1024 * 1024 {
            bail!("CPU runtime archive exceeds its size limit");
        }
        bytes.extend_from_slice(&chunk);
    }
    if format!("{:x}", Sha256::digest(&bytes)) != digest {
        bail!("NeMo runtime SHA-256 verification failed");
    }
    let staging = tempfile::tempdir_in(root)?;
    unpack(&bytes, cfg!(windows), staging.path())?;
    let staged = staging.path().join(&package);
    if !executable(&staged).is_file() {
        bail!("NeMo runtime archive is missing its executable");
    }
    let receipt = Receipt {
        source_commit,
        archive_sha256: digest,
        files: inventory(&staged)?,
    };
    std::fs::File::create(staged.join(".verified.json"))?
        .write_all(&serde_json::to_vec(&receipt)?)?;
    match std::fs::rename(&staged, &destination) {
        Ok(()) => {}
        Err(error) if marker.is_file() => {
            let expected: Receipt = serde_json::from_slice(&std::fs::read(&marker)?)?;
            if inventory(&destination)? != expected.files {
                return Err(error.into());
            }
        }
        Err(error) => return Err(error.into()),
    }
    Ok(executable(&destination))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tar_fixture(link_target: &str) -> Vec<u8> {
        let gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        let mut archive = tar::Builder::new(gzip);
        for (name, target) in [
            ("package/lib/first", "second"),
            ("package/lib/second", link_target),
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_mode(0o755);
            header.set_size(0);
            header.set_entry_type(tar::EntryType::Symlink);
            archive.append_link(&mut header, name, target).unwrap();
        }
        let mut header = tar::Header::new_gnu();
        header.set_size(7);
        header.set_mode(0o755);
        archive
            .append_data(&mut header, "package/lib/library", &b"library"[..])
            .unwrap();
        archive.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn archive_library_aliases_are_materialized_even_when_the_target_appears_later() {
        let root = tempfile::tempdir().unwrap();
        unpack(&tar_fixture("library"), false, root.path()).unwrap();
        assert_eq!(
            std::fs::read(root.path().join("package/lib/first")).unwrap(),
            b"library"
        );
        assert!(
            !std::fs::symlink_metadata(root.path().join("package/lib/first"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[test]
    fn archive_links_cannot_copy_files_from_outside_the_verified_archive() {
        let outer = tempfile::tempdir().unwrap();
        let root = outer.path().join("staging");
        std::fs::create_dir(&root).unwrap();
        let secret = outer.path().join("outside");
        std::fs::write(&secret, "outside the archive").unwrap();
        assert!(unpack(&tar_fixture(secret.to_str().unwrap()), false, &root).is_err());
        assert!(!root.join("package/lib/second").exists());
    }

    #[test]
    fn runtime_requires_a_published_digest_and_source_revision() {
        let mut metadata = serde_json::json!({ "draft": false, "tag_name": "nightly", "target_commitish": "a".repeat(40), "assets": [{"name": "cpu.zip", "size": 20, "digest": format!("sha256:{}", "b".repeat(64))}] });
        assert!(published_digest(&metadata, "cpu.zip").is_ok());
        metadata["assets"][0]["digest"] = serde_json::Value::Null;
        assert!(published_digest(&metadata, "cpu.zip").is_err());
    }

    #[test]
    fn modified_runtime_files_fail_inventory_comparison() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("runtime"), b"verified").unwrap();
        let before = inventory(root.path()).unwrap();
        std::fs::write(root.path().join("runtime"), b"changed").unwrap();
        assert_ne!(before, inventory(root.path()).unwrap());
    }
}
