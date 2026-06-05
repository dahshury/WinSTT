// Source: docs/archive/port/10_frontend_port_plan.md
// §6 WU-5 (recording-sound shares audio plumbing) + the AUTHORITATIVE
// frontend/electron/lib/sound-library.ts. Verbatim port of the custom recording-sound
// file-library manager.
//
// The renderer's `features/recording-sound` slice persists user-supplied recording
// sounds (.wav / .mp3) under `<appData>/sounds/`. It drives these via the
// `window.nativeBridge` polyfill (native-bridge-adapter.ts), which routes the WinSTT
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
use tauri_plugin_dialog::DialogExt;

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
// Structurally identical to `settings_schema::SoundLibraryEntry` (the persisted-schema
// source of truth, which keeps the canonical TS name); suffix this command-result copy.
#[specta(rename = "SoundLibraryEntryResult")]
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
    pub cancelled: Option<bool>,
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
    is_existing_or_stale_path_inside_dir(Path::new(p), &dir)
}

fn is_existing_or_stale_path_inside_dir(path: &Path, dir: &Path) -> bool {
    if let Some(canonical) = canonical_existing_path_inside_dir(path, dir) {
        return canonical.starts_with(
            dir.canonicalize()
                .unwrap_or_else(|_| absolute_path(dir).unwrap_or_else(|| dir.to_path_buf())),
        );
    }
    match (absolute_path(path), absolute_path(dir)) {
        (Some(resolved), Some(dir_resolved)) => resolved.starts_with(&dir_resolved),
        _ => false,
    }
}

fn canonical_existing_path_inside_dir(path: &Path, dir: &Path) -> Option<PathBuf> {
    let dir_resolved = dir.canonicalize().ok()?;
    let resolved = path.canonicalize().ok()?;
    if resolved.starts_with(&dir_resolved) {
        Some(resolved)
    } else {
        None
    }
}

fn canonical_library_file(app: &AppHandle, path: &str) -> Option<PathBuf> {
    let dir = library_dir(app).ok()?;
    canonical_existing_path_inside_dir(Path::new(path), &dir)
}

fn absolute_path(path: &Path) -> Option<PathBuf> {
    std::path::absolute(path).ok()
}

/// Allowed extension (lower-cased, with dot) or `None`. Mirrors `sanitizeExtension`.
fn sanitize_extension_path(source_path: &Path) -> Option<String> {
    let ext = source_path
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

fn sound_add_failed(message: impl Into<String>) -> SoundLibraryAddResult {
    SoundLibraryAddResult {
        ok: false,
        error: Some(message.into()),
        ..Default::default()
    }
}

fn sound_add_cancelled() -> SoundLibraryAddResult {
    SoundLibraryAddResult {
        ok: false,
        cancelled: Some(true),
        ..Default::default()
    }
}

fn copy_sound_into_library(
    app: &AppHandle,
    source_path: &Path,
    name: Option<&str>,
) -> Result<SoundLibraryEntry, String> {
    let Some(ext) = sanitize_extension_path(source_path) else {
        return Err("Only .wav and .mp3 files are accepted".into());
    };
    let metadata = source_path
        .metadata()
        .map_err(|_| "Source file not found".to_string())?;
    if !metadata.is_file() {
        return Err("Source path is not a file".into());
    }
    let dir = match library_dir(app) {
        Ok(d) => d,
        Err(e) => return Err(e),
    };
    let id = next_sound_id();
    let dest = dir.join(format!("{id}{ext}"));
    std::fs::copy(source_path, &dest).map_err(|err| format!("Failed to copy file: {err}"))?;
    let source_display = source_path.to_string_lossy();
    Ok(SoundLibraryEntry {
        id,
        name: resolve_display_name(name, &source_display),
        path: dest.to_string_lossy().to_string(),
    })
}

fn sound_add_success(entry: SoundLibraryEntry) -> SoundLibraryAddResult {
    SoundLibraryAddResult {
        ok: true,
        entry: Some(entry),
        ..Default::default()
    }
}

/// `sound_library_add` is retained for older renderer code but intentionally
/// fails closed: renderer-supplied paths are not a trusted proof of user file
/// selection. Use `sound_library_pick_and_add`, which owns the native picker.
#[tauri::command]
#[specta::specta]
pub fn sound_library_add(
    _app: AppHandle,
    _source_path: String,
    _name: Option<String>,
) -> SoundLibraryAddResult {
    sound_add_failed("Recording sounds must be selected through the native picker")
}

/// Open the native file picker in the backend, copy the selected .wav/.mp3 into
/// the managed library folder, and return the new library entry.
#[tauri::command]
#[specta::specta]
pub async fn sound_library_pick_and_add(
    app: AppHandle,
    name: Option<String>,
) -> SoundLibraryAddResult {
    let Some(chosen) = app
        .dialog()
        .file()
        .set_title("Select Recording Sound")
        .add_filter("Audio", &["wav", "mp3"])
        .blocking_pick_file()
    else {
        return sound_add_cancelled();
    };
    let source_path = match chosen.into_path() {
        Ok(path) => path,
        Err(err) => return sound_add_failed(err.to_string()),
    };
    match copy_sound_into_library(&app, &source_path, name.as_deref()) {
        Ok(entry) => sound_add_success(entry),
        Err(err) => sound_add_failed(err),
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
pub fn sound_library_read_file(app: AppHandle, path: String) -> Option<Vec<u8>> {
    if path.is_empty() {
        return None;
    }
    let resolved = canonical_library_file(&app, &path)?;
    std::fs::read(resolved).ok()
}

// ── recording-sound "get-data" (SOUND_GET_DATA) ────────────────────────────────
// Verbatim port of `frontend/electron/lib/sound.ts::getSoundData` / `getSoundPath`.
//
// The renderer (`features/recording-sound/use-sound-preview.ts` +
// `use-recording-sound.ts`) calls `invoke("sound:get-data")` on mount to fetch the
// ACTIVE recording chime's raw bytes (default OR the user-chosen custom path). It
// decodes them into a Web Audio buffer and plays it on `sound:play`. The adapter
// (native-bridge-adapter.ts) routes `SOUND_GET_DATA → sound_get_data`, expecting
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
/// copied from the reference build's `build/splash.wav`). Mirrors `DEFAULT_SOUND_PATH`.
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
            if let Some(path) = canonical_library_file(app, &custom) {
                return Some(path);
            }
            // Custom sounds are copied into the managed sound library before use.
            // Refuse arbitrary persisted paths so a renderer/settings compromise
            // cannot turn the chime preload into an unrestricted file read.
            return default_recording_sound_path(app);
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

/// Play the ACTIVE recording chime NATIVELY (rodio), off the press path.
///
/// Replaces the old `app.emit("sound:play")` → renderer Web Audio path. The
/// webview chime depended on the main window's `AudioContext`, which (a) starts
/// suspended — a global PTT hotkey gives the page no user-activation gesture, so
/// `resume()` can lag — and (b) gets throttled by WebView2 while the window sits
/// hidden in the tray (the normal dictation state), so the FIRST chime after the
/// app goes idle could arrive late or drop. Playing from Rust like Handy removes
/// both hazards and the IPC→webview hop.
///
/// Parity with the renderer it replaces:
///   - Gating + file selection go through [`active_recording_sound_path`], so no
///     chime when `general.recording_sound` is off, and the same default/custom
///     sound otherwise.
///   - Full volume (the renderer chime applied no gain; there is no
///     recording-sound volume setting).
///
/// Output routing differs by necessity: the renderer routed via
/// `general.outputDeviceId`, a Web-Audio `sinkId` the backend can't map to a
/// cpal device. Native playback uses the cpal-name `selected_output_device` when
/// set, else the system default — i.e. exactly Handy's behavior. TTS/history
/// playback keep their Web-Audio sinkId routing (unchanged).
///
/// Fire-and-forget on a worker thread: rodio's `sink.sleep_until_end()` blocks,
/// and the press path must not. Mirrors `audio_feedback::play_sound_async`.
pub fn play_recording_chime(app: &AppHandle) {
    let Some(path) = active_recording_sound_path(app) else {
        return;
    };
    let selected_device = crate::settings::get_settings(app).selected_output_device;
    std::thread::spawn(move || {
        if let Err(e) = crate::audio_feedback::play_audio_file(&path, selected_device, 1.0) {
            log::error!("Failed to play recording chime '{}': {e}", path.display());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_existing_path_inside_dir_rejects_traversal() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let library = tmp.path().join("sounds");
        std::fs::create_dir_all(&library).expect("library dir");
        let outside = tmp.path().join("secret.wav");
        std::fs::write(&outside, b"secret").expect("outside file");

        let traversal = library.join("..").join("secret.wav");

        assert!(canonical_existing_path_inside_dir(&traversal, &library).is_none());
    }

    #[test]
    fn stale_path_check_uses_path_components_not_prefix_strings() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let library = tmp.path().join("sounds");
        let sibling = tmp.path().join("sounds_evil");
        std::fs::create_dir_all(&library).expect("library dir");
        std::fs::create_dir_all(&sibling).expect("sibling dir");

        assert!(is_existing_or_stale_path_inside_dir(
            &library.join("missing.wav"),
            &library
        ));
        assert!(!is_existing_or_stale_path_inside_dir(
            &sibling.join("missing.wav"),
            &library
        ));
    }
}
