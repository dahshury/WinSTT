// Decode via symphonia
// (in-process; no external ffmpeg, unlike the Python server's ffmpeg shell-out).
//
// FileTranscribeManager is a faithful Rust port of WinSTT's reference
// `setupFileTranscribeQueue`: a SEQUENTIAL file queue (the shared STT model is
// single-threaded) with
//
//   1. Pump            — transcribes one file at a time, advancing on terminal.
//   2. PTT auto-pause  — pauses the WHOLE queue while the user dictates
//                        (whole-queue `pause()`/`resume()`, no id).
//   3. Per-row pause   — a "paused" row is skipped by the pump so a stopped file
//                        never blocks newly-dropped ones; resume re-queues it.
//   4. Busy flag       — broadcast on transitions so the detached model-picker
//                        disables model switching while busy.
//
// The renderer event contract is BYTE-IDENTICAL to WinSTT's reference IPC so the
// reused `features/file-transcription` store/listener need no changes:
//   • `file:queue-update`   → { items: [{ id, fileName, status, progress, stage, message }] }
//   • `file:queue-progress` → { id, progress, stage }   (high-frequency tick)
//   • `file:queue-active`   → { active }                (cross-window, on transition)
// Statuses: "queued" | "transcribing" | "complete" | "error" | "paused" | "canceled".
//
// Difference from the reference: `TranscriptionManager::transcribe(Vec<f32>)`
// is a ONE-SHOT call (no streaming server, so no `resume_from`/`partial_segments`
// mid-file). Per-row resume therefore re-transcribes the file from the start
// (functionally identical output; only wasted work, like a cold retry). The
// queue/pause/skip/broadcast mechanics are preserved exactly.
//
// The audio decode (symphonia: wav/mp3/mp4/aac/flac/ogg/vorbis) + 16 kHz mono
// resample live in the sibling `transcode` module (`decode_audio_to_pcm`); the
// queue/lifecycle/pause-resume control logic lives here.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::DialogExt;

use crate::managers::transcription::TranscriptionManager;
use crate::winstt::managers::transcode::{
    decode_audio_to_pcm, format_transcript, TARGET_SAMPLE_RATE,
};
use crate::winstt::observability::IssueBuilder;
use crate::winstt::settings_schema::{FileSaveLocation, FileTranscriptionFormat};
use crate::winstt::sync_ext::MutexExt;

/// Auto-clear delay: once every row is terminal the queue clears itself after
/// this delay so the main window returns to the visualizer without a click.
/// (Cancelled if new files are dropped meanwhile.) Mirrors AUTO_CLEAR_DELAY_MS.
const AUTO_CLEAR_DELAY_MS: u64 = 2500;

/// One queued file + its lifecycle. Field names mirror the reference `QueueItem`.
#[derive(Clone, Debug)]
struct QueueItem {
    id: String,
    file_path: PathBuf,
    file_name: String,
    status: QueueStatus,
    /// 0.0..1.0 progress within this file.
    progress: f32,
    stage: String,
    message: String,
    /// Filled on completion so the per-row Copy action can read it.
    text: Option<String>,
    /// True when the USER manually paused this row (survives a PTT auto-resume).
    paused_by_user: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QueueStatus {
    Queued,
    Transcribing,
    Complete,
    Error,
    Paused,
    Canceled,
}

impl QueueStatus {
    /// Renderer DTO string — matches the WinSTT `QueueStatus` union exactly.
    fn as_str(self) -> &'static str {
        match self {
            QueueStatus::Queued => "queued",
            QueueStatus::Transcribing => "transcribing",
            QueueStatus::Complete => "complete",
            QueueStatus::Error => "error",
            QueueStatus::Paused => "paused",
            QueueStatus::Canceled => "canceled",
        }
    }

    fn is_busy(self) -> bool {
        matches!(
            self,
            QueueStatus::Queued | QueueStatus::Transcribing | QueueStatus::Paused
        )
    }

    fn is_terminal(self) -> bool {
        matches!(
            self,
            QueueStatus::Complete | QueueStatus::Error | QueueStatus::Canceled
        )
    }
}

/// Renderer-facing DTO emitted in `file:queue-update`. Byte-identical to the
/// the reference `QueueItemDTO` (no path, no text — display-only).
#[derive(Clone, Debug, Serialize)]
pub struct QueueItemDto {
    id: String,
    #[serde(rename = "fileName")]
    file_name: String,
    status: String,
    progress: f32,
    stage: String,
    message: String,
}

impl From<&QueueItem> for QueueItemDto {
    fn from(it: &QueueItem) -> Self {
        Self {
            id: it.id.clone(),
            file_name: it.file_name.clone(),
            status: it.status.as_str().to_string(),
            progress: it.progress,
            stage: it.stage.clone(),
            message: it.message.clone(),
        }
    }
}

/// Shared queue state behind a mutex; the worker + control commands touch it.
#[derive(Default)]
struct QueueState {
    /// Ordered queue (drop order preserved).
    items: Vec<QueueItem>,
    /// id of the file currently running, if any.
    active: Option<String>,
    /// Generation token for the auto-clear timer (bumped to cancel a pending one).
    auto_clear_gen: u64,
}

pub struct FileTranscribeManager {
    app: AppHandle,
    transcription: Arc<TranscriptionManager>,
    state: Mutex<QueueState>,
    /// Push-to-talk auto-pause: blocks the WHOLE pump (the model is busy
    /// dictating). Per-row pause is a `Paused` STATUS the pump skips.
    dictation_paused: AtomicBool,
    /// Last broadcast busy value — only emit `file:queue-active` on transitions.
    last_broadcast_active: Mutex<Option<bool>>,
    /// Wakes the worker when a file is enqueued / pause released / cancel.
    cv: Condvar,
    /// Guards the worker against the cv (the cv pairs with this mutex).
    worker_gate: Mutex<()>,
    /// Set while a worker thread is alive (one at a time).
    worker_alive: AtomicBool,
    /// Monotonic id counter for enqueued files.
    counter: AtomicU64,
}

impl FileTranscribeManager {
    pub fn new(app: &AppHandle, transcription: Arc<TranscriptionManager>) -> Self {
        Self {
            app: app.clone(),
            transcription,
            state: Mutex::new(QueueState::default()),
            dictation_paused: AtomicBool::new(false),
            last_broadcast_active: Mutex::new(None),
            cv: Condvar::new(),
            worker_gate: Mutex::new(()),
            worker_alive: AtomicBool::new(false),
            counter: AtomicU64::new(0),
        }
    }

    pub fn app(&self) -> &AppHandle {
        &self.app
    }

    // ── Renderer → backend commands ─────────────────────────────────────────

    /// `file:queue-enqueue` — append transcribable files (drop order preserved).
    /// Repeated drops accumulate; the queue is never cleared on a new drop.
    /// Returns the assigned ids (correlate with the progress events).
    pub fn enqueue(self: &Arc<Self>, files: Vec<(PathBuf, String)>) -> Vec<String> {
        let mut ids = Vec::with_capacity(files.len());
        let mut added = false;
        {
            let mut st = self.lock_state();
            for (file_path, file_name) in files {
                if file_path.as_os_str().is_empty() {
                    continue;
                }
                let id = format!("fq-{}-{}", self.next_counter(), now_millis());
                let name = if file_name.is_empty() {
                    file_path
                        .file_name()
                        .map_or_else(|| id.clone(), |s| s.to_string_lossy().to_string())
                } else {
                    file_name
                };
                ids.push(id.clone());
                st.items.push(QueueItem {
                    id,
                    file_path,
                    file_name: name,
                    status: QueueStatus::Queued,
                    progress: 0.0,
                    stage: "queued".into(),
                    message: String::new(),
                    text: None,
                    paused_by_user: false,
                });
                added = true;
            }
        }
        if added {
            self.emit_queue();
            self.ensure_worker();
        }
        ids
    }

    /// `file:queue-cancel` `{id}` — drop a queued/paused row, or cancel the
    /// in-flight file (the running file finishes its one-shot transcribe; the row
    /// is removed once it returns). Mirrors the reference `cancel`.
    pub fn cancel(self: &Arc<Self>, id: &str) {
        let mut removed = false;
        {
            let mut st = self.lock_state();
            if let Some(pos) = st.items.iter().position(|it| it.id == id) {
                if st.items[pos].status == QueueStatus::Transcribing {
                    // In-flight one-shot can't be interrupted mid-transcribe; mark
                    // it canceled so `finish` removes it when the transcribe returns.
                    st.items[pos].status = QueueStatus::Canceled;
                    st.items[pos].stage = "canceled".into();
                    st.items[pos].message = "Canceled".into();
                } else {
                    st.items.remove(pos);
                    removed = true;
                }
            }
        }
        if removed {
            self.emit_queue();
        }
        self.cv.notify_all();
    }

    /// `file:queue-retry` `{id}` — re-queue a terminal/paused row from scratch.
    pub fn retry(self: &Arc<Self>, id: &str) {
        let mut changed = false;
        {
            let mut st = self.lock_state();
            if let Some(it) = st.items.iter_mut().find(|it| it.id == id) {
                if it.status != QueueStatus::Transcribing {
                    it.status = QueueStatus::Queued;
                    it.progress = 0.0;
                    it.stage = "queued".into();
                    it.message = String::new();
                    it.text = None;
                    it.paused_by_user = false;
                    changed = true;
                }
            }
        }
        if changed {
            self.emit_queue();
            self.ensure_worker();
        }
    }

    /// `file:queue-copy` `{id}` — copy a completed row's transcript to the
    /// clipboard via Tauri's clipboard-manager plugin.
    pub fn copy(&self, id: &str) {
        let text = {
            let st = self.lock_state();
            st.items
                .iter()
                .find(|it| it.id == id)
                .and_then(|it| it.text.clone())
        };
        if let Some(text) = text {
            if !text.is_empty() {
                if let Err(e) = self.write_clipboard(&text) {
                    log::warn!("[file-transcribe] copy to clipboard failed for {id}: {e}");
                }
            }
        }
    }

    /// `file:queue-clear` — remove every terminal row (auto-clear path). Busy
    /// rows (queued/transcribing/paused) stay.
    pub fn clear_finished(self: &Arc<Self>) {
        {
            let mut st = self.lock_state();
            st.items.retain(|it| !it.status.is_terminal());
        }
        self.emit_queue();
    }

    /// `file:queue-pause` — optional `{id}`.
    ///   • with `id`  → per-row manual pause (only a running row).
    ///   • no `id`    → PTT whole-queue auto-pause (the model is busy dictating).
    pub fn pause(self: &Arc<Self>, id: Option<&str>) {
        match id {
            Some(id) => self.pause_item(id),
            None => self.pause_for_dictation(),
        }
    }

    /// `file:queue-resume` — optional `{id}` (symmetric with `pause`).
    pub fn resume(self: &Arc<Self>, id: Option<&str>) {
        match id {
            Some(id) => self.resume_item(id),
            None => self.resume_after_dictation(),
        }
    }

    /// `file:queue-discard-all` — cancel the in-flight file and drop all rows,
    /// returning the main window to the visualizer immediately. Completed
    /// transcripts are already saved, so this only clears the queue UI.
    pub fn discard_all(self: &Arc<Self>) {
        {
            let mut st = self.lock_state();
            st.items.clear();
            st.active = None;
        }
        self.dictation_paused.store(false, Ordering::Release);
        self.emit_queue();
        self.cv.notify_all();
    }

    /// `file:queue-get-active` — one-shot busy-flag read for windows mounted
    /// AFTER the edge-triggered broadcast (the detached model-picker queries this
    /// on mount).
    pub fn is_active(&self) -> bool {
        let st = self.lock_state();
        st.items.iter().any(|it| it.status.is_busy())
    }

    /// Snapshot the queue DTOs for the renderer (e.g. on window re-open).
    pub fn snapshot(&self) -> Vec<QueueItemDto> {
        let st = self.lock_state();
        st.items.iter().map(QueueItemDto::from).collect()
    }

    // ── PTT whole-queue pause / resume ──────────────────────────────────────

    fn pause_for_dictation(self: &Arc<Self>) {
        if self.dictation_paused.swap(true, Ordering::AcqRel) {
            return; // already paused
        }
        // Park the in-flight file's STATUS for the UI; the one-shot transcribe
        // already running can't be interrupted, but the pump won't pick up the
        // next file until resume.
        self.emit_queue();
    }

    fn resume_after_dictation(self: &Arc<Self>) {
        if !self.dictation_paused.swap(false, Ordering::AcqRel) {
            return; // wasn't paused
        }
        // Re-queue ONLY the rows dictation parked; USER-paused rows stay paused.
        {
            let mut st = self.lock_state();
            for it in st.items.iter_mut() {
                if it.status == QueueStatus::Paused && !it.paused_by_user {
                    it.status = QueueStatus::Queued;
                    it.stage = "queued".into();
                }
            }
        }
        self.emit_queue();
        self.cv.notify_all();
        self.ensure_worker();
    }

    // ── Per-row manual pause / resume ───────────────────────────────────────

    fn pause_item(self: &Arc<Self>, id: &str) {
        let mut changed = false;
        {
            let mut st = self.lock_state();
            if let Some(it) = st.items.iter_mut().find(|it| it.id == id) {
                // A running one-shot can't be interrupted, but mark Queued rows /
                // the running row as user-paused so the pump skips them next.
                if matches!(it.status, QueueStatus::Queued | QueueStatus::Transcribing) {
                    it.status = QueueStatus::Paused;
                    it.stage = "paused".into();
                    it.paused_by_user = true;
                    changed = true;
                }
            }
        }
        if changed {
            self.emit_queue();
        }
    }

    fn resume_item(self: &Arc<Self>, id: &str) {
        let mut changed = false;
        {
            let mut st = self.lock_state();
            if let Some(it) = st.items.iter_mut().find(|it| it.id == id) {
                if it.status == QueueStatus::Paused {
                    it.status = QueueStatus::Queued;
                    it.stage = "queued".into();
                    it.paused_by_user = false;
                    changed = true;
                }
            }
        }
        if changed {
            self.emit_queue();
            self.cv.notify_all();
            self.ensure_worker();
        }
    }

    // ── Worker / pump ───────────────────────────────────────────────────────

    /// Spawn the sequential worker thread if one isn't already running.
    fn ensure_worker(self: &Arc<Self>) {
        if self.worker_alive.swap(true, Ordering::AcqRel) {
            self.cv.notify_all();
            return;
        }
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            me.run_worker();
            me.worker_alive.store(false, Ordering::Release);
        });
    }

    fn run_worker(self: &Arc<Self>) {
        loop {
            // Block the WHOLE pump while dictation holds the model.
            if self.dictation_paused.load(Ordering::Acquire) {
                self.park();
                continue;
            }
            // Pop the next QUEUED row (skips Paused rows automatically).
            let next = {
                let mut st = self.lock_state();
                match st
                    .items
                    .iter()
                    .position(|it| it.status == QueueStatus::Queued)
                {
                    Some(i) => {
                        st.items[i].status = QueueStatus::Transcribing;
                        st.items[i].progress = 0.0;
                        st.items[i].stage = "starting".into();
                        st.items[i].message = String::new();
                        st.active = Some(st.items[i].id.clone());
                        Some(st.items[i].clone())
                    }
                    None => None,
                }
            };
            let Some(item) = next else {
                // No queued work. If there's still busy work (paused rows) keep the
                // worker parked on the cv; otherwise exit so a future enqueue
                // respawns it.
                let still_busy = {
                    let st = self.lock_state();
                    st.items.iter().any(|it| it.status.is_busy())
                };
                if !still_busy {
                    return;
                }
                self.park();
                continue;
            };
            self.emit_queue();
            self.process_file(&item);
        }
    }

    /// Park the worker on the condvar with a short timeout (a lost-wakeup safety
    /// net: a `notify_all` racing the predicate check would otherwise sleep the
    /// worker forever, since the queue/pause predicates live in a separate mutex).
    /// The worker re-evaluates on every wake/timeout — cheap and missed-signal
    /// proof, matching the event-driven re-pump of the single-threaded reference
    /// queue this ports.
    fn park(&self) {
        let gate = self.worker_gate.lock_recover();
        let _ = self
            .cv
            .wait_timeout(gate, std::time::Duration::from_millis(200));
    }

    fn process_file(self: &Arc<Self>, item: &QueueItem) {
        // Decode the file to 16 kHz mono f32, then transcribe the whole buffer in
        // one shot (`TranscriptionManager::transcribe` is one-shot — there's
        // no streaming server to feed a lazy VAD chunk iterator). The single 0.5
        // mid-file tick below stands in for the server's per-chunk progress loop.
        let audio = match decode_audio_to_pcm(&item.file_path) {
            Ok(a) => a,
            Err(e) => {
                self.finish(&item.id, QueueStatus::Error, None, None, Some(&e));
                return;
            }
        };
        let duration_secs = audio.len() as f64 / TARGET_SAMPLE_RATE as f64;

        // Mid-file progress tick so the bar moves before the (blocking) transcribe.
        self.tick_progress(&item.id, 0.5, "transcribing");

        match self.transcription.transcribe(audio) {
            Ok(text) => self.finish(
                &item.id,
                QueueStatus::Complete,
                Some(&text),
                Some(duration_secs),
                None,
            ),
            Err(e) => self.finish(
                &item.id,
                QueueStatus::Error,
                None,
                None,
                Some(&e.to_string()),
            ),
        }
    }

    /// High-frequency in-place progress tick → `file:queue-progress` (does NOT
    /// re-emit the whole list). Skips rows the user canceled/paused mid-flight.
    fn tick_progress(&self, id: &str, progress: f32, stage: &str) {
        let emit = {
            let mut st = self.lock_state();
            match st.items.iter_mut().find(|it| it.id == id) {
                Some(it) if it.status == QueueStatus::Transcribing => {
                    it.progress = progress;
                    it.stage = stage.into();
                    true
                }
                _ => false,
            }
        };
        if emit {
            let _ = self.app.emit(
                "file:queue-progress",
                FileQueueProgress {
                    id: id.to_string(),
                    progress,
                    stage: stage.to_string(),
                },
            );
        }
    }

    /// Terminal transition for the in-flight row, then advance the pump. A row
    /// canceled mid-transcribe (status flipped to Canceled by `cancel`) is
    /// removed instead of marked complete/error.
    fn finish(
        self: &Arc<Self>,
        id: &str,
        mut status: QueueStatus,
        text: Option<&str>,
        duration_secs: Option<f64>,
        error: Option<&str>,
    ) {
        let mut error_message = error.map(str::to_string);
        if status == QueueStatus::Complete {
            if let Some(text) = text {
                let output_target = {
                    let st = self.lock_state();
                    st.items
                        .iter()
                        .find(|it| it.id == id && it.status != QueueStatus::Canceled)
                        .map(|it| (it.file_path.clone(), it.file_name.clone()))
                };
                if let Some((source_path, file_name)) = output_target {
                    if let Err(e) = self.write_transcript_file(
                        &source_path,
                        &file_name,
                        text,
                        duration_secs.unwrap_or(0.0),
                    ) {
                        status = QueueStatus::Error;
                        error_message = Some(e);
                    }
                }
            }
        }
        let mut observed_error: Option<(String, String, String)> = None;
        {
            let mut st = self.lock_state();
            if let Some(pos) = st.items.iter().position(|it| it.id == id) {
                let was_canceled = st.items[pos].status == QueueStatus::Canceled;
                if was_canceled {
                    // The user canceled this row while it was running → drop it.
                    st.items.remove(pos);
                } else {
                    let it = &mut st.items[pos];
                    it.status = status;
                    match status {
                        QueueStatus::Complete => {
                            it.progress = 1.0;
                            it.stage = "complete".into();
                            it.text = text.map(str::to_string);
                        }
                        QueueStatus::Error => {
                            it.stage = "error".into();
                            it.message = error_message
                                .take()
                                .unwrap_or_else(|| "Transcription failed".into());
                            observed_error = Some((
                                it.file_name.clone(),
                                it.file_path.display().to_string(),
                                it.message.clone(),
                            ));
                        }
                        _ => {}
                    }
                }
            }
            st.active = None;
        }
        if let Some((file_name, path, detail)) = observed_error {
            IssueBuilder::new(
                "file_transcribe",
                "transcription",
                "File transcription failed",
            )
            .detail(detail)
            .request_id(id.to_string())
            .context("fileName", file_name)
            .context("path", path)
            .record(Some(&self.app));
        }
        self.emit_queue();
        // Wake the pump for the next queued row.
        self.cv.notify_all();
    }

    // ── Emission ────────────────────────────────────────────────────────────

    /// Re-emit the whole list (`file:queue-update`), update the busy flag, and
    /// schedule the auto-clear. Mirrors the reference `emitQueue`.
    fn emit_queue(self: &Arc<Self>) {
        let (items, busy, has_items): (Vec<QueueItemDto>, bool, bool) = {
            let st = self.lock_state();
            let busy = st.items.iter().any(|it| it.status.is_busy());
            (
                st.items.iter().map(QueueItemDto::from).collect(),
                busy,
                !st.items.is_empty(),
            )
        };
        let _ = self
            .app
            .emit("file:queue-update", FileQueueUpdate { items });
        self.broadcast_active(busy);
        self.schedule_auto_clear(busy, has_items);
    }

    /// Cross-window busy broadcast (`file:queue-active`), only on transitions —
    /// the detached model-picker disables selection while busy.
    fn broadcast_active(&self, active: bool) {
        {
            let mut last = self.last_broadcast_active.lock_recover();
            if *last == Some(active) {
                return;
            }
            *last = Some(active);
        }
        // Emit to every window so the detached model-picker sees it too.
        let _ = self
            .app
            .emit("file:queue-active", FileQueueActive { active });
    }

    /// Auto-return to the visualizer once every row is terminal: after a short
    /// delay, drop the finished rows (cancelled if the queue went busy again).
    fn schedule_auto_clear(self: &Arc<Self>, busy: bool, has_items: bool) {
        // Bump the generation so any in-flight timer becomes a no-op.
        let generation = {
            let mut st = self.lock_state();
            st.auto_clear_gen = st.auto_clear_gen.wrapping_add(1);
            st.auto_clear_gen
        };
        if busy || !has_items {
            return;
        }
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(AUTO_CLEAR_DELAY_MS));
            // Only fire if no newer schedule replaced us and nothing went busy.
            let proceed = {
                let st = me.lock_state();
                st.auto_clear_gen == generation && !st.items.iter().any(|it| it.status.is_busy())
            };
            if proceed {
                me.clear_finished();
            }
        });
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    fn write_transcript_file(
        &self,
        source_path: &Path,
        file_name: &str,
        text: &str,
        duration_secs: f64,
    ) -> Result<PathBuf, String> {
        let settings = crate::winstt::settings_store::read_settings_raw(&self.app);
        let format = settings.general.file_transcription_format;
        let output_path = self.resolve_transcript_output_path(
            source_path,
            file_name,
            format,
            settings.general.file_transcription_save_location,
        )?;
        let body = format_transcript(format, text, duration_secs);
        std::fs::write(&output_path, body)
            .map_err(|e| format!("Failed to write {}: {e}", output_path.display()))?;
        Ok(output_path)
    }

    fn resolve_transcript_output_path(
        &self,
        source_path: &Path,
        file_name: &str,
        format: FileTranscriptionFormat,
        save_location: FileSaveLocation,
    ) -> Result<PathBuf, String> {
        match save_location {
            FileSaveLocation::Auto => Ok(auto_transcript_output_path(source_path, format)),
            FileSaveLocation::Ask => self.pick_transcript_output_path(file_name, format),
        }
    }

    fn pick_transcript_output_path(
        &self,
        file_name: &str,
        format: FileTranscriptionFormat,
    ) -> Result<PathBuf, String> {
        let extension = transcript_extension(format);
        let default_name = format!("{file_name}.{extension}");
        let Some(path) = self
            .app
            .dialog()
            .file()
            .set_title("Save Transcript")
            .set_file_name(default_name)
            .add_filter(transcript_filter_name(format), &[extension])
            .blocking_save_file()
        else {
            return Err("Save canceled".into());
        };
        let mut path = path
            .into_path()
            .map_err(|_| "Save destination is not a filesystem path".to_string())?;
        if path.extension().and_then(|ext| ext.to_str()).is_none() {
            path.set_extension(extension);
        }
        Ok(path)
    }

    fn write_clipboard(&self, text: &str) -> Result<(), String> {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        self.app
            .clipboard()
            .write_text(text.to_string())
            .map_err(|e| e.to_string())
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, QueueState> {
        self.state.lock_recover()
    }

    fn next_counter(&self) -> u64 {
        self.counter.fetch_add(1, Ordering::Relaxed) + 1
    }
}

// ── Event payloads (renderer-shape, byte-identical to WinSTT reference IPC) ──

fn transcript_extension(format: FileTranscriptionFormat) -> &'static str {
    match format {
        FileTranscriptionFormat::Txt => "txt",
        FileTranscriptionFormat::Srt => "srt",
    }
}

fn transcript_filter_name(format: FileTranscriptionFormat) -> &'static str {
    match format {
        FileTranscriptionFormat::Txt => "Text",
        FileTranscriptionFormat::Srt => "SubRip subtitles",
    }
}

fn auto_transcript_output_path(source_path: &Path, format: FileTranscriptionFormat) -> PathBuf {
    let mut output = source_path.as_os_str().to_os_string();
    output.push(format!(".{}", transcript_extension(format)));
    PathBuf::from(output)
}

/// `file:queue-update` payload.
#[derive(Clone, Debug, Serialize)]
struct FileQueueUpdate {
    items: Vec<QueueItemDto>,
}

/// `file:queue-progress` payload.
#[derive(Clone, Debug, Serialize)]
struct FileQueueProgress {
    id: String,
    progress: f32,
    stage: String,
}

/// `file:queue-active` payload.
#[derive(Clone, Debug, Serialize)]
struct FileQueueActive {
    active: bool,
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis())
}
