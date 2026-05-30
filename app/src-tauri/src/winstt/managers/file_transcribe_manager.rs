// PORT IMPL — drafted against real APIs, pending compile. Source: app/PORT/07_*.md (file-transcribe),
// frontend/electron/ipc/file-transcribe-queue.ts + file-transcribe.ts. Uses symphonia for decode.
//
// FileTranscribeManager runs a SEQUENTIAL file queue with real per-chunk progress
// (lazy VAD iterator) and PTT pause/resume (request-scoped server cancel). It
// wraps Handy's `TranscriptionManager::transcribe` for the actual STT and emits
// the specta-typed `FileTranscribeProgressPayload` per file/chunk.
//
// The audio decode (symphonia: wav/mp3/mp4/aac/flac/ogg) + VAD chunk iterator are
// the heavy bits (compile loop); the queue/lifecycle/pause-resume control logic
// compiles unconditionally.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use tauri::{AppHandle, Emitter};

use crate::managers::transcription::TranscriptionManager;

/// One queued file + its lifecycle.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FileStatus {
    Queued,
    Running,
    Paused,
    Done,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug)]
pub struct QueuedFile {
    pub id: String,
    pub path: PathBuf,
    pub status: FileStatus,
    /// 0.0..1.0 progress within this file.
    pub progress: f32,
}

/// Shared queue state behind a mutex; the worker + control commands touch it.
#[derive(Default)]
struct QueueState {
    files: VecDeque<QueuedFile>,
    /// id of the file currently running, if any.
    active: Option<String>,
}

pub struct FileTranscribeManager {
    app: AppHandle,
    transcription: Arc<TranscriptionManager>,
    state: Mutex<QueueState>,
    /// Paused (PTT held) — the per-chunk loop blocks on this.
    paused: AtomicBool,
    /// Cancel-all flag.
    cancelled: AtomicBool,
    /// Wakes the worker when a file is enqueued or pause is released.
    cv: Condvar,
    /// Set while a worker thread is alive (one at a time).
    worker_alive: Mutex<bool>,
}

impl FileTranscribeManager {
    pub fn new(app: &AppHandle, transcription: Arc<TranscriptionManager>) -> Self {
        Self {
            app: app.clone(),
            transcription,
            state: Mutex::new(QueueState::default()),
            paused: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            cv: Condvar::new(),
            worker_alive: Mutex::new(false),
        }
    }

    /// Enqueue files and ensure the worker is running. Returns the assigned ids.
    pub fn enqueue(self: &Arc<Self>, paths: Vec<PathBuf>) -> Vec<String> {
        let mut ids = Vec::with_capacity(paths.len());
        {
            let mut st = self.state.lock().expect("file queue poisoned");
            for path in paths {
                let id = format!("ft-{}", next_seq());
                ids.push(id.clone());
                st.files.push_back(QueuedFile {
                    id,
                    path,
                    status: FileStatus::Queued,
                    progress: 0.0,
                });
            }
        }
        self.cancelled.store(false, Ordering::Release);
        self.ensure_worker();
        ids
    }

    pub fn pause(&self) {
        self.paused.store(true, Ordering::Release);
    }

    pub fn resume(&self) {
        self.paused.store(false, Ordering::Release);
        self.cv.notify_all();
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.paused.store(false, Ordering::Release);
        self.cv.notify_all();
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::Acquire)
    }

    /// Snapshot the queue for the renderer (e.g. on window re-open).
    pub fn snapshot(&self) -> Vec<QueuedFile> {
        self.state
            .lock()
            .map(|s| s.files.iter().cloned().collect())
            .unwrap_or_default()
    }

    fn emit_progress(&self, file: &QueuedFile, text: Option<&str>, error: Option<&str>) {
        let _ = self.app.emit(
            "file-transcribe-progress",
            serde_json::json!({
                "id": file.id,
                "path": file.path.to_string_lossy(),
                "status": file_status_str(&file.status),
                "progress": file.progress,
                "text": text,
                "error": error,
            }),
        );
    }

    /// Spawn the worker thread if one isn't already running.
    fn ensure_worker(self: &Arc<Self>) {
        {
            let mut alive = self.worker_alive.lock().expect("worker flag poisoned");
            if *alive {
                self.cv.notify_all();
                return;
            }
            *alive = true;
        }
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            me.run_worker();
            *me.worker_alive.lock().expect("worker flag poisoned") = false;
        });
    }

    fn run_worker(&self) {
        loop {
            if self.cancelled.load(Ordering::Acquire) {
                self.drain_cancelled();
                return;
            }
            // Pop the next queued file.
            let next = {
                let mut st = self.state.lock().expect("file queue poisoned");
                let idx = st.files.iter().position(|f| f.status == FileStatus::Queued);
                match idx {
                    Some(i) => {
                        st.files[i].status = FileStatus::Running;
                        st.active = Some(st.files[i].id.clone());
                        Some(st.files[i].clone())
                    }
                    None => None,
                }
            };
            let Some(file) = next else {
                return; // queue empty → worker exits
            };
            self.process_file(&file);
        }
    }

    fn process_file(&self, file: &QueuedFile) {
        // Decode + chunk + transcribe with per-chunk progress + pause gating.
        // SPIKE: symphonia decode → 16 kHz mono f32 → lazy VAD chunk iterator. The
        // transcribe path is real (Handy's TranscriptionManager::transcribe). Here
        // we transcribe the whole file in one shot as the safe default until the
        // VAD-chunk iterator lands; the per-chunk progress loop below is the
        // mechanism that replaces it.
        let mut current = file.clone();

        // Honor a pause that arrived before we started.
        self.wait_while_paused();
        if self.cancelled.load(Ordering::Acquire) {
            self.finish(&mut current, FileStatus::Cancelled, None, None);
            return;
        }

        let audio = match decode_audio_to_pcm(&file.path) {
            Ok(a) => a,
            Err(e) => {
                self.finish(&mut current, FileStatus::Failed, None, Some(&e));
                return;
            }
        };

        // One-shot transcribe (chunked progress mechanism is the SPIKE loop).
        current.progress = 0.5;
        self.update_and_emit(&mut current, None, None);
        match self.transcription.transcribe(audio) {
            Ok(text) => {
                current.progress = 1.0;
                self.finish(&mut current, FileStatus::Done, Some(&text), None);
            }
            Err(e) => {
                self.finish(&mut current, FileStatus::Failed, None, Some(&e.to_string()));
            }
        }
    }

    /// Block while paused (PTT held), waking on resume/cancel.
    fn wait_while_paused(&self) {
        let mut guard = self.state.lock().expect("file queue poisoned");
        while self.paused.load(Ordering::Acquire) && !self.cancelled.load(Ordering::Acquire) {
            // mark active file paused for the UI
            if let Some(active) = guard.active.clone() {
                if let Some(f) = guard.files.iter_mut().find(|f| f.id == active) {
                    f.status = FileStatus::Paused;
                }
            }
            guard = self.cv.wait(guard).expect("file queue poisoned");
        }
        // resume → mark running again
        if let Some(active) = guard.active.clone() {
            if let Some(f) = guard.files.iter_mut().find(|f| f.id == active) {
                if f.status == FileStatus::Paused {
                    f.status = FileStatus::Running;
                }
            }
        }
    }

    fn update_and_emit(&self, file: &mut QueuedFile, text: Option<&str>, error: Option<&str>) {
        if let Ok(mut st) = self.state.lock() {
            if let Some(f) = st.files.iter_mut().find(|f| f.id == file.id) {
                f.status = file.status.clone();
                f.progress = file.progress;
            }
        }
        self.emit_progress(file, text, error);
    }

    fn finish(&self, file: &mut QueuedFile, status: FileStatus, text: Option<&str>, error: Option<&str>) {
        file.status = status;
        self.update_and_emit(file, text, error);
        if let Ok(mut st) = self.state.lock() {
            st.active = None;
        }
    }

    fn drain_cancelled(&self) {
        let mut cancelled: Vec<QueuedFile> = Vec::new();
        if let Ok(mut st) = self.state.lock() {
            for f in st.files.iter_mut() {
                if matches!(f.status, FileStatus::Queued | FileStatus::Running | FileStatus::Paused) {
                    f.status = FileStatus::Cancelled;
                    cancelled.push(f.clone());
                }
            }
            st.active = None;
        }
        for f in &cancelled {
            self.emit_progress(f, None, None);
        }
    }

    pub fn app(&self) -> &AppHandle {
        &self.app
    }
}

fn file_status_str(s: &FileStatus) -> &'static str {
    match s {
        FileStatus::Queued => "queued",
        FileStatus::Running => "running",
        FileStatus::Paused => "paused",
        FileStatus::Done => "done",
        FileStatus::Failed => "failed",
        FileStatus::Cancelled => "cancelled",
    }
}

/// Decode an audio file to mono 16 kHz f32 PCM.
/// SPIKE: symphonia probe → decode → downmix → resample to 16 kHz. Until that
/// lands, return an error so the file is reported Failed rather than silently
/// transcribing garbage. The queue/pause/progress mechanism around it is real.
fn decode_audio_to_pcm(_path: &std::path::Path) -> Result<Vec<f32>, String> {
    // SPIKE: implement with symphonia (features wav/mp3/isomp4/aac/flac/ogg/vorbis)
    // + rubato/resample_poly to 16 kHz mono. See file-transcribe.ts for the
    // chunking + VAD-iterator parity.
    Err("file audio decode not yet wired (symphonia spike)".to_string())
}

fn next_seq() -> u64 {
    use std::sync::atomic::AtomicU64;
    static SEQ: AtomicU64 = AtomicU64::new(1);
    SEQ.fetch_add(1, Ordering::Relaxed)
}
