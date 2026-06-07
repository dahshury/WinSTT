// Resolve the espeak-ng shared lib + espeak-ng-data home from env/system/loader
// bundle, with Windows path normalization. Split out of `phonemize.rs` — pure
// path-resolution helpers shared by the in-process FFI backend (mod.rs) and the
// runtime-pack installer (runtime.rs).

use std::path::{Path, PathBuf};

/// Resolve the espeak-ng shared library path + the directory CONTAINING
/// `espeak-ng-data`. Precedence (parity with `phonemizer`'s lookup):
///   1. `ESPEAK_NG_LIBRARY` / `PHONEMIZER_ESPEAK_LIBRARY` / `WINSTT_ESPEAK_LIB`
///      explicit shared-lib path (+ `ESPEAK_DATA_PATH` / `PHONEMIZER_ESPEAK_DATA_PATH`).
///   2. The on-demand `espeakng_loader` runtime under
///      `%LOCALAPPDATA%/winstt/tts/runtime/espeakng_loader/`.
///   3. Common system install dirs (`C:\Program Files\eSpeak NG\`, PATH).
///
/// Returns None if no shared lib + `espeak-ng-data/phontab` pair is found
/// (caller falls back to CLI / null or installs the runtime pack).
pub fn resolve_espeak_lib() -> Option<(PathBuf, Option<PathBuf>)> {
    let lib_name = espeak_shared_lib_name();

    // (1) explicit lib path override.
    for var in [
        "ESPEAK_NG_LIBRARY",
        "PHONEMIZER_ESPEAK_LIBRARY",
        "WINSTT_ESPEAK_LIB",
    ] {
        if let Ok(p) = std::env::var(var) {
            let p = p.trim();
            if !p.is_empty() && Path::new(p).exists() {
                let lib = PathBuf::from(p);
                let data = explicit_data_dir(&lib);
                if data.as_deref().and_then(resolve_espeak_data_home).is_some() {
                    return Some((lib, data));
                }
            }
        }
    }

    // Candidate dirs that may contain the shared lib (+ its espeak-ng-data).
    let mut dirs: Vec<PathBuf> = Vec::new();
    // (2) the on-demand espeakng_loader runtime.
    if let Some(local) = local_app_data() {
        dirs.push(local.join("winstt/tts/runtime/espeakng_loader"));
    }
    // also honor an explicit data-path env that points at espeakng_loader.
    if let Ok(dp) = std::env::var("ESPEAK_DATA_PATH") {
        let dp = PathBuf::from(dp);
        // dp may be the espeak-ng-data dir itself or its parent; try the parent.
        if let Some(parent) = dp.parent() {
            dirs.push(parent.to_path_buf());
        }
        dirs.push(dp);
    }
    // (3) common Windows install locations.
    dirs.push(PathBuf::from(r"C:\Program Files\eSpeak NG"));
    dirs.push(PathBuf::from(r"C:\Program Files (x86)\eSpeak NG"));

    for dir in dirs {
        let lib = dir.join(&lib_name);
        if lib.exists() {
            let data = espeak_data_dir_for(&dir);
            if data.as_deref().and_then(resolve_espeak_data_home).is_some() {
                return Some((lib, data));
            }
        }
    }
    None
}

/// The espeak-ng shared-lib filename for the current platform.
pub(crate) fn espeak_shared_lib_name() -> String {
    #[cfg(windows)]
    {
        "espeak-ng.dll".to_string()
    }
    #[cfg(target_os = "macos")]
    {
        "libespeak-ng.dylib".to_string()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        "libespeak-ng.so".to_string()
    }
}

/// The data dir to pass to `espeak_Initialize` (the parent of `espeak-ng-data`).
/// `espeakng_loader` ships `espeak-ng-data` right beside the lib, so the lib's
/// own directory is the correct parent.
pub(crate) fn espeak_data_dir_for(lib_dir: &Path) -> Option<PathBuf> {
    if lib_dir.join("espeak-ng-data").is_dir() {
        Some(lib_dir.to_path_buf())
    } else {
        None
    }
}

/// The directory espeak-ng must use as its data home — the one that DIRECTLY
/// contains `phontab`. This espeak-ng build sets `path_home = path` without
/// appending `espeak-ng-data` (matching the reference `espeakng_loader` +
/// phonemizer, which init with `get_data_path()` = the `espeak-ng-data` dir
/// itself). The resolver hands us either that dir or its parent (the lib dir,
/// with `espeak-ng-data` beside it), so accept both. Returns None when `phontab`
/// can't be located — the caller MUST NOT then call `espeak_Initialize`, which
/// `exit(1)`s the whole process on missing phoneme data.
pub(crate) fn resolve_espeak_data_home(data_dir: &Path) -> Option<PathBuf> {
    let base = strip_unc_prefix(data_dir);
    if base.join("phontab").is_file() {
        return Some(base);
    }
    let nested = base.join("espeak-ng-data");
    if nested.join("phontab").is_file() {
        return Some(nested);
    }
    None
}

/// Strip Windows' `\\?\` verbatim (extended-length) path prefix. espeak-ng's C
/// code joins paths with `/`, which a `\\?\` path rejects (the prefix disables
/// separator normalization), so paths from Tauri's `resource_dir()` must be
/// cleaned before crossing into espeak. No-op on non-prefixed paths.
pub(crate) fn strip_unc_prefix(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        // UNC form: `\\?\UNC\server\share` → `\\server\share`.
        if let Some(unc) = rest.strip_prefix(r"UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        return PathBuf::from(rest);
    }
    p.to_path_buf()
}

/// Derive the data dir for an explicit lib path, honoring `ESPEAK_DATA_PATH` /
/// `PHONEMIZER_ESPEAK_DATA_PATH`, else the lib's own directory.
fn explicit_data_dir(lib_path: &Path) -> Option<PathBuf> {
    for var in ["ESPEAK_DATA_PATH", "PHONEMIZER_ESPEAK_DATA_PATH"] {
        if let Ok(dp) = std::env::var(var) {
            let dp = PathBuf::from(dp.trim());
            if dp.join("espeak-ng-data").is_dir() {
                return Some(dp);
            }
            if let Some(parent) = dp.parent() {
                if parent.join("espeak-ng-data").is_dir() {
                    return Some(parent.to_path_buf());
                }
            }
        }
    }
    lib_path.parent().and_then(espeak_data_dir_for)
}

/// `%LOCALAPPDATA%` (Windows) — used to find the espeakng_loader bundle.
pub(crate) fn local_app_data() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
}
