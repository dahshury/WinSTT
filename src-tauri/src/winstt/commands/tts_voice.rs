// Voice-authoring commands for the TTS picker: preparing a cloning reference
// clip, and the two LLM-backed text helpers (voice-design prompt authoring and
// inline paralinguistic tagging).
//
// The LLM half runs on the CONFIGURED post-processing model
// (`settings.llm.dictation.base` — the same provider/model the dictation
// post-processor uses). There is NO master LLM switch in this app: a feature
// runs iff its own `enabled` is true AND a model is configured, which is what
// `post_processing_ready` below asserts. The caller decides whether to offer the
// button; these commands only refuse to run blind.
//
// Unlike the dictation/transform pipeline these are user-driven, single-shot and
// short, so they:
//   * fail LOUD (the caller shows the error) instead of fail-soft returning the
//     input, which for a settings dialog would look like a no-op;
//   * do NOT take `LlmCommandProcessingGuard` — lighting the tray "thinking"
//     indicator for a settings-dialog button would misreport dictation state;
//   * post-process the answer DETERMINISTICALLY. Model output is untrusted: the
//     instruct is clipped to the catalog's character budget at a word boundary,
//     and the tagged text is filtered against the model's own tag vocabulary so
//     an invented `<whisper>` can never reach the synthesizer and be read aloud.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tokio_util::sync::CancellationToken;

use crate::command_auth;
use crate::winstt::llm;
use crate::winstt::managers::LlmManager;
use crate::winstt::managers::transcode;
use crate::winstt::settings_schema::{LlmFeatureBase, LlmProvider, TtsSource, WinsttSettings};
use crate::winstt::tts::catalog::{
    self, MAX_CLONE_REF_SECS, TagSyntax, VOICE_DESIGN_PROMPT_MAX_CHARS,
};

use super::llm as llm_commands;
use super::llm::conversions as llm_conversions;
use super::llm::conversions::{openrouter_options, to_llm_effort};
use super::settings::read_settings;

/// Voice authoring is a settings-surface affordance; the detached model picker
/// hosts the same TTS rows. Mirrors `TTS_CACHE_MUTATION_ALLOWED_WINDOWS`. Shared
/// with `stt::tts_transcribe_reference`, which gates the same cloning flow's
/// second half — one list, so the two halves can never drift apart.
pub(crate) const TTS_VOICE_ALLOWED_WINDOWS: &[&str] = &["settings", "model-picker"];

// ── reference-clip preparation ───────────────────────────────────────────────

/// Reference clips are normalized to 24 kHz mono, the highest rate any cloning
/// engine here asks for (Chatterbox 24 kHz, Spark 16 kHz). Chatterbox then reads
/// the stored file back with no resampling at all, and Spark downsamples through
/// the shared rubato path — storing at 16 kHz instead would upsample into
/// Chatterbox and throw away the top octave.
const REFERENCE_CLIP_SAMPLE_RATE: u32 = 24_000;

/// Containers the shared symphonia decoder is built with (see `Cargo.toml`'s
/// symphonia features). Anything else is refused at pick time rather than
/// failing later, mid-sentence, inside the engine.
const REFERENCE_CLIP_EXTENSIONS: &[&str] = &["wav", "mp3", "m4a", "mp4", "flac", "ogg", "aac"];

/// A 30 s clip cannot plausibly need more than this even as lossless audio; the
/// guard bounds decode work on a renderer-supplied path.
const MAX_REFERENCE_FILE_BYTES: u64 = 512 * 1024 * 1024;

/// How many source clips one voice may be built from. A voice is a handful of
/// takes, not a library, and the count is the multiplier on every decode this
/// command performs — so it is bounded here rather than trusted from the
/// renderer.
const MAX_REFERENCE_PARTS: usize = 12;

/// Silence welded between consecutive parts of a multi-clip voice. Concatenating
/// two takes with no gap puts a hard splice — a click, and a phoneme boundary
/// that never occurs in speech — into the audio the engine conditions on. A
/// quarter second reads as a breath and costs a fraction of the clip budget.
///
/// `pub` because the capacity meter has to spend it too: the cap below applies to
/// the parts PLUS the gaps between them, so a UI that summed only the parts would
/// promise room that does not exist (worst on a 5 s budget, where three clips lose
/// 10% of it to gaps).
///
/// The renderer HAND-MIRRORS this value at `src/widgets/tts-settings/lib/clone-voice.ts`
/// rather than receiving it: this crate registers no tauri-specta constants, and
/// the per-model caps reach the UI as catalog *fields*, which is a mechanism a bare
/// `const` cannot use. The mirror is not on trust — a parity test parses THIS file
/// and fails if the value here moves without the TypeScript one following.
pub const REFERENCE_GAP_SECS: f64 = 0.25;

/// What the cloning UI needs after a clip is picked or dropped.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceClipInfo {
    /// Length of the STORED clip (already trimmed), seconds.
    pub seconds: f64,
    /// True when the source ran past `max_secs` and its tail was dropped.
    pub trimmed: bool,
    /// The normalized 24 kHz mono WAV the engine loads. Persist THIS in
    /// `settings.tts.voice`, not the user's original file: it survives the
    /// original being moved, and it is the form both engines read fastest.
    pub stored_path: String,
    /// The cap that was applied — echoed so the UI never re-types the number.
    pub max_secs: u32,
}

/// One source clip inside a multi-clip voice, as it was stored.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReferencePart {
    /// The normalized 24 kHz mono WAV this part was persisted as. Re-submitting
    /// exactly this path to `tts_build_reference` rebuilds the voice without the
    /// user's original file — which is how removing one clip from a voice works.
    pub stored_path: String,
    /// Label for the clip row: the source's file stem, with the storage hash
    /// stripped so a rebuilt part still reads as the file the user picked.
    pub name: String,
    /// Length of THIS part alone, seconds. The card sums these against
    /// [`ReferenceBuild::max_secs`] to draw the capacity meter.
    pub seconds: f64,
}

/// What the voice card needs after clips are added, reordered or dropped: the
/// combined clip the engines load, plus the parts it was welded from so the card
/// can list them and hand them back on the next rebuild.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceBuild {
    /// Length of the COMBINED stored clip (already trimmed), seconds.
    pub seconds: f64,
    /// True when the concatenation ran past `max_secs` and its tail was dropped,
    /// or when any single source did.
    pub trimmed: bool,
    /// The combined 24 kHz mono WAV. Persist THIS in `settings.tts.voice` — the
    /// engines take one path and cannot tell a welded clip from a picked one,
    /// which is the whole point: multi-clip lives here, not in the engines.
    pub stored_path: String,
    /// The cap that was applied — echoed so the UI never re-types the number.
    pub max_secs: u32,
    /// The parts, in the order they were welded.
    pub parts: Vec<ReferencePart>,
}

fn has_supported_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            REFERENCE_CLIP_EXTENSIONS
                .iter()
                .any(|allowed| ext.eq_ignore_ascii_case(allowed))
        })
}

/// FNV-1a. Stable across runs and builds (unlike `DefaultHasher`), which is what
/// makes re-picking the same file resolve to the same stored clip instead of
/// growing a new copy every time.
fn stable_hash(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// `<stem>-<hash>.wav`, where the hash covers the source path + its mtime + its
/// size: same file re-picked → same stored clip (so Chatterbox's `(path, mtime)`
/// conditioning cache still hits), edited file → a new one.
fn stored_clip_name(source: &Path) -> String {
    let stem: String = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("voice")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(32)
        .collect();
    let stem = if stem.is_empty() {
        "voice".to_string()
    } else {
        stem
    };
    let mut key = source.to_string_lossy().into_owned();
    if let Ok(meta) = std::fs::metadata(source) {
        key.push('|');
        key.push_str(&meta.len().to_string());
        if let Ok(modified) = meta.modified()
            && let Ok(since) = modified.duration_since(std::time::UNIX_EPOCH)
        {
            key.push('|');
            key.push_str(&since.as_millis().to_string());
        }
    }
    format!("{stem}-{:016x}.wav", stable_hash(key.as_bytes()))
}

/// `tts_prepare_reference_clip` — normalize a picked/dropped audio file into the
/// clip the cloning engines load: decode (wav/mp3/m4a/flac/ogg/aac) to mono f32
/// @ 24 kHz, TRIM to the catalog's per-model cap rather than rejecting a long
/// file, and persist it under the app data dir. Returns the stored path plus
/// whether trimming happened, so the UI can say so.
///
/// The path arrives from the renderer, so it is checked against the caller's
/// asset-protocol scope exactly like `file_transcribe_enqueue` — dialog picks and
/// drag-drops are both added to that scope by Tauri, anything else is not.
#[tauri::command]
#[specta::specta]
pub fn tts_prepare_reference_clip(
    app: AppHandle,
    webview: WebviewWindow,
    path: String,
) -> Result<ReferenceClipInfo, String> {
    command_auth::authorize_webview(
        &webview,
        "tts",
        "prepare a voice reference clip",
        TTS_VOICE_ALLOWED_WINDOWS,
        "",
    )?;

    let raw = path.trim();
    if raw.is_empty() {
        return Err("No audio file was selected".to_string());
    }
    let source = PathBuf::from(raw);
    if !has_supported_extension(&source) {
        return Err(format!(
            "Unsupported audio format — use one of: {}",
            REFERENCE_CLIP_EXTENSIONS.join(", ")
        ));
    }
    // Scope FIRST, then touch the disk: a `metadata` error is reported back to the
    // renderer verbatim, so probing before the scope check would turn this command
    // into an existence/size oracle for arbitrary paths.
    let source = source.canonicalize().unwrap_or(source);
    if !webview.asset_protocol_scope().is_allowed(&source) {
        log::warn!(
            "[tts] blocked reference clip outside the caller's file scope: {}",
            source.display()
        );
        return Err("That file is not accessible to this window".to_string());
    }
    let meta = std::fs::metadata(&source).map_err(|e| format!("cannot read that file: {e}"))?;
    if !meta.is_file() {
        return Err("That path is not a file".to_string());
    }
    if meta.len() > MAX_REFERENCE_FILE_BYTES {
        return Err("That audio file is too large".to_string());
    }

    let max_secs = reference_clip_budget(&read_settings(&app));
    let clip = transcode::decode_reference_clip(&source, REFERENCE_CLIP_SAMPLE_RATE, max_secs)?;
    let seconds = clip.seconds();
    catalog::reject_short_reference(seconds)?;

    let dir = reference_voices_dir(&app)?;
    let stored = dir.join(stored_clip_name(&source));
    crate::audio_toolkit::audio::save_wav_file_with_spec(
        &stored,
        &clip.samples,
        clip.sample_rate,
        1,
    )
    .map_err(|e| format!("cannot save the reference clip: {e}"))?;

    Ok(ReferenceClipInfo {
        seconds,
        trimmed: clip.trimmed,
        stored_path: stored.to_string_lossy().into_owned(),
        max_secs,
    })
}

/// The clip cap for the model the user has selected. Falls back to the catalog
/// constant when the selection does not clone — the picker lets a clip be
/// prepared before the cloning model is switched to, and a `0` there would mean
/// "no cap" rather than "not applicable".
///
/// Shared with `stt::tts_transcribe_reference`: the cap must be derived ONCE,
/// here, or the two halves of the cloning flow measure the clip against two
/// different numbers.
pub(crate) fn reference_clip_budget(settings: &WinsttSettings) -> u32 {
    catalog::find(&settings.tts.model)
        .map(|m| m.max_ref_clip_secs)
        .filter(|max| *max > 0)
        .unwrap_or(MAX_CLONE_REF_SECS)
}

// ── multi-clip voices ────────────────────────────────────────────────────────
//
// A voice is N takes welded into ONE clip. The seam is deliberately narrow:
// everything multi-clip happens here, and what leaves is a single path in the
// same shape `tts_prepare_reference_clip` has always produced, so the engines
// (audio8 `ensure_reference`, spark, omnivoice, chatterbox) cannot tell the
// difference and need no change.

/// The managed folder every stored reference clip lives in, created on demand.
/// The ONE place this path is spelled out — `stt::tts_transcribe_reference`
/// confines to the same folder and would silently stop accepting clips if the two
/// ever disagreed.
fn reference_voices_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::portable::app_data_dir(app)
        .map_err(|e| format!("cannot resolve the app data dir: {e}"))?
        .join("tts")
        .join("reference-voices");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create the voice folder: {e}"))?;
    Ok(dir)
}

/// Canonicalize `path` and keep it only when it really resolves INSIDE `root`.
///
/// Canonicalizing BOTH sides is what makes the containment check robust: a raw
/// `<root>/../elsewhere.wav` passes a string-prefix test, and only resolution
/// catches it (same for symlinks and `.` segments). A path that does not exist
/// cannot be canonicalized and is therefore never confined — callers treat that
/// as "not ours". Mirrors `stt::canonical_path_inside_dir`, which gates the other
/// half of this same cloning flow.
fn canonical_path_inside_dir(path: &Path, root: &Path) -> Option<PathBuf> {
    let root = root.canonicalize().ok()?;
    let resolved = path.canonicalize().ok()?;
    resolved.starts_with(&root).then_some(resolved)
}

/// One renderer-supplied source, checked and resolved.
struct ResolvedSource {
    path: PathBuf,
    /// True when the path already lives in the managed folder. Those come from an
    /// earlier build of this same voice (removing one clip re-submits the others),
    /// have no asset-protocol scope entry because the user never picked them, and
    /// are already normalized — so they are neither scope-checked nor re-stored.
    managed: bool,
}

/// Extension → ACCESS → size, in that order, for one source path.
///
/// Access is either half of the rule: a path the caller's asset-protocol scope
/// allows (Tauri adds dialog picks and drag-drops to it), or a path inside the
/// managed folder. It is checked BEFORE any `metadata` call because the error is
/// reported to the renderer verbatim — probing first would turn this command into
/// an existence/size oracle for arbitrary paths.
fn resolve_reference_source(
    webview: &WebviewWindow,
    raw: &str,
    managed_root: &Path,
) -> Result<ResolvedSource, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("No audio file was selected".to_string());
    }
    let source = PathBuf::from(raw);
    if !has_supported_extension(&source) {
        return Err(format!(
            "Unsupported audio format — use one of: {}",
            REFERENCE_CLIP_EXTENSIONS.join(", ")
        ));
    }
    let (source, managed) = match canonical_path_inside_dir(&source, managed_root) {
        Some(resolved) => (resolved, true),
        None => {
            let resolved = source.canonicalize().unwrap_or(source);
            if !webview.asset_protocol_scope().is_allowed(&resolved) {
                log::warn!(
                    "[tts] blocked reference clip outside the caller's file scope: {}",
                    resolved.display()
                );
                return Err("That file is not accessible to this window".to_string());
            }
            (resolved, false)
        }
    };
    let meta = std::fs::metadata(&source).map_err(|e| format!("cannot read that file: {e}"))?;
    if !meta.is_file() {
        return Err("That path is not a file".to_string());
    }
    if meta.len() > MAX_REFERENCE_FILE_BYTES {
        return Err("That audio file is too large".to_string());
    }
    Ok(ResolvedSource {
        path: source,
        managed,
    })
}

/// The label the voice card shows for a part. A managed path carries the
/// `-<16 hex>` suffix [`stored_clip_name`] appended, which is noise to the user,
/// so it is stripped back to the stem they picked.
fn part_display_name(source: &Path, managed: bool) -> String {
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("voice");
    if !managed {
        return stem.to_string();
    }
    match stem.rsplit_once('-') {
        Some((head, hash))
            if !head.is_empty()
                && hash.len() == 16
                && hash.chars().all(|c| c.is_ascii_hexdigit()) =>
        {
            head.to_string()
        }
        _ => stem.to_string(),
    }
}

/// Append `samples`, stopping at `max_samples` and reporting the drop. TRIM, never
/// reject — the same policy the single-clip path applies, because a user who
/// added one take too many wants the voice built, not an error.
fn append_capped(out: &mut Vec<f32>, samples: &[f32], max_samples: usize, trimmed: &mut bool) {
    let room = max_samples.saturating_sub(out.len());
    if samples.len() > room {
        *trimmed = true;
    }
    out.extend_from_slice(&samples[..room.min(samples.len())]);
}

/// Weld the decoded parts into ONE buffer: `gap_samples` of silence BETWEEN
/// consecutive parts (never before the first or after the last — leading silence
/// shifts every engine's onset, trailing silence is dead budget), truncated to
/// `max_samples`. Returns the buffer and whether anything was dropped.
fn concatenate_parts<S: AsRef<[f32]>>(
    parts: &[S],
    gap_samples: usize,
    max_samples: usize,
) -> (Vec<f32>, bool) {
    let mut out: Vec<f32> = Vec::new();
    let mut trimmed = false;
    let gap = vec![0.0_f32; gap_samples];
    for (index, part) in parts.iter().enumerate() {
        if index > 0 && !gap.is_empty() {
            append_capped(&mut out, &gap, max_samples, &mut trimmed);
        }
        append_capped(&mut out, part.as_ref(), max_samples, &mut trimmed);
    }
    (out, trimmed)
}

/// `voice-<hash>.wav`, hashed over the ORDERED part paths AND the cap they were
/// welded under.
///
/// Same clips in the same order at the same cap → same combined file, so
/// rebuilding a voice overwrites its clip instead of growing a new one on every
/// edit (and Chatterbox's `(path, mtime)` conditioning cache still keys the same
/// way). A different set — or the same set REORDERED, which is different audio —
/// lands on a different name, so the old combined clip is never mistaken for the
/// new one.
///
/// `max_secs` is part of the key because ONE voice is now shared across models
/// with different budgets: the same parts welded for Chatterbox (30 s) and for
/// OmniVoice (5 s) are DIFFERENT audio, and without the cap in the name the
/// second build would silently overwrite the first — leaving the 30 s model
/// cloning from five seconds it never asked for.
fn combined_clip_name(parts: &[PathBuf], max_secs: u32) -> String {
    let mut key = String::new();
    for part in parts {
        key.push_str(&part.to_string_lossy());
        key.push('|');
    }
    key.push_str(&max_secs.to_string());
    format!("voice-{:016x}.wav", stable_hash(key.as_bytes()))
}

/// One decoded source, held in memory until the whole build is known to be
/// acceptable.
///
/// Nothing is written while these are collected: the floor is checked against the
/// finished concatenation, and a build the floor rejects must leave no file
/// behind — an orphan part would be named by no library row, so nothing (not even
/// `tts_delete_reference_clips`, which only ever receives a voice's own paths)
/// could ever remove it.
struct PendingPart {
    /// What the renderer is told about this part once the build is accepted.
    part: ReferencePart,
    /// False for a part that already lives in the managed folder — an earlier
    /// build normalized and wrote it, and a rebuild re-submits it unchanged.
    needs_write: bool,
    sample_rate: u32,
    samples: Vec<f32>,
    /// Where this part lives (or will live) in the managed folder.
    stored: PathBuf,
}

/// `tts_build_reference` — build ONE cloning reference clip out of N sources.
///
/// Each source is decoded to 24 kHz mono and persisted on its own (so the card can
/// list, drop and re-order the parts), then the parts are welded in the given
/// order — separated by [`REFERENCE_GAP_SECS`] of silence — into the single
/// combined clip that goes in `settings.tts.voice`. The model's cap applies to the
/// CONCATENATION and trims rather than rejects, exactly as the single-clip path
/// does; a one-path call is equivalent to `tts_prepare_reference_clip`, down to
/// returning that same stored file and to writing NOTHING when the floor rejects
/// the build.
///
/// Sources arrive from the renderer, so each is checked against the caller's
/// asset-protocol scope — or, for a part this command itself stored, against the
/// managed folder, since a rebuild after removing a clip re-submits the survivors
/// and those were never in any dialog's scope.
#[tauri::command]
#[specta::specta]
pub fn tts_build_reference(
    app: AppHandle,
    webview: WebviewWindow,
    paths: Vec<String>,
) -> Result<ReferenceBuild, String> {
    command_auth::authorize_webview(
        &webview,
        "tts",
        "build a voice reference clip",
        TTS_VOICE_ALLOWED_WINDOWS,
        "",
    )?;

    if paths.is_empty() {
        return Err("No audio file was selected".to_string());
    }
    if paths.len() > MAX_REFERENCE_PARTS {
        return Err(format!(
            "A voice can be built from at most {MAX_REFERENCE_PARTS} clips"
        ));
    }

    let dir = reference_voices_dir(&app)?;
    let max_secs = reference_clip_budget(&read_settings(&app));

    let mut pending: Vec<PendingPart> = Vec::with_capacity(paths.len());
    let mut trimmed = false;

    for raw in &paths {
        let source = resolve_reference_source(&webview, raw, &dir)?;
        // Parts are stored at the GLOBAL cap, never at the selected model's.
        //
        // A stored part is shared across every cloning model — the same upload is
        // offered under all of them — and its file name is content-addressed on
        // the SOURCE, not on the budget. Decoding at `max_secs` would therefore
        // let whichever model happened to be selected first decide how much audio
        // the part keeps forever: a take ingested under OmniVoice (5 s) would come
        // back five seconds long under Chatterbox (30 s), and the only way to
        // recover the rest would be to upload the file again — exactly what the
        // shared library exists to avoid. The model's cap is applied to the
        // CONCATENATION below, which is what the engine actually loads.
        let clip = transcode::decode_reference_clip(
            &source.path,
            REFERENCE_CLIP_SAMPLE_RATE,
            MAX_CLONE_REF_SECS,
        )?;
        // A source trimmed on its own way past the GLOBAL cap is a drop the user
        // should hear about even when the concatenation itself lands exactly on it.
        trimmed |= clip.trimmed;
        // A managed source was already normalized AND written by an earlier build.
        // Re-hashing it would write a second, byte-identical copy under a new name
        // on every single edit.
        let stored = if source.managed {
            source.path.clone()
        } else {
            dir.join(stored_clip_name(&source.path))
        };
        pending.push(PendingPart {
            part: ReferencePart {
                stored_path: stored.to_string_lossy().into_owned(),
                name: part_display_name(&source.path, source.managed),
                seconds: clip.seconds(),
            },
            sample_rate: clip.sample_rate,
            samples: clip.samples,
            stored,
            needs_write: !source.managed,
        });
    }

    let rate = f64::from(REFERENCE_CLIP_SAMPLE_RATE);
    let gap_samples = (REFERENCE_GAP_SECS * rate) as usize;
    let max_samples = (REFERENCE_CLIP_SAMPLE_RATE as usize).saturating_mul(max_secs as usize);
    let decoded: Vec<&[f32]> = pending.iter().map(|p| p.samples.as_slice()).collect();
    let (combined, concat_trimmed) = concatenate_parts(&decoded, gap_samples, max_samples);
    trimmed |= concat_trimmed;
    let seconds = combined.len() as f64 / rate;
    // Checked BEFORE anything is written, exactly like `tts_prepare_reference_clip`
    // (reject, then save). A part saved ahead of this check would outlive the
    // rejection as an orphan no library row names — and `tts_delete_reference_clips`
    // only ever gets the paths a voice owns, so nothing would ever remove it.
    catalog::reject_short_reference(seconds)?;

    // Accepted — now the new parts land on disk.
    for entry in &pending {
        if !entry.needs_write {
            continue;
        }
        crate::audio_toolkit::audio::save_wav_file_with_spec(
            &entry.stored,
            &entry.samples,
            entry.sample_rate,
            1,
        )
        .map_err(|e| format!("cannot save the reference clip: {e}"))?;
    }

    let stored_paths: Vec<PathBuf> = pending.iter().map(|p| p.stored.clone()).collect();
    // ONE part that the cap did not touch IS the combined clip: writing a
    // byte-identical second file under a combined name would double the folder and
    // break parity with `tts_prepare_reference_clip`, which the single-clip UI
    // still calls.
    //
    // The "untouched" half of that condition is load-bearing now that parts are
    // stored at the global cap: a single 20 s part selected under OmniVoice must
    // NOT be handed to the engine whole, and it must not be truncated in place
    // either — the other models still want all twenty seconds. So the trimmed
    // version is written out as its own cap-keyed combined file and the part is
    // left alone.
    let single_untrimmed = matches!(
        pending.as_slice(),
        [only] if only.samples.len() == combined.len()
    );
    let stored_path = if let ([only], true) = (stored_paths.as_slice(), single_untrimmed) {
        only.clone()
    } else {
        let combined_path = dir.join(combined_clip_name(&stored_paths, max_secs));
        crate::audio_toolkit::audio::save_wav_file_with_spec(
            &combined_path,
            &combined,
            REFERENCE_CLIP_SAMPLE_RATE,
            1,
        )
        .map_err(|e| format!("cannot save the reference clip: {e}"))?;
        combined_path
    };

    Ok(ReferenceBuild {
        seconds,
        trimmed,
        stored_path: stored_path.to_string_lossy().into_owned(),
        max_secs,
        parts: pending.into_iter().map(|entry| entry.part).collect(),
    })
}

/// `tts_delete_reference_clips` — remove stored clips from disk when the voice
/// that owned them is deleted. Nothing else ever did, so the folder only grew.
///
/// Deliberately total: only paths that resolve INSIDE the managed folder are
/// touched, anything else is logged and skipped rather than raised, and a path
/// that is already gone is a success. Deleting a voice is a UI action that must
/// not half-fail — the record is going away either way, and an error the renderer
/// has to handle would only strand it.
#[tauri::command]
#[specta::specta]
pub fn tts_delete_reference_clips(
    app: AppHandle,
    webview: WebviewWindow,
    paths: Vec<String>,
) -> Result<(), String> {
    command_auth::authorize_webview(
        &webview,
        "tts",
        "delete voice reference clips",
        TTS_VOICE_ALLOWED_WINDOWS,
        "",
    )?;

    // Not `reference_voices_dir`: deleting must never CREATE the folder. A missing
    // folder simply confines nothing, so every path is skipped.
    let root = crate::portable::app_data_dir(&app)
        .map_err(|e| format!("cannot resolve the app data dir: {e}"))?
        .join("tts")
        .join("reference-voices");

    for raw in &paths {
        let path = Path::new(raw.trim());
        let Some(resolved) = canonical_path_inside_dir(path, &root) else {
            // A path that does not exist is the idempotent case (the UI retried, or
            // two voices shared a clip and the first delete won) — silent. A path
            // that DOES exist outside the folder is a refusal worth seeing.
            if path.exists() {
                log::warn!("[tts] refused to delete a clip outside the managed voice folder");
            }
            continue;
        };
        match std::fs::remove_file(&resolved) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => log::warn!(
                "[tts] cannot delete reference clip {}: {e}",
                resolved.display()
            ),
        }
    }
    Ok(())
}

// ── the saved-voice library ──────────────────────────────────────────────────
//
// A named voice is a USER ARTIFACT, not a cache: the clips were recorded or
// picked by hand and the transcript may have been corrected by hand. It
// therefore lives on disk next to the audio it names, in the same managed
// folder, so the two are backed up, wiped and reported as ONE thing.
//
// The renderer keeps a localStorage mirror for a synchronous first paint and for
// cross-window `storage` events, but THIS file is the record that survives a
// cleared web store — which is what "close the app and open it again and the
// voices are still there" actually requires.

/// One source clip inside a stored voice — the ingest history that makes a
/// rebuild possible after one of the parts is dropped.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StoredVoiceClip {
    /// Display label, normally the source file's stem.
    pub name: String,
    /// Absolute path to the normalized part in the managed folder.
    pub path: String,
    /// Length of THIS part alone, seconds; `0` = never measured.
    pub seconds: f64,
}

/// One named voice, exactly as the renderer's library holds it.
///
/// Deliberately a DUMB record: the backend stores and returns it without
/// interpreting `kind` or resolving any path. The renderer owns the schema (it
/// re-validates with zod on the way in), and a field it adds later round-trips
/// through here as long as this struct carries it.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StoredVoice {
    pub id: String,
    pub name: String,
    /// `"clip"` (a reference-clip voice) or `"design"` (a written prompt).
    pub kind: String,
    /// The combined clip path, or the design prompt.
    pub value: String,
    /// Transcript of the reference clip, for the engines whose cloning needs one.
    /// Persisted HERE rather than only in `settings.tts.clone_ref_text`, which
    /// holds the transcript of whichever voice is live right now — one field
    /// cannot remember the transcripts of ten voices.
    pub ref_text: String,
    /// Total length of `value`, seconds; `0` = unknown.
    pub seconds: f64,
    /// Which model cap `value` was welded under. A voice is shared across models
    /// with different budgets, so this is what tells the renderer whether the
    /// cached combined clip still suits the selected model or has to be rebuilt
    /// from `clips` — see `combined_clip_name`.
    pub max_secs: u32,
    pub clips: Vec<StoredVoiceClip>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StoredVoiceLibrary {
    pub version: u32,
    pub voices: Vec<StoredVoice>,
}

/// A voice is a handful of takes and a name; a library of them is a personal
/// list, not a dataset. The bound exists so a corrupt or hostile renderer cannot
/// ask this command to write an unbounded file into app data.
const MAX_LIBRARY_VOICES: usize = 500;

/// Where the library lives — INSIDE the clip folder, so the record and the audio
/// it names share one lifetime: backing up, reporting or removing the voices
/// folder can never take one without the other.
fn voice_library_path(dir: &Path) -> PathBuf {
    dir.join("library.json")
}

/// `tts_read_voice_library` — the persisted named voices.
///
/// Total by construction: no file (first run), an unreadable file, or JSON this
/// build cannot parse all return an EMPTY library rather than an error. The
/// renderer falls back to its localStorage mirror in that case, and a hard
/// failure here would break the whole voice row over a file the user never
/// edited.
#[tauri::command]
#[specta::specta]
pub fn tts_read_voice_library(
    app: AppHandle,
    webview: WebviewWindow,
) -> Result<StoredVoiceLibrary, String> {
    command_auth::authorize_webview(
        &webview,
        "tts",
        "read the saved voice library",
        TTS_VOICE_ALLOWED_WINDOWS,
        "",
    )?;

    // Not `reference_voices_dir`: merely READING the library must not create the
    // folder — that would leave an empty directory behind on every launch of an
    // install that never cloned a voice.
    let dir = crate::portable::app_data_dir(&app)
        .map_err(|e| format!("cannot resolve the app data dir: {e}"))?
        .join("tts")
        .join("reference-voices");
    let path = voice_library_path(&dir);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Ok(StoredVoiceLibrary::default());
    };
    match serde_json::from_str::<StoredVoiceLibrary>(&raw) {
        Ok(library) => Ok(library),
        Err(err) => {
            log::warn!("[tts] the saved voice library could not be parsed: {err}");
            Ok(StoredVoiceLibrary::default())
        }
    }
}

/// `tts_write_voice_library` — replace the persisted named voices.
///
/// Whole-list writes, like the renderer's localStorage mirror: the list is short
/// and every mutation already produces the complete next state, so a partial
/// update API would only add a way for the two records to disagree.
///
/// Written to a temp file and renamed, so a crash mid-write leaves the previous
/// library intact instead of a truncated file the next launch would read as an
/// empty one.
#[tauri::command]
#[specta::specta]
pub fn tts_write_voice_library(
    app: AppHandle,
    webview: WebviewWindow,
    library: StoredVoiceLibrary,
) -> Result<(), String> {
    command_auth::authorize_webview(
        &webview,
        "tts",
        "save the voice library",
        TTS_VOICE_ALLOWED_WINDOWS,
        "",
    )?;

    if library.voices.len() > MAX_LIBRARY_VOICES {
        return Err(format!(
            "A voice library holds at most {MAX_LIBRARY_VOICES} voices"
        ));
    }

    let dir = reference_voices_dir(&app)?;
    let path = voice_library_path(&dir);
    let json = serde_json::to_string_pretty(&library)
        .map_err(|e| format!("cannot serialize the voice library: {e}"))?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, json).map_err(|e| format!("cannot save the voice library: {e}"))?;
    std::fs::rename(&temp, &path).map_err(|e| {
        // Leaving the temp file behind would have the next write fail the same
        // way forever, so it goes even on the unhappy path.
        let _ = std::fs::remove_file(&temp);
        format!("cannot save the voice library: {e}")
    })
}

// ── shared LLM plumbing ──────────────────────────────────────────────────────

/// User-driven and short: fail rather than leave a dialog spinning. (Listen
/// post-processing's 300 s exists only because it summarizes hour-long
/// transcripts; the playground uses this same 60 s ceiling.)
const TTS_VOICE_LLM_TIMEOUT: Duration = Duration::from_secs(60);

/// Guard against runaway free-text input on either LLM command.
const MAX_INPUT_CHARS: usize = 4_000;

/// Is `base` runnable — a usable model for whichever provider it names?
///
/// Deliberately strict on the OpenRouter arm: a saved API key with no model
/// selected is NOT ready, because the request would otherwise fall through to
/// `openrouter/auto`, a different and unasked-for model.
fn llm_base_ready(settings: &WinsttSettings, base: &LlmFeatureBase) -> Result<(), String> {
    let ready = match base.provider {
        LlmProvider::Openrouter => {
            !settings.llm.openrouter_api_key.trim().is_empty()
                && !base.openrouter_model.trim().is_empty()
        }
        LlmProvider::AppleIntelligence => true,
        LlmProvider::Ollama => !base.model.trim().is_empty(),
    };
    if ready {
        Ok(())
    } else {
        Err("No post-processing model is configured".to_string())
    }
}

/// Availability of the DICTATION post-processor — the general-purpose model the
/// settings-surface authoring tools (voice design, the standalone tag command)
/// run on. Same contract as `listen_post_process::post_processing_ready`.
///
/// The read-aloud PIPELINE does not use this: it has its own assigned
/// configuration and therefore its own base (see `read_aloud_base`).
fn post_processing_ready(settings: &WinsttSettings) -> Result<(), String> {
    if !settings.llm.dictation.enabled {
        return Err("AI post-processing is disabled in Settings".to_string());
    }
    llm_base_ready(settings, &settings.llm.dictation.base)
}

/// The model the read-aloud pipeline runs on — its own assigned configuration's
/// base, NOT dictation's. A cloud read-aloud pass alongside a local dictation
/// pass is a supported combination, so the two must be able to differ.
fn read_aloud_base(settings: &WinsttSettings) -> &LlmFeatureBase {
    &settings.llm.read_aloud.base
}

/// One LLM call over `base`. Pure text → text.
async fn run_voice_llm(
    settings: &WinsttSettings,
    base: &LlmFeatureBase,
    mgr: &Arc<LlmManager>,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<String, String> {
    let call = async {
        match base.provider {
            LlmProvider::AppleIntelligence => llm_commands::apple_intelligence_chat(
                system_prompt,
                user_prompt,
                base.max_output_tokens.filter(|v| *v > 0),
            ),
            LlmProvider::Openrouter => {
                mgr.openrouter_chat(
                    &settings.llm.openrouter_api_key,
                    &base.openrouter_model,
                    system_prompt,
                    user_prompt,
                    // The 5th argument is the FALLBACK TEXT returned when the
                    // structured `{ "text": … }` envelope cannot be parsed — NOT
                    // a fallback model. Empty, so an unparseable answer lands in
                    // the empty-result branch below instead of returning junk.
                    "",
                    openrouter_options(base),
                    Some(&mgr.next_request_id()),
                )
                .await
            }
            LlmProvider::Ollama => {
                mgr.ollama_transform(
                    &settings.llm.endpoint,
                    &base.model,
                    system_prompt,
                    user_prompt,
                    "", // same: envelope-salvage fallback text, not a model
                    to_llm_effort(base.thinking_effort),
                    &mgr.next_request_id(),
                )
                .await
            }
        }
    };
    match tokio::time::timeout(TTS_VOICE_LLM_TIMEOUT, call).await {
        Ok(Ok(answer)) if !answer.trim().is_empty() => Ok(answer.trim().to_string()),
        Ok(Ok(_)) => Err("The model returned an empty result".to_string()),
        Ok(Err(err)) => Err(err),
        Err(_) => Err(format!(
            "Generating timed out after {} seconds. Try a smaller model or lower thinking effort.",
            TTS_VOICE_LLM_TIMEOUT.as_secs()
        )),
    }
}

fn validated_input(raw: &str, empty_message: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(empty_message.to_string());
    }
    if trimmed.chars().count() > MAX_INPUT_CHARS {
        return Err("That is too long to process".to_string());
    }
    Ok(trimmed.to_string())
}

/// Openers a chat model reaches for when it announces its answer instead of just
/// giving it. Matched only on the LEADING lines, and only when a real line
/// follows, so a description that happens to begin this way is never lost.
const PREAMBLE_OPENERS: [&str; 8] = [
    "sure",
    "certainly",
    "absolutely",
    "of course",
    "here is",
    "here's",
    "okay",
    "ok,",
];

/// Is this line an announcement rather than the answer? Either it ends in `:`
/// ("Here's the voice-design instruction:") or it opens with one of the stock
/// acknowledgements.
fn is_preamble_line(line: &str) -> bool {
    let lower = line.trim().to_lowercase();
    lower.ends_with(':') || PREAMBLE_OPENERS.iter().any(|open| lower.starts_with(open))
}

/// Models like to wrap answers in quotes, code fences, or a "Sure! Here is…"
/// preamble line. Strip that down to the one line we asked for.
///
/// The preamble pass drops LEADING announcement lines only, and only while a
/// non-announcement line survives them — an answer that is nothing but a
/// preamble is kept whole rather than reduced to nothing. Remaining lines are
/// then joined, because a model wrapping ONE sentence across two lines is the
/// common case and picking a single line would truncate it.
fn sanitize_single_line(answer: &str) -> String {
    let mut text = answer.trim();
    if let Some(rest) = text.strip_prefix("```") {
        // Drop the fence's info string, then everything after the closing fence.
        let body = rest.split_once("```").map_or(rest, |(body, _)| body);
        text = body.split_once('\n').map_or(body, |(_, body)| body);
    }
    let text = text
        .trim()
        .trim_matches(['"', '\'', '“', '”', '‘', '’'])
        .trim();
    let lines: Vec<&str> = text.lines().collect();
    let start = lines
        .iter()
        .position(|line| !(line.trim().is_empty() || is_preamble_line(line)))
        .unwrap_or(0);
    let body = lines[start..].join("\n");
    body.trim()
        .trim_matches(['"', '\'', '“', '”', '‘', '’'])
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Hard-clip to `max_chars` at a WORD boundary — models routinely overshoot an
/// instructed character budget, and a prompt cut mid-word reads as a bug. A
/// single word longer than the whole budget has no boundary to cut at, so it is
/// cut at the budget: the cap is the invariant, the boundary is best-effort.
fn clip_to_chars(text: &str, max_chars: usize) -> String {
    let text = text.trim();
    if max_chars == 0 {
        return String::new();
    }
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let cut = text
        .char_indices()
        .nth(max_chars)
        .map_or(text.len(), |(byte, _)| byte);
    let window = &text[..cut];
    let clipped = match window.rfind(char::is_whitespace) {
        Some(boundary) if boundary > 0 => &window[..boundary],
        // One unbroken word wider than the budget: the cap wins.
        _ => window,
    };
    clipped
        .trim_end()
        .trim_end_matches([',', ';', ':', '-', '—', '–'])
        .trim_end()
        .to_string()
}

// ── 1. voice-design prompt authoring ─────────────────────────────────────────

const VOICE_DESIGN_SYSTEM_PROMPT: &str = "You write voice-design instructions for a text-to-speech model. Given a description of a character or a speaking style, produce ONE instruction that describes the VOICE only: apparent age and gender, pitch, timbre, accent, pace, emotion, and delivery. Never name the character or any real person, never describe their appearance or backstory, never write anything the speaker says, never invent a script or dialogue. Output one single line of plain prose: no quotes, no markdown, no bullet points, no headings, no preamble, no explanation, no trailing commentary.";

fn voice_design_user_prompt(description: &str, max_chars: usize) -> String {
    format!(
        "Write the voice-design instruction for this character description. Hard limit: {max_chars} characters on ONE line. Example of the required style: \"A deep, gravelly middle-aged American man speaking in a low, controlled, menacing near-whisper.\"\n\nDESCRIPTION:\n{description}"
    )
}

/// The design-prompt budget for the model the user has selected, falling back to
/// the catalog constant when the selection is not a voice-design row (the dialog
/// can only be opened on one that is, but settings are user-editable JSON).
fn voice_design_budget(settings: &WinsttSettings) -> usize {
    catalog::find(&settings.tts.model)
        .map(|m| m.voice_design_max_chars)
        .filter(|max| *max > 0)
        .unwrap_or(VOICE_DESIGN_PROMPT_MAX_CHARS) as usize
}

/// `generate_voice_design_prompt` — turn a loose character description ("a
/// Batman-like voice") into a voice-design instruct ("A deep, gravelly
/// middle-aged American man speaking in a low, controlled, menacing
/// near-whisper."), using the configured post-processing LLM.
///
/// The answer is sanitized to one line and hard-clipped to the selected model's
/// `voiceDesignMaxChars` at a word boundary — the instructed limit in the prompt
/// is a hint, this is the guarantee.
#[tauri::command]
#[specta::specta]
pub async fn generate_voice_design_prompt(
    app: AppHandle,
    webview: WebviewWindow,
    llm_manager: State<'_, Arc<LlmManager>>,
    description: String,
) -> Result<String, String> {
    command_auth::authorize_webview(
        &webview,
        "tts",
        "generate a voice-design prompt",
        TTS_VOICE_ALLOWED_WINDOWS,
        "",
    )?;
    let description = validated_input(&description, "Describe the voice first")?;

    let settings = read_settings(&app);
    post_processing_ready(&settings)?;
    let budget = voice_design_budget(&settings);

    let mgr = llm_manager.inner().clone();
    let answer = run_voice_llm(
        &settings,
        &settings.llm.dictation.base,
        &mgr,
        VOICE_DESIGN_SYSTEM_PROMPT,
        &voice_design_user_prompt(&description, budget),
    )
    .await?;
    let prompt = clip_to_chars(&sanitize_single_line(&answer), budget);
    if prompt.is_empty() {
        return Err("The model returned an empty voice description".to_string());
    }
    Ok(prompt)
}

// ── 2. inline paralinguistic tagging ─────────────────────────────────────────

fn tag_system_prompt(syntax: TagSyntax, allowed: &[String]) -> String {
    let vocabulary = allowed
        .iter()
        .map(|tag| syntax.wrap(tag))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "You annotate text for a text-to-speech engine that renders inline paralinguistic tags. Insert tags ONLY from this exact vocabulary, written exactly as shown, delimiters included: {vocabulary}. Rules: reproduce every word of the original text unchanged, in the same order, with the same punctuation - you may only ADD tags; put a tag between words or sentences where the delivery genuinely calls for it; never invent a tag outside the vocabulary; never change the delimiter characters; use at most one tag per sentence and prefer none over a forced one; if nothing fits, return the text unchanged. Output only the annotated text: no preamble, no commentary, no code fences."
    )
}

/// Normalize the caller's vocabulary: accept `laugh`, `<laugh>` or `[laugh]` and
/// store the BARE name, dropping empties and duplicates.
fn normalize_allowed_tags(allowed: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tag in allowed {
        let bare = tag.trim().trim_matches(['<', '>', '[', ']']).trim();
        if bare.is_empty() {
            continue;
        }
        let bare = bare.to_lowercase();
        if !out.contains(&bare) {
            out.push(bare);
        }
    }
    out
}

/// A tag is ONE bare word — `laugh`, `long_sigh`, `mm-hmm`. A bracketed run with
/// spaces or punctuation inside it (`< 10 and y >`, `<john@example.com>`,
/// `[see fig. 3]`) can never be an invented tag, so it survives verbatim
/// regardless of provenance. An EMPTY run (`<>`) is model debris and counts as
/// tag-shaped so it is dropped.
fn is_tag_shaped(inner: &str) -> bool {
    inner.is_empty()
        || inner
            .chars()
            .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
}

/// The two delimiter pairs any shipped engine uses. A run in either one is a
/// tag CANDIDATE; which one the selected engine actually reads is `TagSyntax`.
const KNOWN_DELIMITERS: [(char, char); 2] = [('<', '>'), ('[', ']')];

/// One `<…>` / `[…]` run, plus the prose that preceded it.
struct BracketRun<'a> {
    /// Text between the previous run (or the start) and this one.
    before: &'a str,
    /// Opening delimiter — identifies which syntax the run is written in.
    open: char,
    /// Contents, trimmed and lowercased (the form tag names are compared in).
    inner: String,
    /// The whole run including both delimiters, exactly as written.
    raw: &'a str,
}

/// Split `text` into its bracketed runs and the prose after the last one. An
/// UNTERMINATED bracket ends the scan: nothing past it can be a complete run,
/// and treating the rest of the text as one giant run would let a lone `<` in
/// prose (`if x < 10`) swallow it. Byte slicing is always on char boundaries
/// (`find` returns them and the delimiters are ASCII), so multibyte text is safe.
fn scan_bracket_runs(text: &str) -> (Vec<BracketRun<'_>>, &str) {
    let mut runs = Vec::new();
    let mut rest = text;
    while let Some(open_at) = rest.find(|c| KNOWN_DELIMITERS.iter().any(|(open, _)| *open == c)) {
        let open = rest[open_at..].chars().next().unwrap_or('<');
        let close = KNOWN_DELIMITERS
            .iter()
            .find(|(o, _)| *o == open)
            .map_or('>', |(_, c)| *c);
        let after_open = open_at + open.len_utf8();
        let Some(close_rel) = rest[after_open..].find(close) else {
            break;
        };
        let close_at = after_open + close_rel;
        let end = close_at + close.len_utf8();
        runs.push(BracketRun {
            before: &rest[..open_at],
            open,
            inner: rest[after_open..close_at].trim().to_lowercase(),
            raw: &rest[open_at..end],
        });
        rest = &rest[end..];
    }
    (runs, rest)
}

/// How many times the user's OWN text contains each tag-shaped bracketed run,
/// keyed by (delimiter, name). This is the provenance oracle: a tag-shaped run
/// in the model's answer that this multiset cannot account for was INVENTED by
/// the model, whichever delimiters it chose.
fn authored_tag_runs(original: &str) -> HashMap<(char, String), usize> {
    let mut counts: HashMap<(char, String), usize> = HashMap::new();
    let (runs, _) = scan_bracket_runs(original);
    for run in runs {
        if is_tag_shaped(&run.inner) {
            *counts.entry((run.open, run.inner)).or_default() += 1;
        }
    }
    counts
}

/// Deterministic safety net over the model's answer. Models WILL emit tags
/// outside the vocabulary, and WILL reach for the other syntax's brackets —
/// `[laughs]` is the dominant convention in training corpora, so it is the most
/// likely wrong answer to a request for `<laugh>`.
///
/// The decision is made on PROVENANCE, because shape alone cannot separate the
/// failure modes from the user's own copy: an invented `[laughs]` and a typed
/// `[sic]` are the same shape, and `original` is the only thing that tells them
/// apart. Per bracketed run:
///   * an allowed name in the REQUESTED syntax is KEPT, re-emitted canonically
///     (`< Laugh >` → `<laugh>`) because the engine matches an exact token;
///   * any other tag-shaped run the ORIGINAL text cannot account for was invented
///     and is DELETED, in either syntax — an invented `<whisper>`, and equally an
///     invented `[laughs]` under an angle-syntax engine, would otherwise be read
///     out loud as the word;
///   * everything the original already contained survives verbatim. Read-aloud
///     runs this over ARBITRARY selected text where `<` and `[` are ordinary
///     prose — `<name>` in a mail-merge template, `[sic]`, a `[1]` citation
///     marker. Deleting those would silently eat words the user asked to hear,
///     and `comparable_words` cannot catch it: it discards tag-shaped runs on
///     both sides, so the loss compares equal.
fn strip_unknown_tags(
    answer: &str,
    original: &str,
    syntax: TagSyntax,
    allowed: &[String],
) -> String {
    let target = syntax.delimiters();
    let mut authored = authored_tag_runs(original);
    let (runs, tail) = scan_bracket_runs(answer);
    let mut out = String::with_capacity(answer.len());
    for run in runs {
        // Text before the run always survives.
        out.push_str(run.before);
        let in_target_syntax = target.is_some_and(|(open, _)| open == run.open);
        if in_target_syntax && allowed.contains(&run.inner) {
            out.push_str(&syntax.wrap(&run.inner));
            continue;
        }
        if !is_tag_shaped(&run.inner) {
            out.push_str(run.raw);
            continue;
        }
        // Tag-shaped and not a usable tag: keep it only while the original still
        // has an unclaimed occurrence of exactly this run. Counting (rather than
        // a set test) means a model that DUPLICATES the user's `[1]` still has
        // the copy removed.
        match authored.get_mut(&(run.open, run.inner.clone())) {
            Some(remaining) if *remaining > 0 => {
                *remaining -= 1;
                out.push_str(run.raw);
            }
            _ => {}
        }
    }
    out.push_str(tail);
    collapse_whitespace(&out)
}

/// Tidy the double spaces and orphaned spaces-before-punctuation that removing a
/// run leaves behind, without touching line structure.
fn collapse_whitespace(text: &str) -> String {
    text.lines()
        .map(|line| {
            let joined = line.split_whitespace().collect::<Vec<_>>().join(" ");
            joined
                .replace(" ,", ",")
                .replace(" .", ".")
                .replace(" !", "!")
                .replace(" ?", "?")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The words of `text`, lowercased and stripped of punctuation and of every
/// TAG-SHAPED bracketed run. Used to prove the model only ADDED tags.
///
/// Only tag-shaped runs are discarded, for the same reason
/// [`strip_unknown_tags`] never touches the others: a lone `<` in the user's
/// prose (`if x < 10`) must not swallow the whole remainder of the comparison,
/// or a rewrite after that point would compare equal and slip through.
fn comparable_words(text: &str) -> Vec<String> {
    let (runs, tail) = scan_bracket_runs(text);
    let mut cleaned = String::with_capacity(text.len());
    for run in runs {
        cleaned.push_str(run.before);
        if !is_tag_shaped(&run.inner) {
            cleaned.push_str(run.raw);
        }
        cleaned.push(' ');
    }
    cleaned.push_str(tail);
    cleaned
        .split_whitespace()
        .map(|word| {
            word.chars()
                .filter(|c| c.is_alphanumeric())
                .collect::<String>()
                .to_lowercase()
        })
        .filter(|word| !word.is_empty())
        .collect()
}

/// One annotation round-trip: prompt `base`'s model, then DETERMINISTICALLY
/// reduce its answer to "the original words, plus allowed tags in the requested
/// syntax". Shared by the command below (which reports the failure) and by the
/// read-aloud hook (which swallows it), so both halves apply exactly the same
/// filtering — an invented `<whisper>` must never reach the synthesizer and be
/// read out as a word. `base` differs between the two: the command is a settings
/// tool and runs on dictation's model, the hook is part of the read and runs on
/// read-aloud's.
async fn tag_text(
    settings: &WinsttSettings,
    base: &LlmFeatureBase,
    mgr: &Arc<LlmManager>,
    text: &str,
    syntax: TagSyntax,
    allowed: &[String],
) -> Result<String, String> {
    let answer = run_voice_llm(
        settings,
        base,
        mgr,
        &tag_system_prompt(syntax, allowed),
        &format!("Annotate this text.\n\nTEXT:\n{text}"),
    )
    .await?;
    // `text` is the provenance oracle: a tag-shaped bracketed run the answer
    // carries but the input never had was invented by the model.
    let tagged = strip_unknown_tags(&answer, text, syntax, allowed);
    if comparable_words(&tagged) != comparable_words(text) {
        return Err(
            "The model rewrote the text instead of only adding tags — try again, or use a stronger post-processing model."
                .to_string(),
        );
    }
    Ok(tagged)
}

/// The selected model's tag vocabulary, normalized, paired with its syntax.
/// `None` when the row has no vocabulary (every engine but Orpheus and
/// Chatterbox Turbo) or the id is not a catalog row at all — settings are
/// user-editable JSON, so an unknown id is a normal input here.
fn selected_tag_vocabulary(settings: &WinsttSettings) -> Option<(TagSyntax, Vec<String>)> {
    let entry = catalog::find(&settings.tts.model)?;
    let syntax = entry.tag_syntax;
    let owned: Vec<String> = entry.tags.iter().map(|tag| (*tag).to_string()).collect();
    let allowed = normalize_allowed_tags(&owned);
    if syntax == TagSyntax::None || allowed.is_empty() {
        return None;
    }
    Some((syntax, allowed))
}

/// Read-aloud hook: annotate `text` with the SELECTED model's inline tags when
/// the user turned `tts.inlineTags` on and the pipeline can actually run.
///
/// FAIL-SOFT by construction, and that asymmetry with the command is deliberate:
/// the user pressed "read this aloud", not "annotate this". Every refusal — the
/// toggle is off, the engine has no vocabulary, no post-processing model is
/// configured, the LLM errored or timed out, the model rewrote the prose —
/// returns the ORIGINAL text so the selection is still spoken.
///
/// `cancel` is the READ's own token (see `TtsManager::track_request`). This phase
/// sits between the Escape shortcut being armed and playback starting, and can
/// last the full [`TTS_VOICE_LLM_TIMEOUT`], so it must be interruptible: firing
/// the token both returns immediately AND drops the in-flight LLM future, which
/// aborts the request rather than leaving a doomed round-trip running. The caller
/// re-checks the cancel state afterwards and abandons the read.
///
/// Local-source only: the flag describes a LOCAL catalog row's tag vocabulary,
/// and a cloud voice would just read the delimiters out loud.
pub(crate) async fn annotate_for_read_aloud(
    app: &AppHandle,
    text: &str,
    cancel: &CancellationToken,
) -> String {
    let settings = read_settings(app);
    if !settings.tts.inline_tags || settings.tts.source != TtsSource::Local {
        return text.to_string();
    }
    let Some((syntax, allowed)) = selected_tag_vocabulary(&settings) else {
        return text.to_string();
    };
    // Same length ceiling as the command: a book-length selection would blow the
    // context window and stall the read behind a doomed round-trip.
    let Ok(input) = validated_input(text, "There is no text to annotate") else {
        return text.to_string();
    };
    // The READ-ALOUD base, not dictation's: this pass belongs to the read
    // pipeline, so it runs on whatever configuration Read aloud is assigned.
    // Note it is NOT gated on `llm.read_aloud.enabled` — that flag turns the
    // MODIFIER pass on, while tagging is owned by its own `tts.inlineTags`
    // toggle, checked above. Both just need the model to be runnable.
    let base = read_aloud_base(&settings);
    if let Err(reason) = llm_base_ready(&settings, base) {
        log::debug!("[tts] inline tags skipped: {reason}");
        return text.to_string();
    }
    let Some(llm) = app.try_state::<Arc<LlmManager>>() else {
        return text.to_string();
    };
    let mgr = llm.inner().clone();
    let annotated = tokio::select! {
        biased;
        () = cancel.cancelled() => {
            log::debug!("[tts] inline tagging cancelled before the read started");
            return text.to_string();
        }
        result = tag_text(&settings, base, &mgr, &input, syntax, &allowed) => result,
    };
    match annotated {
        Ok(tagged) => tagged,
        Err(reason) => {
            log::warn!("[tts] inline tagging failed, reading the text unannotated: {reason}");
            text.to_string()
        }
    }
}

// ── read-aloud post-processing (modifiers) ───────────────────────────────────

/// The read-aloud modifier list in prompt shape: the persisted built-ins plus
/// every ENABLED custom modifier, in the same order `merge_presets_with_custom_modifiers`
/// produces for dictation and transforms.
///
/// Reads `llm.read_aloud` — deliberately NOT `llm.dictation`. Those modifiers
/// shape what lands on the KEYBOARD; these shape what reaches the SYNTHESIZER,
/// and "summarize what I dictated" and "summarize what you are about to read to
/// me" are different intents.
fn read_aloud_presets(settings: &WinsttSettings) -> Vec<llm::PresetEntry> {
    let builtins: Vec<llm::PresetEntry> = settings
        .llm
        .read_aloud
        .presets
        .iter()
        .map(llm_conversions::to_llm_preset)
        .collect();
    let customs: Vec<llm::CustomModifier> = settings
        .llm
        .read_aloud
        .custom_modifiers
        .iter()
        .map(llm_conversions::to_llm_custom)
        .collect();
    llm::merge_presets_with_custom_modifiers(&builtins, &customs)
}

/// True when the merged list carries at least one operation that actually
/// changes the text. `neutral` is the no-op tone (the base cleanup prompt runs
/// for every request and is not itself an operation), so a list of just
/// `[neutral]` — the default — must not spend an LLM round-trip before the
/// first word is spoken.
fn has_active_read_aloud_operation(presets: &[llm::PresetEntry]) -> bool {
    presets.iter().any(|entry| {
        !matches!(
            entry,
            llm::PresetEntry::Builtin {
                key: llm::PresetKey::Neutral,
                ..
            }
        )
    })
}

/// Rewrite `text` with the user's READ-ALOUD modifiers (summarize, concise,
/// translate, custom…) before it is synthesized.
///
/// FAIL-SOFT, for the same reason [`annotate_for_read_aloud`] is: the user
/// pressed "read this", not "rewrite this". Every refusal — the toggle is off,
/// post-processing is off or unconfigured, no operation is active, the text is
/// too long, the LLM errored or timed out, the answer came back empty — returns
/// the ORIGINAL text so the selection is still spoken.
///
/// `cancel` is the read's own token, so Escape drops the in-flight request
/// instead of leaving the user waiting on a read they already abandoned.
async fn apply_read_aloud_modifiers(
    app: &AppHandle,
    text: &str,
    cancel: &CancellationToken,
) -> String {
    let settings = read_settings(app);
    if !settings.llm.read_aloud.enabled {
        return text.to_string();
    }
    let base = read_aloud_base(&settings);
    if let Err(reason) = llm_base_ready(&settings, base) {
        log::debug!("[tts] read-aloud modifiers skipped: {reason}");
        return text.to_string();
    }
    let presets = read_aloud_presets(&settings);
    if !has_active_read_aloud_operation(&presets) {
        return text.to_string();
    }
    // Same ceiling as the tag pass: a book-length selection would blow the
    // context window and stall the read behind a doomed round-trip.
    let Ok(input) = validated_input(text, "There is no text to process") else {
        return text.to_string();
    };
    let Some(llm_state) = app.try_state::<Arc<LlmManager>>() else {
        return text.to_string();
    };
    let mgr = llm_state.inner().clone();
    let system_prompt = llm::build_system_prompt_tiered(
        &presets,
        llm_commands::ollama_tier_model(base.provider, &base.model)
            .is_some_and(llm::is_lite_ollama_model),
    );
    // The transforms user-prompt shape, not the dictation one: read-aloud text is
    // already-written prose the user pointed at, exactly like a transform's
    // selection — never a fresh speech transcript needing dictation framing.
    let user_prompt = llm::transforms_user_prompt_for_presets(&presets, &input);
    let processed = tokio::select! {
        biased;
        () = cancel.cancelled() => {
            log::debug!("[tts] read-aloud modifiers cancelled before the read started");
            return text.to_string();
        }
        result = run_voice_llm(&settings, base, &mgr, &system_prompt, &user_prompt) => result,
    };
    match processed {
        Ok(rewritten) if !rewritten.trim().is_empty() => rewritten,
        Ok(_) => text.to_string(),
        Err(reason) => {
            log::warn!("[tts] read-aloud modifiers failed, reading the text as-is: {reason}");
            text.to_string()
        }
    }
}

/// The WHOLE renderer-visible preparation a read-aloud request runs before a
/// single sample is synthesized, in the order the two passes must run:
///
///   1. MODIFIERS — rewrite the prose (summarize, translate, custom…).
///   2. INLINE TAGS — annotate the FINAL prose with the engine's paralinguistic
///      vocabulary.
///
/// The order is load-bearing: the tag pass proves the model only ADDED tags by
/// comparing its answer's words against its input, so it has to see the text
/// that will actually be spoken. Running it first would let the modifier pass
/// rewrite (and strip) the tags it just inserted.
///
/// Both halves are fail-soft, so this can delay a read but never cancel one.
/// Callers must still re-check `is_cancelled` afterwards: Escape during either
/// round-trip means the read is abandoned.
pub(crate) async fn prepare_read_aloud_text(
    app: &AppHandle,
    text: &str,
    cancel: &CancellationToken,
) -> String {
    let modified = apply_read_aloud_modifiers(app, text, cancel).await;
    if cancel.is_cancelled() {
        return modified;
    }
    annotate_for_read_aloud(app, &modified, cancel).await
}

/// `insert_paralinguistic_tags` — rewrite `text` so the selected model's inline
/// tag vocabulary is used where the delivery calls for it, using the configured
/// post-processing LLM.
///
/// `allowed_tags` are BARE names (`laugh`, `sigh`) and `syntax` selects the
/// engine's delimiters — both come from the model's catalog row
/// (`tags` / `tagSyntax`), never from a hardcoded list, because the two shipped
/// syntaxes are incompatible: Orpheus reads `<laugh>`, Chatterbox Turbo reads
/// `[laugh]`, and the wrong one is spoken aloud rather than rejected.
///
/// The answer is filtered against `allowed_tags` and checked to confirm the
/// model only ADDED tags before it is returned.
#[tauri::command]
#[specta::specta]
pub async fn insert_paralinguistic_tags(
    app: AppHandle,
    webview: WebviewWindow,
    llm_manager: State<'_, Arc<LlmManager>>,
    text: String,
    allowed_tags: Vec<String>,
    syntax: TagSyntax,
) -> Result<String, String> {
    command_auth::authorize_webview(
        &webview,
        "tts",
        "insert paralinguistic tags",
        TTS_VOICE_ALLOWED_WINDOWS,
        "",
    )?;
    let text = validated_input(&text, "There is no text to annotate")?;
    let allowed = normalize_allowed_tags(&allowed_tags);
    if allowed.is_empty() || syntax == TagSyntax::None {
        return Err("This model has no inline tag vocabulary".to_string());
    }

    let settings = read_settings(&app);
    post_processing_ready(&settings)?;

    let mgr = llm_manager.inner().clone();
    // Settings-surface tool → dictation's model (see `post_processing_ready`).
    // The read-aloud HOOK deliberately uses a different base.
    let base = settings.llm.dictation.base.clone();
    tag_text(&settings, &base, &mgr, &text, syntax, &allowed).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed() -> Vec<String> {
        normalize_allowed_tags(&["laugh".to_string(), "<sigh>".to_string()])
    }

    // ── voice-design clipping ────────────────────────────────────────────────

    #[test]
    fn short_prompts_pass_through_untouched() {
        assert_eq!(clip_to_chars("A warm narrator.", 300), "A warm narrator.");
    }

    #[test]
    fn overshooting_prompts_are_clipped_at_a_word_boundary() {
        let text = "A deep gravelly middle-aged American man speaking in a low controlled menacing near-whisper";
        let clipped = clip_to_chars(text, 30);
        assert!(clipped.chars().count() <= 30, "cap is the invariant");
        assert!(
            text.starts_with(&clipped),
            "clipping only removes a suffix: {clipped:?}"
        );
        // The cut lands between words, never inside one.
        let next = text[clipped.len()..].chars().next().expect("more text");
        assert!(
            next.is_whitespace(),
            "cut mid-word before {next:?}: {clipped:?}"
        );
    }

    #[test]
    fn a_single_word_longer_than_the_budget_still_respects_the_cap() {
        let clipped = clip_to_chars("Supercalifragilisticexpialidocious", 10);
        assert_eq!(clipped.chars().count(), 10);
    }

    #[test]
    fn clipping_is_char_safe_on_multibyte_text() {
        let clipped = clip_to_chars("ünïcödé prömpt wíth áccents", 12);
        assert!(clipped.chars().count() <= 12);
        assert!(clipped.starts_with("ünïcödé"));
    }

    /// The budget is counted in CHARS but sliced in BYTES, so every cut point
    /// has to land on a char boundary or this panics. Arabic exercises the
    /// 2-byte path with spaces to fall back to; CJK the 3-byte path with NO
    /// whitespace anywhere, where the word-boundary search finds nothing and the
    /// cap has to hold on its own.
    #[test]
    fn clipping_never_splits_a_multibyte_char_in_scripts_without_spaces() {
        let arabic = "صوت رجل عربي عميق وهادئ ومتزن في نبرته";
        for budget in 1..=arabic.chars().count() + 2 {
            let clipped = clip_to_chars(arabic, budget);
            assert!(clipped.chars().count() <= budget, "{budget}: {clipped:?}");
            assert!(arabic.starts_with(clipped.trim_end()), "{clipped:?}");
        }

        let chinese = "一位低沉沙哑的中年男性用缓慢而克制的语气说话";
        for budget in 1..=chinese.chars().count() + 2 {
            let clipped = clip_to_chars(chinese, budget);
            assert!(clipped.chars().count() <= budget, "{budget}: {clipped:?}");
            assert!(chinese.starts_with(&clipped), "{clipped:?}");
        }
    }

    /// Same byte-vs-char hazard on the tag filter, which read-aloud runs over
    /// whatever the user selected.
    #[test]
    fn tag_filtering_is_char_safe_on_multibyte_text() {
        let out = strip_unknown_tags(
            "مرحبا <laugh> يا صديقي <whisper> كيف حالك",
            "مرحبا يا صديقي كيف حالك",
            TagSyntax::Angle,
            &allowed(),
        );
        assert_eq!(out, "مرحبا <laugh> يا صديقي كيف حالك");
        let out = strip_unknown_tags(
            "你好 <laugh> 朋友 <whisper>",
            "你好 朋友",
            TagSyntax::Angle,
            &allowed(),
        );
        assert_eq!(out, "你好 <laugh> 朋友");
    }

    #[test]
    fn clipping_drops_the_dangling_separator_it_cut_on() {
        assert_eq!(clip_to_chars("a deep, gravelly voice", 8), "a deep");
    }

    #[test]
    fn fences_quotes_and_line_breaks_are_stripped_from_the_instruct() {
        assert_eq!(
            sanitize_single_line("```text\n\"a warm  narrator\"\n```"),
            "a warm narrator"
        );
        // A model wrapping ONE sentence across two lines must not be truncated:
        // the preamble pass drops leading announcement lines, never picks a line.
        assert_eq!(sanitize_single_line("  a calm\n voice  "), "a calm voice");
    }

    /// Small local models answer with an announcement line before the instruct.
    /// Welding it on spends the character budget on junk and steers synthesis
    /// with it, so the leading line has to go.
    #[test]
    fn an_announcement_line_is_dropped_rather_than_welded_onto_the_instruct() {
        assert_eq!(
            sanitize_single_line(
                "Sure! Here's the voice-design instruction:\nA deep, gravelly middle-aged American man."
            ),
            "A deep, gravelly middle-aged American man."
        );
        // No colon, just the stock acknowledgement opener.
        assert_eq!(
            sanitize_single_line("Of course.\n\nA bright, youthful narrator."),
            "A bright, youthful narrator."
        );
        // Quotes around the instruct survive the preamble strip and are removed.
        assert_eq!(
            sanitize_single_line("Here is the instruction:\n\"A warm narrator.\""),
            "A warm narrator."
        );
    }

    /// An answer that is ONLY a preamble must not sanitize to nothing — the
    /// caller would report "the model returned an empty voice description" for
    /// text it could have used.
    #[test]
    fn an_answer_that_is_only_a_preamble_is_kept_whole() {
        assert_eq!(
            sanitize_single_line("Sure, a deep and gravelly voice."),
            "Sure, a deep and gravelly voice."
        );
    }

    // ── tag validation ───────────────────────────────────────────────────────

    #[test]
    fn allowed_tags_survive_and_invented_ones_are_dropped() {
        let out = strip_unknown_tags(
            "hi <laugh> there <whisper> friend <sigh>",
            "hi there friend",
            TagSyntax::Angle,
            &allowed(),
        );
        assert_eq!(out, "hi <laugh> there friend <sigh>");
    }

    #[test]
    fn the_wrong_delimiter_style_never_survives() {
        // Square-bracket tags requested: angle-bracket ones the model reached for
        // are dropped rather than read aloud.
        let out = strip_unknown_tags(
            "hi <laugh> there [laugh]",
            "hi there",
            TagSyntax::Square,
            &allowed(),
        );
        assert_eq!(out, "hi there [laugh]");
        // …and symmetrically.
        let out = strip_unknown_tags(
            "hi [laugh] there <laugh>",
            "hi there",
            TagSyntax::Angle,
            &allowed(),
        );
        assert_eq!(out, "hi there <laugh>");
    }

    /// The gap the wrong-delimiter test above does NOT cover: an INVENTED name in
    /// the other syntax. `[laughs]` is the dominant convention in training
    /// corpora, so it is the likeliest wrong answer to a request for `<laugh>` —
    /// and matching neither the vocabulary nor the engine's delimiters, it used to
    /// slip through both the filter and the "only added tags" guard and be read
    /// out loud as a word.
    #[test]
    fn an_invented_tag_in_the_other_syntax_is_dropped_too() {
        let out = strip_unknown_tags(
            "Hi [laughs] there, friend.",
            "Hi there, friend.",
            TagSyntax::Angle,
            &allowed(),
        );
        assert_eq!(out, "Hi there, friend.");

        // Chatterbox Turbo is on square brackets, so the mirror case is an
        // invented angle-bracket run.
        let out = strip_unknown_tags(
            "Hi <whisper> there, friend.",
            "Hi there, friend.",
            TagSyntax::Square,
            &allowed(),
        );
        assert_eq!(out, "Hi there, friend.");
    }

    /// Provenance, not shape: the SAME string is deleted when the model invented
    /// it and preserved when the user wrote it.
    #[test]
    fn an_authored_run_survives_the_filter_that_deletes_an_invented_one() {
        let authored = strip_unknown_tags(
            "the report [sic] was late",
            "the report [sic] was late",
            TagSyntax::Square,
            &allowed(),
        );
        assert_eq!(authored, "the report [sic] was late");

        let invented = strip_unknown_tags(
            "the report [sic] was late",
            "the report was late",
            TagSyntax::Square,
            &allowed(),
        );
        assert_eq!(invented, "the report was late");
    }

    /// A model that DUPLICATES one of the user's own runs loses only the copy.
    #[test]
    fn a_duplicated_authored_run_loses_only_the_copy() {
        let out = strip_unknown_tags(
            "see [1] and [1] and [1]",
            "see [1] and [1]",
            TagSyntax::Square,
            &allowed(),
        );
        assert_eq!(out, "see [1] and [1] and");
    }

    #[test]
    fn bracketed_prose_that_is_not_a_tag_is_left_alone() {
        // `[sic]` is the user's own copy, not a tag artifact, and the engine is
        // on angle brackets here.
        let out = strip_unknown_tags(
            "the report [sic] was late",
            "the report [sic] was late",
            TagSyntax::Angle,
            &allowed(),
        );
        assert_eq!(out, "the report [sic] was late");
    }

    #[test]
    fn unterminated_and_empty_runs_do_not_panic_or_eat_text() {
        assert_eq!(
            strip_unknown_tags(
                "hi <laugh there",
                "hi <laugh there",
                TagSyntax::Angle,
                &allowed()
            ),
            "hi <laugh there"
        );
        assert_eq!(
            strip_unknown_tags("hi <> there", "hi there", TagSyntax::Angle, &allowed()),
            "hi there"
        );
    }

    /// Read-aloud runs this filter over ARBITRARY selected text, where `<` and
    /// `[` are ordinary prose. A run that is not one bare word can never be an
    /// invented tag, so deleting it would silently eat words the user asked to
    /// hear — and `comparable_words` would not notice, because it discards
    /// bracketed spans on both sides.
    #[test]
    fn bracketed_prose_in_the_engines_own_syntax_is_not_eaten() {
        let out = strip_unknown_tags(
            "mail me at <john@example.com> tomorrow",
            "mail me at <john@example.com> tomorrow",
            TagSyntax::Angle,
            &allowed(),
        );
        assert_eq!(out, "mail me at <john@example.com> tomorrow");

        let out = strip_unknown_tags(
            "if x < 10 and y > 2 then stop",
            "if x < 10 and y > 2 then stop",
            TagSyntax::Angle,
            &allowed(),
        );
        assert_eq!(out, "if x < 10 and y > 2 then stop");

        let out = strip_unknown_tags(
            "the note [see fig. 3] applies",
            "the note [see fig. 3] applies",
            TagSyntax::Square,
            &allowed(),
        );
        assert_eq!(out, "the note [see fig. 3] applies");

        // …and a genuinely invented one-word tag is still dropped.
        assert_eq!(
            strip_unknown_tags(
                "hi <whisper> there",
                "hi there",
                TagSyntax::Angle,
                &allowed()
            ),
            "hi there"
        );
    }

    /// The reported hole this pairs with: a ONE-WORD bracketed run in the
    /// engine's OWN delimiters is indistinguishable from an invented tag by
    /// shape, so it used to be deleted from the spoken text unconditionally —
    /// silently eating a word the user asked to hear, with `comparable_words`
    /// blind to the loss. Square syntax (chatterbox-turbo) is where it bit
    /// hardest: citation markers and `[sic]` are exactly this shape.
    #[test]
    fn single_word_prose_in_the_engines_own_syntax_survives() {
        for (text, syntax) in [
            ("Hello <name>, welcome aboard.", TagSyntax::Angle),
            ("Use the <div> element here.", TagSyntax::Angle),
            ("the report [sic] was late", TagSyntax::Square),
            ("see [1] for details", TagSyntax::Square),
            ("Dear [customer], your order shipped.", TagSyntax::Square),
        ] {
            // The model returned the text untouched — nothing may be lost.
            assert_eq!(
                strip_unknown_tags(text, text, syntax, &allowed()),
                text,
                "{text:?} under {syntax:?}"
            );
        }
    }

    /// The "only added tags" guard must not go blind past a lone `<`: if the
    /// bracket swallowed the remainder on both sides, a rewritten tail would
    /// compare equal and reach the synthesizer.
    #[test]
    fn a_rewrite_after_a_lone_bracket_is_still_caught() {
        assert_ne!(
            comparable_words("if x < 10 then stop"),
            comparable_words("if x < 10 then continue"),
        );
        // Adding a tag beside prose brackets still compares equal.
        assert_eq!(
            comparable_words("mail me at <john@example.com> now"),
            comparable_words("mail me at <john@example.com> <laugh> now"),
        );
    }

    #[test]
    fn kept_tags_are_re_emitted_canonically() {
        // Sloppy casing/spacing would not match the engine's token, so a kept run
        // is rewritten rather than passed through.
        let out = strip_unknown_tags(
            "hi < Laugh > there",
            "hi there",
            TagSyntax::Angle,
            &allowed(),
        );
        assert_eq!(out, "hi <laugh> there");
    }

    #[test]
    fn removing_a_tag_tidies_the_whitespace_it_leaves() {
        let out = strip_unknown_tags(
            "well <gasp> , then",
            "well, then",
            TagSyntax::Angle,
            &allowed(),
        );
        assert_eq!(out, "well, then");
    }

    #[test]
    fn the_vocabulary_prompt_uses_the_models_own_delimiters() {
        let prompt = tag_system_prompt(TagSyntax::Square, &allowed());
        assert!(prompt.contains("[laugh] [sigh]"), "{prompt}");
        let prompt = tag_system_prompt(TagSyntax::Angle, &allowed());
        assert!(prompt.contains("<laugh> <sigh>"), "{prompt}");
    }

    #[test]
    fn allowed_tags_are_normalized_to_bare_lowercase_names() {
        let normalized = normalize_allowed_tags(&[
            " [Laugh] ".to_string(),
            "<laugh>".to_string(),
            "  ".to_string(),
            "sigh".to_string(),
        ]);
        assert_eq!(normalized, vec!["laugh".to_string(), "sigh".to_string()]);
    }

    #[test]
    fn word_preservation_ignores_tags_but_catches_a_rewrite() {
        assert_eq!(
            comparable_words("Hi <laugh> there, friend!"),
            comparable_words("Hi there friend")
        );
        assert_ne!(
            comparable_words("Hi there, friend!"),
            comparable_words("Greetings there, friend!")
        );
    }

    // ── the read-aloud vocabulary lookup ─────────────────────────────────────

    #[test]
    fn the_read_aloud_vocabulary_comes_from_the_selected_models_own_row() {
        let mut settings = WinsttSettings::default();
        // Orpheus and Chatterbox Turbo are the only two shipped rows with a
        // vocabulary, and they do NOT share a syntax — this is exactly the pair a
        // hardcoded delimiter would break.
        settings.tts.model = "orpheus-3b".to_string();
        let (syntax, tags) = selected_tag_vocabulary(&settings).expect("orpheus has tags");
        assert_eq!(syntax, TagSyntax::Angle);
        assert!(tags.contains(&"laugh".to_string()), "{tags:?}");

        settings.tts.model = "chatterbox-turbo".to_string();
        let (syntax, tags) = selected_tag_vocabulary(&settings).expect("turbo has tags");
        assert_eq!(syntax, TagSyntax::Square);
        assert!(tags.contains(&"cough".to_string()), "{tags:?}");
    }

    #[test]
    fn a_model_without_a_vocabulary_yields_nothing_to_annotate_with() {
        let mut settings = WinsttSettings::default();
        settings.tts.model = "kokoro-82m".to_string();
        assert!(selected_tag_vocabulary(&settings).is_none());
        // Settings are user-editable JSON, so an unknown id is a normal input.
        settings.tts.model = "not-a-model".to_string();
        assert!(selected_tag_vocabulary(&settings).is_none());
    }

    // ── availability gate ────────────────────────────────────────────────────

    #[test]
    fn availability_requires_both_the_toggle_and_a_model() {
        let mut settings = WinsttSettings::default();
        settings.llm.dictation.base.provider = LlmProvider::Ollama;
        settings.llm.dictation.enabled = false;
        settings.llm.dictation.base.model = "qwen3:4b".to_string();
        assert!(
            post_processing_ready(&settings).is_err(),
            "a configured model without the toggle is not ready"
        );

        settings.llm.dictation.enabled = true;
        settings.llm.dictation.base.model = String::new();
        assert!(
            post_processing_ready(&settings).is_err(),
            "the toggle without a model is not ready"
        );

        settings.llm.dictation.base.model = "qwen3:4b".to_string();
        assert!(post_processing_ready(&settings).is_ok());
    }

    #[test]
    fn openrouter_needs_both_a_key_and_a_model() {
        let mut settings = WinsttSettings::default();
        settings.llm.dictation.enabled = true;
        settings.llm.dictation.base.provider = LlmProvider::Openrouter;
        settings.llm.openrouter_api_key = "sk-test".to_string();
        assert!(
            post_processing_ready(&settings).is_err(),
            "a key alone must not fall through to openrouter/auto"
        );
        settings.llm.dictation.base.openrouter_model = "openai/gpt-4o-mini".to_string();
        assert!(post_processing_ready(&settings).is_ok());
    }

    #[test]
    fn apple_intelligence_needs_no_model_id() {
        let mut settings = WinsttSettings::default();
        settings.llm.dictation.enabled = true;
        settings.llm.dictation.base.provider = LlmProvider::AppleIntelligence;
        settings.llm.dictation.base.model.clear();
        assert!(post_processing_ready(&settings).is_ok());
    }

    // ── reference clips ──────────────────────────────────────────────────────

    #[test]
    fn the_clip_cap_follows_the_selected_model_and_never_reads_as_uncapped() {
        let mut settings = WinsttSettings::default();
        settings.tts.model = "spark-tts-0.5b".to_string();
        assert_eq!(reference_clip_budget(&settings), MAX_CLONE_REF_SECS);
        // A non-cloning selection must not resolve to the row's `0` (= no cap).
        settings.tts.model = "kokoro-82m".to_string();
        assert_eq!(reference_clip_budget(&settings), MAX_CLONE_REF_SECS);
        settings.tts.model = "not-a-model".to_string();
        assert_eq!(reference_clip_budget(&settings), MAX_CLONE_REF_SECS);
    }

    #[test]
    fn the_voice_design_budget_follows_the_selected_model() {
        let mut settings = WinsttSettings::default();
        settings.tts.model = "qwen3-tts-1.7b-voicedesign".to_string();
        assert_eq!(
            voice_design_budget(&settings),
            VOICE_DESIGN_PROMPT_MAX_CHARS as usize
        );
        settings.tts.model = "kokoro-82m".to_string();
        assert_eq!(
            voice_design_budget(&settings),
            VOICE_DESIGN_PROMPT_MAX_CHARS as usize
        );
    }

    #[test]
    fn only_decodable_containers_are_accepted() {
        assert!(has_supported_extension(Path::new("voice.WAV")));
        assert!(has_supported_extension(Path::new("voice.mp3")));
        assert!(!has_supported_extension(Path::new("voice.txt")));
        assert!(!has_supported_extension(Path::new("voice")));
    }

    // ── read-aloud modifiers ─────────────────────────────────────────────────

    fn settings_with_read_aloud(
        presets: Vec<crate::winstt::settings_schema::PresetEntry>,
        customs: Vec<crate::winstt::settings_schema::CustomModifier>,
    ) -> WinsttSettings {
        let mut settings = WinsttSettings::default();
        settings.llm.read_aloud.presets = presets;
        settings.llm.read_aloud.custom_modifiers = customs;
        settings
    }

    fn settings_preset(
        key: crate::winstt::settings_schema::PresetKey,
    ) -> crate::winstt::settings_schema::PresetEntry {
        crate::winstt::settings_schema::PresetEntry {
            key,
            level: None,
            target_lang: None,
        }
    }

    fn settings_custom(
        enabled: bool,
        prompt: &str,
    ) -> crate::winstt::settings_schema::CustomModifier {
        crate::winstt::settings_schema::CustomModifier {
            id: "m1".to_string(),
            name: "Shout".to_string(),
            prompt: prompt.to_string(),
            enabled,
            levels_enabled: false,
            level: None,
        }
    }

    /// The default read-aloud list is `[neutral]`, i.e. "no operation". A read
    /// must NOT pay for an LLM round-trip before its first word just to be told
    /// nothing was requested.
    #[test]
    fn the_default_preset_list_is_not_an_active_operation() {
        let settings = WinsttSettings::default();
        assert!(!has_active_read_aloud_operation(&read_aloud_presets(
            &settings
        )));
    }

    #[test]
    fn a_builtin_modifier_counts_as_an_active_operation() {
        let settings = settings_with_read_aloud(
            vec![
                settings_preset(crate::winstt::settings_schema::PresetKey::Neutral),
                settings_preset(crate::winstt::settings_schema::PresetKey::Summarize),
            ],
            Vec::new(),
        );
        assert!(has_active_read_aloud_operation(&read_aloud_presets(
            &settings
        )));
    }

    /// A custom modifier the user has toggled OFF is still persisted (so its
    /// authored prompt survives), but must not drag a round-trip into the read.
    #[test]
    fn a_disabled_custom_modifier_is_not_an_active_operation() {
        let settings =
            settings_with_read_aloud(Vec::new(), vec![settings_custom(false, "Shout it")]);
        assert!(!has_active_read_aloud_operation(&read_aloud_presets(
            &settings
        )));
    }

    #[test]
    fn an_enabled_custom_modifier_is_an_active_operation() {
        let settings =
            settings_with_read_aloud(Vec::new(), vec![settings_custom(true, "Shout it")]);
        assert!(has_active_read_aloud_operation(&read_aloud_presets(
            &settings
        )));
    }

    /// Read-aloud modifiers are a SEPARATE list from the dictation ones: filling
    /// dictation's must not make the read-aloud pass believe it has work.
    #[test]
    fn dictation_modifiers_do_not_leak_into_the_read_aloud_pass() {
        let mut settings = WinsttSettings::default();
        settings.llm.dictation.presets = vec![settings_preset(
            crate::winstt::settings_schema::PresetKey::Summarize,
        )];
        assert!(!has_active_read_aloud_operation(&read_aloud_presets(
            &settings
        )));
    }

    // ── multi-clip voices ────────────────────────────────────────────────────

    #[test]
    fn a_concatenation_is_the_parts_plus_one_gap_between_each() {
        let parts = vec![vec![0.5_f32; 100], vec![0.25_f32; 60], vec![0.75_f32; 40]];
        let (combined, trimmed) = concatenate_parts(&parts, 10, usize::MAX);

        assert_eq!(combined.len(), 100 + 60 + 40 + 2 * 10);
        assert!(!trimmed);
        // No gap before the first part (it would shift every engine's onset) or
        // after the last (dead budget).
        assert!((combined[0] - 0.5).abs() < f32::EPSILON);
        assert!((combined[combined.len() - 1] - 0.75).abs() < f32::EPSILON);
        assert!(combined[100..110].iter().all(|s| *s == 0.0), "seam silence");
    }

    /// The single-clip path must survive unchanged inside the multi-clip one: one
    /// source is welded with no gap at all, so a one-path build is byte-identical
    /// to what `tts_prepare_reference_clip` stores.
    #[test]
    fn a_single_part_is_welded_with_no_gap_at_all() {
        let (combined, trimmed) = concatenate_parts(&[vec![1.0_f32; 24]], 6_000, usize::MAX);
        assert_eq!(combined, vec![1.0_f32; 24]);
        assert!(!trimmed);
    }

    #[test]
    fn the_cap_truncates_the_concatenation_rather_than_rejecting_it() {
        let parts = vec![vec![1.0_f32; 100], vec![2.0_f32; 100]];
        let (combined, trimmed) = concatenate_parts(&parts, 10, 150);

        assert_eq!(combined.len(), 150, "the cap is the invariant");
        assert!(trimmed, "dropping the tail must be reported");
        // Truncation only ever removes a suffix.
        assert!(
            combined[..100]
                .iter()
                .all(|s| (*s - 1.0).abs() < f32::EPSILON)
        );
    }

    /// The floor is the one thing that DOES reject: welding two fragments that are
    /// still under a second between them cannot be silently accepted, or the
    /// engine clones from noise.
    #[test]
    fn a_total_under_the_floor_is_refused() {
        let rate = f64::from(REFERENCE_CLIP_SAMPLE_RATE);
        let gap = (REFERENCE_GAP_SECS * rate) as usize;
        let scraps = vec![vec![0.1_f32; 2_000], vec![0.1_f32; 2_000]];
        let (combined, _) = concatenate_parts(&scraps, gap, usize::MAX);
        assert!(
            catalog::reject_short_reference(combined.len() as f64 / rate).is_err(),
            "0.4 s of audio is below MIN_CLONE_REF_SECS"
        );

        let takes = vec![vec![0.1_f32; 24_000], vec![0.1_f32; 24_000]];
        let (combined, _) = concatenate_parts(&takes, gap, usize::MAX);
        assert!(catalog::reject_short_reference(combined.len() as f64 / rate).is_ok());
    }

    #[test]
    fn the_combined_name_is_stable_per_ordered_set() {
        let one = PathBuf::from("C:/voices/one-0000000000000001.wav");
        let two = PathBuf::from("C:/voices/two-0000000000000002.wav");
        let pair = [one.clone(), two.clone()];

        assert_eq!(combined_clip_name(&pair, 30), combined_clip_name(&pair, 30));
        // The same takes in the other order are DIFFERENT audio.
        assert_ne!(
            combined_clip_name(&pair, 30),
            combined_clip_name(&[two, one.clone()], 30)
        );
        assert_ne!(
            combined_clip_name(&pair, 30),
            combined_clip_name(&[one], 30)
        );
        assert!(combined_clip_name(&pair, 30).ends_with(".wav"));
    }

    /// One voice is offered under every cloning engine, and their budgets differ
    /// six-fold. The same parts welded for 30 s and for 5 s are DIFFERENT audio,
    /// so they must not land on the same file — otherwise whichever model was
    /// selected last silently rewrites the clip the other one is using.
    #[test]
    fn the_combined_name_separates_two_budgets() {
        let parts = [PathBuf::from("C:/voices/one-0000000000000001.wav")];

        assert_ne!(
            combined_clip_name(&parts, catalog::MAX_CLONE_REF_SECS),
            combined_clip_name(&parts, catalog::OMNIVOICE_MAX_CLONE_REF_SECS)
        );
    }

    /// The access rule's second half. A raw string test would accept
    /// `<root>/../elsewhere.wav`, which is exactly the path a renderer would send
    /// to make this command decode — or delete — a file outside the folder.
    #[test]
    fn only_paths_that_resolve_inside_the_managed_folder_are_accepted() {
        let base = tempfile::tempdir().expect("temp dir");
        let root = base.path().join("reference-voices");
        std::fs::create_dir_all(&root).expect("managed folder");
        let inside = root.join("clip.wav");
        std::fs::write(&inside, b"x").expect("inside");
        let outside = base.path().join("outside.wav");
        std::fs::write(&outside, b"x").expect("outside");

        assert!(canonical_path_inside_dir(&inside, &root).is_some());
        assert!(canonical_path_inside_dir(&outside, &root).is_none());

        let traversal = root.join("..").join("outside.wav");
        assert!(
            traversal.starts_with(&root),
            "the unresolved path looks contained — only canonicalizing catches it"
        );
        assert!(canonical_path_inside_dir(&traversal, &root).is_none());

        // A path that does not exist is never confined, which is what makes
        // deleting it a no-op rather than an error.
        assert!(canonical_path_inside_dir(&root.join("gone.wav"), &root).is_none());
    }

    #[test]
    fn a_rebuilt_parts_label_reads_as_the_file_the_user_picked() {
        assert_eq!(
            part_display_name(Path::new("C:/voices/take_one-0123456789abcdef.wav"), true),
            "take_one"
        );
        // Not a storage hash: the stem is shown whole.
        assert_eq!(
            part_display_name(Path::new("C:/clips/take-two.mp3"), false),
            "take-two"
        );
        assert_eq!(
            part_display_name(Path::new("C:/clips/take-two-0123456789abcdef.wav"), false),
            "take-two-0123456789abcdef",
            "an unmanaged path keeps its stem verbatim"
        );
    }

    #[test]
    fn stored_clip_names_are_stable_per_source_and_filesystem_safe() {
        let a = stored_clip_name(Path::new("C:/clips/My Voice (take 2).mp3"));
        assert_eq!(
            a,
            stored_clip_name(Path::new("C:/clips/My Voice (take 2).mp3"))
        );
        assert_ne!(a, stored_clip_name(Path::new("C:/clips/other.mp3")));
        assert!(a.ends_with(".wav"));
        assert!(
            a.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.'),
            "{a}"
        );
    }
}
