// Audits the APP's TTS cache against the download manager's own manifest.
//
// The bench and probe harnesses read `<repo>/.tts-cache`, but the app reads its
// app-data dir — so a model that has been benchmarked to death can still show as
// "not downloaded" in the picker. This walks every catalog row x quant, rebuilds
// the EXACT file list `TtsDownloadManager::cache_info` checks (`manifest_in` is a
// pure function of row/quant/dir), and reports which are genuinely present.
//
//   cargo run --release --example tts_cache_audit
//   cargo run --release --example tts_cache_audit -- <cache-root>
//
// Default root is the app's: %LOCALAPPDATA%/winstt/tts.

use std::path::{Path, PathBuf};

use winstt_app_lib::winstt::downloads::onnx_is_truncated;
use winstt_app_lib::winstt::managers::tts_download_manager::TtsDownloadManager;
use winstt_app_lib::winstt::tts::catalog::TTS_CATALOG;

fn default_root() -> PathBuf {
    std::env::var("WINSTT_TTS_CACHE").map_or_else(
        |_| {
            PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into()))
                .join("winstt")
                .join("tts")
        },
        PathBuf::from,
    )
}

/// Mirrors `TtsDownloadManager::is_cached_file`: a present-but-truncated ONNX is
/// treated as missing, because that is exactly what makes the app re-download.
fn cached(target: &Path) -> bool {
    target.exists()
        && !(target.extension().is_some_and(|e| e == "onnx") && onnx_is_truncated(target))
}

fn main() {
    let root = std::env::args()
        .nth(1)
        .map_or_else(default_root, PathBuf::from);
    println!("cache root: {}\n", root.display());

    let (mut ready, mut partial, mut absent) = (Vec::new(), Vec::new(), Vec::new());
    for entry in TTS_CATALOG {
        for quant in entry.quants {
            let dir = root.join(entry.id);
            let manifest = TtsDownloadManager::manifest_in(entry, quant.id, &dir);
            let total = manifest.len();
            let have = manifest.iter().filter(|(_, p)| cached(p)).count();
            let bytes: u64 = manifest
                .iter()
                .filter(|(_, p)| cached(p))
                .filter_map(|(_, p)| std::fs::metadata(p).ok().map(|m| m.len()))
                .sum();
            let label = format!("{:<30} {:<8}", entry.id, quant.id);
            match have {
                h if h == total => {
                    let delta = bytes as i128 - quant.size_bytes as i128;
                    ready.push(format!(
                        "{label} {have}/{total} files  {:>13} B  (catalog delta {delta:+})",
                        bytes
                    ));
                }
                0 => absent.push(format!("{label} 0/{total} files")),
                _ => {
                    let missing: Vec<String> = manifest
                        .iter()
                        .filter(|(_, p)| !cached(p))
                        .map(|(_, p)| {
                            p.strip_prefix(&dir)
                                .unwrap_or(p)
                                .to_string_lossy()
                                .into_owned()
                        })
                        .collect();
                    partial.push(format!(
                        "{label} {have}/{total} files — missing: {}",
                        missing.join(", ")
                    ));
                }
            }
        }
    }

    println!("READY ({}):", ready.len());
    for l in &ready {
        println!("  {l}");
    }
    println!(
        "\nPARTIAL ({}) — the app WILL re-download these:",
        partial.len()
    );
    for l in &partial {
        println!("  {l}");
    }
    println!("\nNOT CACHED ({}):", absent.len());
    for l in &absent {
        println!("  {l}");
    }
}
