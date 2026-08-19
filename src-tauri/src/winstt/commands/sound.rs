// The custom recording-sound file-library manager.
//
// The renderer's `features/recording-sound` slice persists user-supplied recording
// sounds (.wav / .mp3) under `<appData>/sounds/`. It calls these generated
// commands directly with byte-identical argument shapes:
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

use crate::command_auth;
use crate::winstt::commands::settings::read_settings;

const ORIGINAL_DEFAULT_SOUND_RESOURCE: &str = "resources/recording_sound_default.wav";
/// Bundled error earcon played on a genuine transcription failure. Deliberately
/// NOT part of `BUILTIN_RECORDING_SOUND_FILES` — it is a fixed system alert, not a
/// user-selectable recording chime, so it never appears in the sound selector.
const ERROR_SOUND_RESOURCE: &str = "resources/error_sound.wav";
const BUILTIN_SOUND_PREFIX: &str = "builtin:";
const BUILTIN_RECORDING_SOUND_FILES: &[&str] = &["marimba_start.wav"];
const MAX_SOUND_DURATION_SECONDS: f64 = 3.0;
const MAX_SOUND_DURATION_TOLERANCE_SECONDS: f64 = 0.05;
const MAX_SOUND_FILE_BYTES: u64 = 32 * 1024 * 1024;
const SOUND_VALIDATION_DECODE_SECONDS: u32 = 4;

/// Process-local monotonic counter, combined with the wall-clock nanos to form a
/// collision-free library filename id (no `uuid` crate dependency — mirrors the
/// codebase's `format!("fq-{counter}-{millis}")` idiom in file_transcribe_manager).
static SOUND_ID_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug)]
enum SoundLibraryOperation {
    Add,
    PickAndAdd,
    Remove,
    ReadFile,
    ReadActiveSound,
}

impl SoundLibraryOperation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Add => "add recording sound",
            Self::PickAndAdd => "open recording sound picker",
            Self::Remove => "remove recording sound",
            Self::ReadFile => "read recording sound",
            Self::ReadActiveSound => "read active recording sound",
        }
    }
}

// The sound-library UI lives in Settings, but the detached model-picker window
// also hosts the listen-mode output-device picker, whose per-device play/preview
// buttons read the recording chime (`sound:library-read-file`) to audition each
// speaker — so it needs read access too. Read-only preview; the add/remove/pick
// mutations are still exercised only from Settings in practice.
const SOUND_LIBRARY_ALLOWED_WINDOWS: &[&str] = &["settings", "model-picker"];

fn authorize_sound_library_operation(
    caller: &tauri::WebviewWindow,
    operation: SoundLibraryOperation,
) -> Result<(), String> {
    command_auth::authorize_webview(
        caller,
        "sound",
        operation.as_str(),
        SOUND_LIBRARY_ALLOWED_WINDOWS,
        "",
    )
}

#[cfg(test)]
fn is_sound_library_operation_allowed(caller: &str) -> bool {
    command_auth::label_in(caller, SOUND_LIBRARY_ALLOWED_WINDOWS)
}

/// A unique id for a new library file (`<nanos>-<seq>`). Unique within the folder;
/// the renderer never parses it, only stores it.
fn next_sound_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
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

fn resource_path(app: &AppHandle, resource: impl AsRef<Path>) -> Option<PathBuf> {
    app.path()
        .resolve(resource, tauri::path::BaseDirectory::Resource)
        .ok()
}

fn built_in_recording_sound_path(app: &AppHandle, path: &str) -> Option<PathBuf> {
    let resource = built_in_recording_sound_resource(path)?;
    resource_path(app, resource)
}

fn built_in_recording_sound_resource(path: &str) -> Option<PathBuf> {
    let file_name = path.strip_prefix(BUILTIN_SOUND_PREFIX)?;
    if !BUILTIN_RECORDING_SOUND_FILES.contains(&file_name) {
        return None;
    }
    Some(Path::new("resources").join(file_name))
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
    validate_sound_source(source_path)?;
    let ext = sanitize_extension_path(source_path).expect("validated extension");
    let dir = library_dir(app)?;
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

/// Server-side source validation shared by the native picker and drag/drop
/// command. Client-side Web Audio validation is only early feedback; this is
/// the authoritative duration/type/size boundary before a file is persisted.
fn validate_sound_source(source_path: &Path) -> Result<(), String> {
    let Some(ext) = sanitize_extension_path(source_path) else {
        return Err("Only .wav and .mp3 files are accepted".into());
    };
    let metadata = source_path
        .metadata()
        .map_err(|_| "Source file not found".to_string())?;
    if !metadata.is_file() {
        return Err("Source path is not a file".into());
    }
    if metadata.len() > MAX_SOUND_FILE_BYTES {
        return Err("Recording sound is too large".into());
    }
    let clip = crate::winstt::managers::transcode::decode_reference_clip(
        source_path,
        16_000,
        SOUND_VALIDATION_DECODE_SECONDS,
    )
    .map_err(|error| format!("Recording sound is unreadable: {error}"))?;
    if clip.trimmed
        || clip.seconds() > MAX_SOUND_DURATION_SECONDS + MAX_SOUND_DURATION_TOLERANCE_SECONDS
    {
        return Err(format!(
            "Recording sounds must be {MAX_SOUND_DURATION_SECONDS:.0} seconds or shorter"
        ));
    }
    debug_assert!(ext == ".wav" || ext == ".mp3");
    Ok(())
}

fn sound_add_success(entry: SoundLibraryEntry) -> SoundLibraryAddResult {
    SoundLibraryAddResult {
        ok: true,
        entry: Some(entry),
        ..Default::default()
    }
}

/// Add a picker/drag-drop path that Tauri granted to this webview's asset scope.
/// Scope is checked before metadata/decode so this cannot probe arbitrary paths.
#[tauri::command]
#[specta::specta]
pub fn sound_library_add(
    app: AppHandle,
    webview: tauri::WebviewWindow,
    source_path: String,
    name: Option<String>,
) -> SoundLibraryAddResult {
    if let Err(err) = authorize_sound_library_operation(&webview, SoundLibraryOperation::Add) {
        return sound_add_failed(err);
    }
    let raw = source_path.trim();
    if raw.is_empty() {
        return sound_add_failed("No recording sound was selected");
    }
    let source = PathBuf::from(raw);
    if sanitize_extension_path(&source).is_none() {
        return sound_add_failed("Only .wav and .mp3 files are accepted");
    }
    let source = source.canonicalize().unwrap_or(source);
    if !webview.asset_protocol_scope().is_allowed(&source) {
        log::warn!(
            "[sound] blocked recording sound outside the caller's file scope: {}",
            source.display()
        );
        return sound_add_failed("That file is not accessible to this window");
    }
    match copy_sound_into_library(&app, &source, name.as_deref()) {
        Ok(entry) => sound_add_success(entry),
        Err(err) => sound_add_failed(err),
    }
}

/// Open the native file picker in the backend, copy the selected .wav/.mp3 into
/// the managed library folder, and return the new library entry.
#[tauri::command]
#[specta::specta]
pub async fn sound_library_pick_and_add(
    app: AppHandle,
    webview: tauri::WebviewWindow,
    name: Option<String>,
) -> SoundLibraryAddResult {
    if let Err(err) = authorize_sound_library_operation(&webview, SoundLibraryOperation::PickAndAdd)
    {
        return sound_add_failed(err);
    }
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
pub fn sound_library_remove(
    app: AppHandle,
    webview: tauri::WebviewWindow,
    path: String,
) -> SoundLibraryRemoveResult {
    if let Err(err) = authorize_sound_library_operation(&webview, SoundLibraryOperation::Remove) {
        return SoundLibraryRemoveResult {
            ok: false,
            error: Some(err),
        };
    }
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
    if p.exists()
        && let Err(err) = std::fs::remove_file(p)
    {
        return SoundLibraryRemoveResult {
            ok: false,
            error: Some(err.to_string()),
        };
    }
    SoundLibraryRemoveResult {
        ok: true,
        error: None,
    }
}

/// `sound_library_read_file` — read a sound file's bytes for the renderer's Web
/// Audio preview decode. Supports the original empty-path bundled default,
/// allow-listed `builtin:<file>` bundled sounds, and managed-library files.
/// Returns `None` on any error (the renderer treats null as "couldn't load").
#[tauri::command]
#[specta::specta]
pub fn sound_library_read_file(
    app: AppHandle,
    webview: tauri::WebviewWindow,
    path: String,
) -> Option<Vec<u8>> {
    authorize_sound_library_operation(&webview, SoundLibraryOperation::ReadFile).ok()?;
    if path.is_empty() {
        let default_path = default_recording_sound_path(&app)?;
        return std::fs::read(default_path).ok();
    }
    if let Some(built_in_path) = built_in_recording_sound_path(&app, &path) {
        return std::fs::read(built_in_path).ok();
    }
    let resolved = canonical_library_file(&app, &path)?;
    std::fs::read(resolved).ok()
}

// ── recording-sound "get-data" (SOUND_GET_DATA) ────────────────────────────────
//
// The renderer (`features/recording-sound/use-sound-preview.ts` +
// `use-recording-sound.ts`) calls `invoke("sound:get-data")` on mount to fetch the
// ACTIVE recording chime's raw bytes (default OR the user-chosen custom path). It
// decodes them into a Web Audio buffer and plays it on `sound:play`. The renderer
// calls `sound_get_data` directly, expecting
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
    resource_path(app, ORIGINAL_DEFAULT_SOUND_RESOURCE)
}

/// Resolve the ACTIVE recording-sound file, or `None` when the chime is disabled.
/// Mirrors `getSoundPath()` in `sound.ts`: disabled -> None; a valid bundled
/// token or custom path -> that path; missing/empty/bad-extension custom -> the
/// bundled default.
fn active_recording_sound_path(app: &AppHandle) -> Option<PathBuf> {
    let general = read_settings(app).general;
    if !general.recording_sound {
        return None;
    }
    let custom = general.recording_sound_path;
    if !custom.is_empty() {
        if let Some(built_in_path) = built_in_recording_sound_path(app, &custom) {
            return Some(built_in_path);
        }
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

/// Prepare a silent Communications renderer after Communications capture opens
/// but before the recording is armed. The chime itself is queued only from the
/// first-frame callback. Capture and render therefore remain in one combined
/// Bluetooth topology instead of creating a playback-only client that replaces
/// an already-running capture stream.
pub(crate) fn prepare_recording_chime_output(app: &AppHandle) {
    if active_recording_sound_path(app).is_none() {
        return;
    }
    let selected_device = crate::settings::get_settings(app).selected_output_device;
    if let Err(e) = crate::audio_feedback::prepare_audio_output(selected_device) {
        log::warn!("Failed to prepare recording chime output: {e}");
    }
}

/// `sound_get_data` — serve the ACTIVE recording chime's bytes to the renderer's
/// Web Audio preloader. Returns `None` when the chime is disabled or the file is
/// missing/unreadable (the renderer treats null as "no sound"). Mirrors the
/// `ipcMain.handle("sound:get-data", ...)` body in `sound.ts`.
#[tauri::command]
#[specta::specta]
pub fn sound_get_data(app: AppHandle, webview: tauri::WebviewWindow) -> Option<Vec<u8>> {
    authorize_sound_library_operation(&webview, SoundLibraryOperation::ReadActiveSound).ok()?;
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
/// app goes idle could arrive late or drop. Playing from Rust removes
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
/// set, else the system default. TTS/history
/// playback keep their Web-Audio sinkId routing (unchanged).
///
/// Fire-and-forget on a worker thread: rodio's `sink.sleep_until_end()` blocks,
/// and the press path must not.
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

/// Play the bundled error earcon NATIVELY (rodio), off the caller's path.
///
/// Fired on a genuine terminal transcription failure ([`SttEvents::transcription_failed`]).
/// Mirrors [`play_recording_chime`]'s native-playback rationale (a global hotkey
/// gives the webview no user-activation gesture, and WebView2 throttles a hidden
/// window's `AudioContext`), and routes to the same `selected_output_device` at
/// full volume. Unlike the recording chime it is NOT gated on `general.recording_sound`:
/// it is an error alert, not the start-of-recording chime, so it always sounds.
///
/// Fire-and-forget on a worker thread: rodio's `sink.sleep_until_end()` blocks.
pub fn play_error_sound(app: &AppHandle) {
    let Some(path) = resource_path(app, ERROR_SOUND_RESOURCE) else {
        return;
    };
    let selected_device = crate::settings::get_settings(app).selected_output_device;
    std::thread::spawn(move || {
        if let Err(e) = crate::audio_feedback::play_audio_file(&path, selected_device, 1.0) {
            log::error!("Failed to play error sound '{}': {e}", path.display());
        }
    });
}

/// Play the ACTIVE recording chime synchronously (blocks until playback ends).
///
/// Used by the Settings UI "test sound" command, which is invoked on the blocking
/// pool and expects the sound to play to completion. Shares gating + file
/// selection with [`active_recording_sound_path`] (so a disabled chime stays
/// silent and the same default/custom file is used) — the single recording-sound
/// pathway the rest of the app uses, no separate AppSettings sound theme.
pub(crate) fn play_recording_chime_blocking(app: &AppHandle) {
    let Some(path) = active_recording_sound_path(app) else {
        return;
    };
    let selected_device = crate::settings::get_settings(app).selected_output_device;
    if let Err(e) = crate::audio_feedback::play_audio_file(&path, selected_device, 1.0) {
        log::error!("Failed to play recording chime '{}': {e}", path.display());
    }
}

fn recording_generation_is_active(app: &AppHandle, recording_generation: u64) -> bool {
    app.try_state::<std::sync::Arc<crate::managers::audio::AudioRecordingManager>>()
        .is_some_and(|audio| audio.is_active_recording_generation(recording_generation))
}

/// Duck background system audio for dictation, THEN play the recording chime at
/// full volume.
///
/// The duck lowers OTHER processes' audio sessions while protecting WinSTT's own
/// process tree, and the chime plays in-process through rodio — so background
/// audio (music, video, browser) drops to the configured level FIRST and the
/// chime itself is never attenuated. This is the order the recording-sound
/// feature needs: everything else quiets, the chime stays loud.
///
/// The duck is gated on this recording still actively capturing: on a super-fast
/// tap the stop event's `request_restore` may already have fired, so ducking here
/// would otherwise leave background audio stuck low.
pub fn duck_then_play_recording_chime(app: &AppHandle, recording_generation: u64) {
    let path = active_recording_sound_path(app);
    let selected_device = crate::settings::get_settings(app).selected_output_device;
    let app_handle = app.clone();
    std::thread::spawn(move || {
        // 1. Duck background audio first (only while this recording is live).
        //    The closure re-checks liveness ON the ducking worker right before
        //    the COM duck (a stop that lands while this request is in flight
        //    skips the duck instead of stranding it) and again from the
        //    watchdog while the duck is held.
        if recording_generation_is_active(&app_handle, recording_generation) {
            let gate_app = app_handle.clone();
            crate::winstt::ducking::duck_from_settings_blocking(&app_handle, move || {
                recording_generation_is_active(&gate_app, recording_generation)
            });
        }
        // 2. Then play the chime at full volume (protected from the duck above).
        let Some(path) = path else {
            return;
        };
        if let Err(e) = crate::audio_feedback::play_audio_file_using_prepared_output(
            &path,
            selected_device,
            1.0,
        ) {
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

    #[test]
    fn built_in_recording_sound_resource_allows_only_packaged_sounds() {
        assert_eq!(
            built_in_recording_sound_resource("builtin:marimba_start.wav"),
            Some(Path::new("resources").join("marimba_start.wav"))
        );

        assert!(built_in_recording_sound_resource("builtin:marimba_stop.wav").is_none());
        assert!(built_in_recording_sound_resource("builtin:pop_start.wav").is_none());
        assert!(built_in_recording_sound_resource("builtin:pop_stop.wav").is_none());
        assert!(built_in_recording_sound_resource("builtin:recording_sound_default.wav").is_none());
        // The UI-earcon alternates were removed from the bundle.
        assert!(
            built_in_recording_sound_resource("builtin:recording_sound_ui_earcon_1.wav").is_none()
        );
        assert!(
            built_in_recording_sound_resource("builtin:recording_sound_ui_earcon_4.wav").is_none()
        );
        assert!(built_in_recording_sound_resource("builtin:../marimba_start.wav").is_none());
        assert!(built_in_recording_sound_resource("marimba_start.wav").is_none());
    }

    #[test]
    fn sound_library_authorization_allows_settings_and_model_picker() {
        command_auth::assert_label_rules(
            // model-picker hosts the listen-mode output-device preview buttons.
            &["settings", "model-picker"],
            &[
                "main",
                "overlay",
                "tray-menu",
                "history",
                "onboarding",
                "context-playground",
            ],
            is_sound_library_operation_allowed,
        );
    }

    fn write_test_wav(path: &Path, seconds: usize) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).expect("create wav");
        for _ in 0..(16_000 * seconds) {
            writer.write_sample(0_i16).expect("write sample");
        }
        writer.finalize().expect("finalize wav");
    }

    #[test]
    fn sound_source_duration_is_validated_server_side() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let short = tmp.path().join("short.wav");
        let long = tmp.path().join("long.wav");
        write_test_wav(&short, 1);
        write_test_wav(&long, 4);

        assert!(validate_sound_source(&short).is_ok());
        assert!(
            validate_sound_source(&long)
                .expect_err("long sound must be rejected")
                .contains("3 seconds")
        );
    }
}
