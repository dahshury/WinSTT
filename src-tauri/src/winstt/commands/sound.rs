// PORT IMPL — drafted against real APIs, pending compile. Source: app/PORT/10_frontend_port_plan.md
// §6 WU-5 (recording-sound shares audio plumbing) + the AUTHORITATIVE
// frontend/electron/lib/sound-library.ts. Verbatim port of the custom recording-sound
// file-library manager.
//
// The renderer's `features/recording-sound` slice persists user-supplied recording
// sounds (.wav / .mp3) under `<appData>/sounds/`. It drives these via the
// `window.electronAPI` polyfill (electron-tauri-adapter.ts), which routes the WinSTT
// `sound:library-*` channels to these commands with BYTE-IDENTICAL arg shapes:
//
//   sound:library-add        → sound_library_add        { sourcePath, name? }  -> SoundLibraryAddResult
//   sound:library-remove     → sound_library_remove     { path }               -> SoundLibraryRemoveResult
//   sound:library-read-file  → sound_library_read_file  { path }               -> Vec<u8> | null
//
// Result shapes mirror `SoundLibraryAddResult` / `SoundLibraryRemoveResult` in
// `ipc-client.ts` (camelCase). The renderer plays/decodes the bytes itself via Web
// Audio (`use-sound-preview.ts`), so these commands are pure fs operations.
//
// SAFETY: `add` only accepts .wav / .mp3 and copies into the managed folder under a
// random uuid filename; `remove` refuses any path outside the managed folder (the
// renderer can't be tricked into unlinking arbitrary disk paths).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager};

use crate::winstt::commands::settings::read_settings;

/// Process-local monotonic counter, combined with the wall-clock nanos to form a
/// collision-free library filename id (no `uuid` crate dependency — mirrors the
/// codebase's `format!("fq-{counter}-{millis}")` idiom in file_transcribe_manager).
static SOUND_ID_SEQ: AtomicU64 = AtomicU64::new(0);

/// A unique id for a new library file (`<nanos>-<seq>`). Unique within the folder;
/// the renderer never parses it, only stores it.
fn next_sound_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = SOUND_ID_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{nanos}-{seq}")
}

/// One persisted library entry surfaced to the renderer (matches `SoundLibraryEntryDTO`).
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SoundLibraryEntry {
    pub id: String,
    pub name: String,
    pub path: String,
}

/// Result of `sound_library_add` (matches `SoundLibraryAddResult`).
#[derive(Clone, Debug, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct SoundLibraryAddResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry: Option<SoundLibraryEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Result of `sound_library_remove` (matches `SoundLibraryRemoveResult`).
#[derive(Clone, Debug, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct SoundLibraryRemoveResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The managed sound-library folder (`<appData>/sounds/`), created on first use.
/// Mirrors `getLibraryDir()` in `sound-library.ts`.
fn library_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = crate::portable::app_data_dir(app).map_err(|e| e.to_string())?;
    let dir = base.join("sounds");
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create sounds dir: {e}"))?;
    }
    Ok(dir)
}

/// True when `p` resolves to a file strictly inside the managed library folder.
/// Mirrors `isInLibrary()` — the `remove` guard against arbitrary unlinks.
fn is_in_library(app: &AppHandle, p: &str) -> bool {
    let Ok(dir) = library_dir(app) else {
        return false;
    };
    let resolved = std::path::absolute(p).unwrap_or_else(|_| PathBuf::from(p));
    let dir_resolved = std::path::absolute(&dir).unwrap_or(dir);
    resolved.starts_with(&dir_resolved)
}

/// Allowed extension (lower-cased, with dot) or `None`. Mirrors `sanitizeExtension`.
fn sanitize_extension(source_path: &str) -> Option<String> {
    let ext = Path::new(source_path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e.to_lowercase()))?;
    if ext == ".wav" || ext == ".mp3" {
        Some(ext)
    } else {
        None
    }
}

/// Derive a display name from the file stem (fallback "Untitled"). Mirrors
/// `defaultDisplayName`.
fn default_display_name(source_path: &str) -> String {
    let base = Path::new(source_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if base.is_empty() {
        "Untitled".to_string()
    } else {
        base
    }
}

/// Prefer an explicit, non-blank caller name; otherwise derive from the file.
fn resolve_display_name(name: Option<&str>, source_path: &str) -> String {
    match name {
        Some(n) if !n.trim().is_empty() => n.trim().to_string(),
        _ => default_display_name(source_path),
    }
}

/// `sound_library_add` — copy `source_path` (.wav / .mp3 only) into the managed
/// folder under a fresh uuid filename and return its entry. Mirrors `handleAdd`.
#[tauri::command]
#[specta::specta]
pub fn sound_library_add(
    app: AppHandle,
    source_path: String,
    name: Option<String>,
) -> SoundLibraryAddResult {
    if source_path.is_empty() {
        return SoundLibraryAddResult {
            ok: false,
            error: Some("Invalid source path".into()),
            ..Default::default()
        };
    }
    let Some(ext) = sanitize_extension(&source_path) else {
        return SoundLibraryAddResult {
            ok: false,
            error: Some("Only .wav and .mp3 files are accepted".into()),
            ..Default::default()
        };
    };
    if !Path::new(&source_path).exists() {
        return SoundLibraryAddResult {
            ok: false,
            error: Some("Source file not found".into()),
            ..Default::default()
        };
    }
    let dir = match library_dir(&app) {
        Ok(d) => d,
        Err(e) => {
            return SoundLibraryAddResult {
                ok: false,
                error: Some(e),
                ..Default::default()
            };
        }
    };
    let id = next_sound_id();
    let dest = dir.join(format!("{id}{ext}"));
    match std::fs::copy(&source_path, &dest) {
        Ok(_) => SoundLibraryAddResult {
            ok: true,
            entry: Some(SoundLibraryEntry {
                id,
                name: resolve_display_name(name.as_deref(), &source_path),
                path: dest.to_string_lossy().to_string(),
            }),
            error: None,
        },
        Err(err) => SoundLibraryAddResult {
            ok: false,
            error: Some(format!("Failed to copy file: {err}")),
            ..Default::default()
        },
    }
}

/// `sound_library_remove` — delete a file, but ONLY inside the managed folder.
/// Mirrors `handleRemove`.
#[tauri::command]
#[specta::specta]
pub fn sound_library_remove(app: AppHandle, path: String) -> SoundLibraryRemoveResult {
    if path.is_empty() {
        return SoundLibraryRemoveResult {
            ok: false,
            error: Some("Invalid path".into()),
        };
    }
    if !is_in_library(&app, &path) {
        return SoundLibraryRemoveResult {
            ok: false,
            error: Some("Refusing to delete file outside library folder".into()),
        };
    }
    let p = Path::new(&path);
    if p.exists() {
        if let Err(err) = std::fs::remove_file(p) {
            return SoundLibraryRemoveResult {
                ok: false,
                error: Some(err.to_string()),
            };
        }
    }
    SoundLibraryRemoveResult {
        ok: true,
        error: None,
    }
}

/// `sound_library_read_file` — read a sound file's bytes for the renderer's Web
/// Audio preview decode. Returns `None` on any error (the renderer treats null as
/// "couldn't load"). Mirrors `handleReadFile`.
#[tauri::command]
#[specta::specta]
pub fn sound_library_read_file(path: String) -> Option<Vec<u8>> {
    if path.is_empty() {
        return None;
    }
    std::fs::read(&path).ok()
}

// ── recording-sound "get-data" (SOUND_GET_DATA) ────────────────────────────────
// Verbatim port of `frontend/electron/lib/sound.ts::getSoundData` / `getSoundPath`.
//
// The renderer (`features/recording-sound/use-sound-preview.ts` +
// `use-recording-sound.ts`) calls `invoke("sound:get-data")` on mount to fetch the
// ACTIVE recording chime's raw bytes (default OR the user-chosen custom path). It
// decodes them into a Web Audio buffer and plays it on `sound:play`. The adapter
// (electron-tauri-adapter.ts) routes `SOUND_GET_DATA → sound_get_data`, expecting
// `Vec<u8> | null` (`Uint8Array | null` in TS).
//
// Behaviour mirror:
//   - recording sound disabled (`general.recordingSound == false`) → null
//   - `general.recordingSoundPath` set + an allowed audio extension → those bytes
//   - bad/empty custom path → the bundled default chime
//   - any read failure → null (renderer treats null as "no audio, no crash")

/// Allowed audio extensions for the ACTIVE recording chime. Broader than the
/// library's `.wav/.mp3` (the get-data path also accepts the formats Web Audio can
/// decode), matching `ALLOWED_SOUND_EXTENSIONS` in `sound.ts`.
fn is_allowed_recording_sound_ext(path: &str) -> bool {
    matches!(
        Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("wav" | "mp3" | "ogg" | "flac" | "m4a" | "aac")
    )
}

/// Resolve the bundled default chime (`resources/recording_sound_default.wav`,
/// copied from the Electron build's `build/splash.wav`). Mirrors `DEFAULT_SOUND_PATH`.
fn default_recording_sound_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .resolve(
            "resources/recording_sound_default.wav",
            tauri::path::BaseDirectory::Resource,
        )
        .ok()
}

/// Resolve the ACTIVE recording-sound file, or `None` when the chime is disabled.
/// Mirrors `getSoundPath()` in `sound.ts`: disabled → None; a valid custom path →
/// that path; missing/empty/bad-extension custom → the bundled default.
fn active_recording_sound_path(app: &AppHandle) -> Option<PathBuf> {
    let general = read_settings(app).general;
    if !general.recording_sound {
        return None;
    }
    let custom = general.recording_sound_path;
    if !custom.is_empty() {
        if is_allowed_recording_sound_ext(&custom) {
            return Some(PathBuf::from(custom));
        }
        // Bad extension → fall through to the default chime (sound.ts logs + defaults).
        return default_recording_sound_path(app);
    }
    default_recording_sound_path(app)
}

/// `sound_get_data` — serve the ACTIVE recording chime's bytes to the renderer's
/// Web Audio preloader. Returns `None` when the chime is disabled or the file is
/// missing/unreadable (the renderer treats null as "no sound"). Mirrors the
/// `ipcMain.handle("sound:get-data", ...)` body in `sound.ts`.
#[tauri::command]
#[specta::specta]
pub fn sound_get_data(app: AppHandle) -> Option<Vec<u8>> {
    let path = active_recording_sound_path(&app)?;
    std::fs::read(&path).ok()
}
