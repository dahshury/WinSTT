// On-demand espeakng_loader runtime pack: descriptor, pinned cfg'd static packs,
// download/verify/extract(wheel)/install + availability/messages. Split out of
// `phonemize.rs`; consumed by `tts_manager.rs` as its own import group. Has
// nothing to do with G2P beyond depending on the resolver helpers.

use std::path::{Path, PathBuf};

use crate::winstt::downloads::{transfer_url_blocking, TransferOutcome, TransferRequest};

use super::resolve::{
    espeak_shared_lib_name, local_app_data, resolve_espeak_data_home, resolve_espeak_lib,
};
use super::{PhonemizeError, PhonemizeResult};

#[derive(Clone, Copy, Debug)]
pub struct EspeakRuntimePack {
    pub filename: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub size_bytes: u64,
}

pub const ESPEAK_RUNTIME_COMPONENT_ID: &str = "espeakng_loader";
pub const ESPEAK_RUNTIME_COMPONENT_LABEL: &str = "eSpeak NG runtime";

#[cfg(all(windows, target_arch = "x86_64"))]
static ESPEAK_RUNTIME_PACK: Option<EspeakRuntimePack> = Some(EspeakRuntimePack {
    filename: "espeakng_loader-0.2.4-py3-none-win_amd64.whl",
    url: "https://files.pythonhosted.org/packages/9d/ed/a3d872fbad4f3a3f3db0e8c31768ab14e77cd77306de16b8b20b1e1df7ea/espeakng_loader-0.2.4-py3-none-win_amd64.whl",
    sha256: "41f1e08ac9deda2efd1ea9de0b81dab9f5ae3c4b24284f76533d0a7b1dd7abd7",
    size_bytes: 9_437_292,
});

#[cfg(all(windows, target_arch = "aarch64"))]
static ESPEAK_RUNTIME_PACK: Option<EspeakRuntimePack> = Some(EspeakRuntimePack {
    filename: "espeakng_loader-0.2.4-py3-none-win_arm64.whl",
    url: "https://files.pythonhosted.org/packages/29/64/0b75bc50ec53b4e000bac913625511215aa96124adf5dba8c4baa17c02cd/espeakng_loader-0.2.4-py3-none-win_arm64.whl",
    sha256: "d7a2928843eaeb2df82f99a370f44e8a630f59b02f9b0d1f168a03c4eeb76b89",
    size_bytes: 9_426_841,
});

#[cfg(not(any(
    all(windows, target_arch = "x86_64"),
    all(windows, target_arch = "aarch64")
)))]
static ESPEAK_RUNTIME_PACK: Option<EspeakRuntimePack> = None;

pub fn espeak_runtime_pack() -> Option<&'static EspeakRuntimePack> {
    ESPEAK_RUNTIME_PACK.as_ref()
}

/// `%LOCALAPPDATA%/winstt/tts/runtime/espeakng_loader`, matching
/// `resolve_espeak_lib`'s on-demand lookup tier.
pub fn espeak_runtime_loader_dir() -> Option<PathBuf> {
    local_app_data().map(|local| local.join("winstt/tts/runtime/espeakng_loader"))
}

pub fn espeak_runtime_available() -> bool {
    resolve_espeak_lib().is_some_and(|(lib, data)| {
        lib.is_file() && data.as_deref().and_then(resolve_espeak_data_home).is_some()
    })
}

pub fn espeak_runtime_install_required_message() -> String {
    let path = espeak_runtime_loader_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "%LOCALAPPDATA%\\winstt\\tts\\runtime\\espeakng_loader".to_string());
    format!(
        "eSpeak NG runtime is required for this TTS model. Expected espeak-ng.dll \
         and espeak-ng-data under {path}. Install eSpeak NG and set ESPEAK_NG_LIBRARY, \
         or retry on a platform with a pinned espeakng_loader runtime pack."
    )
}

/// Ensure the pinned espeakng_loader runtime is installed under LOCALAPPDATA.
/// Returns `Ok(true)` when it installed the pack in this call, `Ok(false)` when
/// an env/system/local shared library was already available.
pub fn ensure_espeak_runtime(mut on_progress: impl FnMut(f64, u64, u64)) -> PhonemizeResult<bool> {
    if espeak_runtime_available() {
        return Ok(false);
    }
    let Some(pack) = espeak_runtime_pack() else {
        return Err(PhonemizeError::EspeakUnavailable(
            espeak_runtime_install_required_message(),
        ));
    };
    let Some(target) = espeak_runtime_loader_dir() else {
        return Err(PhonemizeError::EspeakUnavailable(format!(
            "{} LOCALAPPDATA is not set.",
            espeak_runtime_install_required_message()
        )));
    };
    let runtime_dir = target
        .parent()
        .ok_or_else(
            || PhonemizeError::EspeakUnavailable(espeak_runtime_install_required_message()),
        )?
        .to_path_buf();
    std::fs::create_dir_all(&runtime_dir).map_err(|e| {
        PhonemizeError::EspeakUnavailable(format!(
            "failed to create TTS runtime dir {}: {e}",
            runtime_dir.display()
        ))
    })?;

    let archive = runtime_dir.join(pack.filename);
    if !archive.exists() || file_sha256(&archive).ok().as_deref() != Some(pack.sha256) {
        download_espeak_runtime_pack(pack, &archive, &mut on_progress)?;
    }
    verify_espeak_runtime_archive(pack, &archive)?;
    extract_espeak_loader_from_wheel(&archive, &target)?;

    if espeak_loader_dir_present(&target) {
        let _ = std::fs::remove_file(&archive);
        Ok(true)
    } else {
        Err(PhonemizeError::EspeakUnavailable(format!(
            "espeakng_loader runtime extracted but is incomplete at {}",
            target.display()
        )))
    }
}

fn download_espeak_runtime_pack(
    pack: &EspeakRuntimePack,
    target: &Path,
    on_progress: &mut impl FnMut(f64, u64, u64),
) -> PhonemizeResult<()> {
    let partial = target.with_file_name(format!(
        "{}.partial",
        target
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("espeak")
    ));
    let client = reqwest::Client::builder()
        .user_agent("WinSTT/0.1")
        .build()
        .map_err(|e| PhonemizeError::EspeakUnavailable(e.to_string()))?;
    let _ = std::fs::remove_file(target);
    let report = transfer_url_blocking(
        &client,
        TransferRequest {
            delete_partial_on_cancel: true,
            final_path: Some(target),
            known_total_bytes: Some(pack.size_bytes),
            partial_path: &partial,
            progress_interval: std::time::Duration::from_millis(100),
            url: pack.url,
        },
        None,
        |progress| {
            let total = progress.total_bytes.unwrap_or(pack.size_bytes);
            on_progress(
                progress.progress_fraction.unwrap_or(0.0),
                progress.downloaded_bytes,
                total,
            );
        },
    )
    .map_err(|e| PhonemizeError::EspeakUnavailable(format!("download failed: {e}")))?;
    match report.outcome {
        TransferOutcome::Complete => Ok(()),
        TransferOutcome::Paused => Err(PhonemizeError::EspeakUnavailable(
            "download paused unexpectedly".to_string(),
        )),
        TransferOutcome::Cancelled => Err(PhonemizeError::EspeakUnavailable(
            "download cancelled unexpectedly".to_string(),
        )),
    }
}

fn verify_espeak_runtime_archive(pack: &EspeakRuntimePack, archive: &Path) -> PhonemizeResult<()> {
    let actual = file_sha256(archive).map_err(|e| {
        PhonemizeError::EspeakUnavailable(format!(
            "failed to hash runtime archive {}: {e}",
            archive.display()
        ))
    })?;
    if actual != pack.sha256 {
        let _ = std::fs::remove_file(archive);
        return Err(PhonemizeError::EspeakUnavailable(format!(
            "espeakng_loader runtime integrity check failed (expected {}, got {})",
            pack.sha256, actual
        )));
    }
    Ok(())
}

fn file_sha256(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;

    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(bytes_to_lower_hex(hasher.finalize().as_ref()))
}

fn bytes_to_lower_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

pub(super) fn extract_espeak_loader_from_wheel(wheel: &Path, target: &Path) -> PhonemizeResult<()> {
    use std::ffi::OsStr;
    use std::path::Component;

    let parent = target.parent().ok_or_else(|| {
        PhonemizeError::EspeakUnavailable(format!("invalid runtime path {}", target.display()))
    })?;
    std::fs::create_dir_all(parent)
        .map_err(|e| PhonemizeError::EspeakUnavailable(e.to_string()))?;
    let staging = target.with_file_name(format!(
        "{}.installing.{}",
        target
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("espeakng_loader"),
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&staging);

    let result = (|| -> PhonemizeResult<()> {
        std::fs::create_dir_all(&staging)
            .map_err(|e| PhonemizeError::EspeakUnavailable(e.to_string()))?;
        let file = std::fs::File::open(wheel).map_err(|e| {
            PhonemizeError::EspeakUnavailable(format!("open {}: {e}", wheel.display()))
        })?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| {
            PhonemizeError::EspeakUnavailable(format!("read wheel {}: {e}", wheel.display()))
        })?;
        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| PhonemizeError::EspeakUnavailable(format!("read wheel entry: {e}")))?;
            let Some(path) = entry.enclosed_name() else {
                continue;
            };
            let mut components = path.components();
            match components.next() {
                Some(Component::Normal(name)) if name == OsStr::new("espeakng_loader") => {}
                _ => continue,
            }
            let rel: PathBuf = components.collect();
            if rel.as_os_str().is_empty() {
                continue;
            }
            let out = staging.join(rel);
            if entry.is_dir() {
                std::fs::create_dir_all(&out)
                    .map_err(|e| PhonemizeError::EspeakUnavailable(e.to_string()))?;
                continue;
            }
            if let Some(p) = out.parent() {
                std::fs::create_dir_all(p)
                    .map_err(|e| PhonemizeError::EspeakUnavailable(e.to_string()))?;
            }
            let mut dst = std::fs::File::create(&out)
                .map_err(|e| PhonemizeError::EspeakUnavailable(e.to_string()))?;
            std::io::copy(&mut entry, &mut dst)
                .map_err(|e| PhonemizeError::EspeakUnavailable(e.to_string()))?;
        }
        if !espeak_loader_dir_present(&staging) {
            return Err(PhonemizeError::EspeakUnavailable(format!(
                "wheel did not contain a complete espeakng_loader runtime: {}",
                wheel.display()
            )));
        }
        if target.exists() {
            if target.is_dir() {
                std::fs::remove_dir_all(target).map_err(|e| {
                    PhonemizeError::EspeakUnavailable(format!(
                        "could not replace existing TTS runtime {}: {e}",
                        target.display()
                    ))
                })?;
            } else {
                std::fs::remove_file(target).map_err(|e| {
                    PhonemizeError::EspeakUnavailable(format!(
                        "could not replace existing TTS runtime {}: {e}",
                        target.display()
                    ))
                })?;
            }
        }
        std::fs::rename(&staging, target).map_err(|e| {
            PhonemizeError::EspeakUnavailable(format!(
                "could not install TTS runtime at {}: {e}",
                target.display()
            ))
        })?;
        Ok(())
    })();

    if result.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result
}

pub(super) fn espeak_loader_dir_present(dir: &Path) -> bool {
    dir.join(espeak_shared_lib_name()).is_file()
        && dir.join("espeak-ng-data").join("phontab").is_file()
}
