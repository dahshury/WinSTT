//! Supervised STT process, modeled on Handy's native-worker boundary.
//!
//! Audio conditioning, model resolution, dictionaries, and UI events stay in the app.
//! Native STT sessions and their carried streaming state live only in the worker.
//! Pipe I/O runs off-thread so even a worker that stops reading has a bounded deadline.
mod protocol;
mod replay;
mod worker;

use std::io::{self, BufReader, BufWriter, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak, mpsc};
use std::time::{Duration, Instant};

use super::{
    Accelerator, EngineConfig, EngineKind, NativeStreamUpdate, SttError, SttResult,
    TranscribeOptions, Transcriber, Transcription,
};
use protocol::{LoadedInfo, Request, Response};

const WORKER_FLAG: &str = "--winstt-inference-worker";
const LOAD_TIMEOUT: Duration = Duration::from_secs(180);
const HELLO_TIMEOUT: Duration = Duration::from_secs(30);
const REPLAY_TIMEOUT: Duration = Duration::from_secs(180);
static CANCEL_EPOCH: AtomicU64 = AtomicU64::new(0);
static PROCESSES: OnceLock<Mutex<Vec<Weak<ProcessControl>>>> = OnceLock::new();

pub fn is_worker_invocation() -> bool {
    let mut args = std::env::args_os().skip(1);
    args.next().is_some_and(|arg| arg == WORKER_FLAG) && args.next().is_none()
}

pub fn run_worker() -> i32 {
    // The larger stack is also required by some native decoder implementations.
    match std::thread::Builder::new()
        .name("stt-worker".into())
        .stack_size(64 * 1024 * 1024)
        .spawn(worker::run)
    {
        Ok(thread) => thread.join().unwrap_or(2),
        Err(_) => 1,
    }
}

/// Cancellation never waits for the engine mutex or a native call to return.
pub fn cancel_active() {
    CANCEL_EPOCH.fetch_add(1, Ordering::SeqCst);
    if let Some(processes) = PROCESSES.get() {
        let mut processes = processes.lock().unwrap_or_else(|e| e.into_inner());
        processes.retain(|weak| {
            if let Some(process) = weak.upgrade() {
                if process.busy.load(Ordering::SeqCst) {
                    process.cancelled.store(true, Ordering::SeqCst);
                    process.kill();
                }
                true
            } else {
                false
            }
        });
    }
}

struct ProcessControl {
    child: Mutex<Option<Child>>,
    busy: AtomicBool,
    cancelled: AtomicBool,
}

impl ProcessControl {
    fn kill(&self) {
        let mut child = self.child.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(child) = child.as_mut() {
            let _ = child.kill();
        }
        // Reap asynchronously: process teardown must not block an overlay cancel/quit.
    }
}

impl Drop for ProcessControl {
    fn drop(&mut self) {
        let Some(mut child) = self
            .child
            .get_mut()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        else {
            return;
        };
        let _ = child.kill();
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        // A killed process normally exits immediately. Transfer its handle to a reaper
        // instead of waiting on the UI/inference thread (including on Unix).
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
}

enum Failure {
    Transport(String),
    Cancelled,
    Engine(SttError),
}

impl Failure {
    fn into_stt(self) -> SttError {
        match self {
            Self::Transport(message) => {
                SttError::Inference(format!("native inference worker: {message}"))
            }
            Self::Cancelled => SttError::Inference("native inference cancelled".into()),
            Self::Engine(error) => error,
        }
    }
}

impl From<io::Error> for Failure {
    fn from(error: io::Error) -> Self {
        Self::Transport(format!("stream replay: {error}"))
    }
}

struct Session {
    process: Arc<ProcessControl>,
    writes: mpsc::SyncSender<Vec<u8>>,
    replies: mpsc::Receiver<io::Result<Response>>,
}

impl Session {
    fn spawn() -> Result<Self, Failure> {
        let executable = worker_executable().map_err(|e| Failure::Transport(e.to_string()))?;
        let mut command = Command::new(executable);
        command
            .arg(WORKER_FLAG)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = command
            .spawn()
            .map_err(|e| Failure::Transport(format!("spawn: {e}")))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| Failure::Transport("missing worker stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Failure::Transport("missing worker stdout".into()))?;
        let process = Arc::new(ProcessControl {
            child: Mutex::new(Some(child)),
            busy: AtomicBool::new(true),
            cancelled: AtomicBool::new(false),
        });
        {
            let mut processes = PROCESSES
                .get_or_init(Default::default)
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            processes.retain(|process| process.strong_count() != 0);
            processes.push(Arc::downgrade(&process));
        }
        let (writes, incoming) = mpsc::sync_channel::<Vec<u8>>(1);
        let (responses, replies) = mpsc::sync_channel(1);
        let write_errors = responses.clone();
        std::thread::Builder::new()
            .name("stt-pipe-write".into())
            .spawn(move || {
                let mut writer = BufWriter::new(stdin);
                while let Ok(bytes) = incoming.recv() {
                    if let Err(error) = writer.write_all(&bytes).and_then(|()| writer.flush()) {
                        let _ = write_errors.send(Err(error));
                        break;
                    }
                }
            })
            .map_err(|e| Failure::Transport(e.to_string()))?;
        std::thread::Builder::new()
            .name("stt-pipe-read".into())
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                loop {
                    let response =
                        protocol::read::<Response>(&mut reader).and_then(|(response, pcm)| {
                            if pcm.is_empty() {
                                Ok(response)
                            } else {
                                Err(io::Error::new(
                                    io::ErrorKind::InvalidData,
                                    "worker sent unexpected audio",
                                ))
                            }
                        });
                    let failed = response.is_err();
                    if responses.send(response).is_err() || failed {
                        break;
                    }
                }
            })
            .map_err(|e| Failure::Transport(e.to_string()))?;
        let session = Self {
            process,
            writes,
            replies,
        };
        match session.receive(HELLO_TIMEOUT)? {
            Response::Hello(protocol::VERSION) => Ok(session),
            _ => Err(Failure::Transport(
                "worker protocol version mismatch".into(),
            )),
        }
    }

    fn receive(&self, timeout: Duration) -> Result<Response, Failure> {
        let response = self.replies.recv_timeout(timeout);
        if self.process.cancelled.load(Ordering::SeqCst) {
            return Err(Failure::Cancelled);
        }
        match response {
            Ok(Ok(Response::Error(error))) => Err(Failure::Engine(error.into())),
            Ok(Ok(response)) => Ok(response),
            Ok(Err(error)) => Err(Failure::Transport(error.to_string())),
            Err(error) => Err(Failure::Transport(format!(
                "response deadline/disconnect: {error}"
            ))),
        }
    }

    fn call(
        &self,
        request: &Request,
        pcm: &[f32],
        timeout: Duration,
        epoch: u64,
    ) -> Result<Response, Failure> {
        self.process.busy.store(true, Ordering::SeqCst);
        let result = (|| {
            if CANCEL_EPOCH.load(Ordering::SeqCst) != epoch
                || self.process.cancelled.load(Ordering::SeqCst)
            {
                return Err(Failure::Cancelled);
            }
            let bytes = protocol::encode(request, pcm)
                .map_err(|e| Failure::Engine(SttError::Inference(e.to_string())))?;
            self.writes
                .try_send(bytes)
                .map_err(|e| Failure::Transport(format!("write queue: {e}")))?;
            let response = self.receive(timeout)?;
            if CANCEL_EPOCH.load(Ordering::SeqCst) != epoch {
                return Err(Failure::Cancelled);
            }
            Ok(response)
        })();
        self.process.busy.store(false, Ordering::SeqCst);
        result
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.process.kill();
    }
}

fn worker_executable() -> io::Result<PathBuf> {
    let current = std::env::current_exe()?;
    let name = current
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let harness_directory = current
        .parent()
        .and_then(|path| path.file_name())
        .is_some_and(|directory| directory == "deps" || directory == "examples");
    if name.eq_ignore_ascii_case("winstt") || !harness_directory {
        // Installed and portable applications may be renamed by their owner.
        return Ok(current);
    }
    // Test harnesses and standalone examples live under deps/ or examples/. They
    // must launch the application entry point, never recursively launch themselves.
    let directory = current
        .parent()
        .and_then(|path| path.parent())
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "cannot locate inference worker"))?;
    let candidate = directory.join(if cfg!(windows) {
        "winstt.exe"
    } else {
        "winstt"
    });
    if candidate.is_file() {
        Ok(candidate)
    } else {
        Err(io::Error::new(
            io::ErrorKind::NotFound,
            "build the winstt application binary before using isolated inference",
        ))
    }
}

struct RemoteTranscriber {
    config: EngineConfig,
    session: Option<Session>,
    info: LoadedInfo,
    replay: replay::ReplayLog,
    stream_failed: bool,
}

pub fn load(config: EngineConfig) -> SttResult<Box<dyn Transcriber>> {
    let mut engine = RemoteTranscriber {
        config,
        session: None,
        info: LoadedInfo {
            providers: vec![],
            word_timestamps: false,
            native_streaming: false,
        },
        replay: replay::ReplayLog::default(),
        stream_failed: false,
    };
    let epoch = CANCEL_EPOCH.load(Ordering::SeqCst);
    if let Err(failure) = engine.start(epoch) {
        engine.recover(failure, epoch).map_err(Failure::into_stt)?;
    }
    Ok(Box::new(engine))
}

impl RemoteTranscriber {
    fn start(&mut self, epoch: u64) -> Result<(), Failure> {
        if CANCEL_EPOCH.load(Ordering::SeqCst) != epoch {
            return Err(Failure::Cancelled);
        }
        let session = Session::spawn()?;
        let response = session.call(
            &Request::Load(self.config.clone()),
            &[],
            LOAD_TIMEOUT,
            epoch,
        )?;
        let Response::Loaded(info) = response else {
            return Err(Failure::Transport("unexpected load reply".into()));
        };
        self.info = info;
        self.session = Some(session);
        Ok(())
    }

    fn recover(&mut self, failure: Failure, epoch: u64) -> Result<(), Failure> {
        self.session.take();
        if CANCEL_EPOCH.load(Ordering::SeqCst) != epoch {
            return Err(Failure::Cancelled);
        }
        match failure {
            Failure::Transport(message)
                if self
                    .config
                    .providers
                    .iter()
                    .any(|provider| *provider != Accelerator::Cpu) =>
            {
                log::warn!("[stt-worker] native GPU worker failed; retrying on CPU: {message}");
                self.config.providers = vec![Accelerator::Cpu];
                self.start(epoch)
            }
            failure => Err(failure),
        }
    }

    fn timeout(&self, samples: usize) -> Duration {
        #[cfg(debug_assertions)]
        if self.config.family == "__worker_test__" {
            return Duration::from_millis(500);
        }
        let audio = samples as f64 / 16_000.0;
        let gpu = self
            .config
            .providers
            .iter()
            .any(|provider| *provider != Accelerator::Cpu);
        Duration::from_secs_f64(if gpu {
            (audio * 4.0).clamp(30.0, 300.0)
        } else {
            (audio * 20.0).clamp(60.0, 3600.0)
        })
    }

    fn call(&mut self, request: &Request, pcm: &[f32]) -> SttResult<Response> {
        let epoch = CANCEL_EPOCH.load(Ordering::SeqCst);
        if self.session.is_none() {
            self.start(epoch).map_err(Failure::into_stt)?;
        }
        let samples = if matches!(request, Request::StreamFinalize) {
            self.replay.samples()
        } else {
            pcm.len()
        };
        let timeout = self.timeout(samples);
        let result = self
            .session
            .as_ref()
            .unwrap()
            .call(request, pcm, timeout, epoch);
        match result {
            Ok(response) => Ok(response),
            Err(failure @ Failure::Engine(_)) => Err(failure.into_stt()),
            Err(failure) => {
                self.recover(failure, epoch).map_err(Failure::into_stt)?;
                // Reconstruct audio and finalizations, including the failed operation. Never
                // append it again after replay, and never retry a cancelled operation.
                if matches!(request, Request::StreamAccept | Request::StreamFinalize) {
                    let deadline = Instant::now() + REPLAY_TIMEOUT;
                    let session = self.session.as_ref().unwrap();
                    let mut update = Response::Update(NativeStreamUpdate::default());
                    let timeout = self.timeout(0);
                    let replay_result = self.replay.for_each::<Failure>(|frame| {
                        let remaining = deadline.saturating_duration_since(Instant::now());
                        if remaining.is_zero() {
                            return Err(Failure::Transport(
                                "native stream recovery deadline exceeded".into(),
                            ));
                        }
                        update = session.call(
                            &if frame.is_some() {
                                Request::StreamAccept
                            } else {
                                Request::StreamFinalize
                            },
                            frame.unwrap_or_default(),
                            remaining.min(timeout),
                            epoch,
                        )?;
                        Ok(())
                    });
                    if let Err(error) = replay_result {
                        self.session.take();
                        return Err(error.into_stt());
                    }
                    return Ok(update);
                }
                let result = self
                    .session
                    .as_ref()
                    .unwrap()
                    .call(request, pcm, timeout, epoch);
                if result.is_err() {
                    self.session.take();
                }
                result.map_err(Failure::into_stt)
            }
        }
    }
}

impl Transcriber for RemoteTranscriber {
    fn kind(&self) -> EngineKind {
        self.config.kind
    }
    fn model_name(&self) -> &str {
        &self.config.model_name
    }
    fn is_ready(&self) -> bool {
        self.session.is_some()
    }
    fn active_providers(&self) -> &[String] {
        &self.info.providers
    }
    fn supports_word_timestamps(&self) -> bool {
        self.info.word_timestamps
    }
    fn supports_native_streaming(&self) -> bool {
        self.info.native_streaming
    }
    fn transcribe(
        &mut self,
        audio: &[f32],
        options: &TranscribeOptions,
    ) -> SttResult<Transcription> {
        match self.call(&Request::Transcribe(options.clone()), audio)? {
            Response::Transcription(result) => Ok(result),
            _ => Err(SttError::Inference("unexpected transcription reply".into())),
        }
    }
    fn warmup(&mut self, audio: &[f32], options: &TranscribeOptions) -> SttResult<()> {
        match self.call(&Request::Warmup(options.clone()), audio)? {
            Response::Done => Ok(()),
            _ => Err(SttError::Inference("unexpected warmup reply".into())),
        }
    }
    fn stream_accept(&mut self, pcm: &[f32]) -> SttResult<NativeStreamUpdate> {
        if self.stream_failed {
            return Err(SttError::Inference(
                "failed native stream must be reset before feeding more audio".into(),
            ));
        }
        if !self.info.native_streaming {
            return Err(SttError::Unsupported(
                "stream_accept on a batch-only engine",
            ));
        }
        if let Err(error) = self.replay.append(pcm) {
            self.stream_failed = true;
            return Err(SttError::Inference(format!(
                "cannot preserve native stream recovery audio: {error}"
            )));
        }
        let response = self.call(&Request::StreamAccept, pcm);
        self.stream_failed = response.is_err();
        match response? {
            Response::Update(update) => Ok(update),
            _ => Err(SttError::Inference("unexpected streaming reply".into())),
        }
    }
    fn stream_finalize(&mut self) -> SttResult<String> {
        if self.stream_failed {
            return Err(SttError::Inference(
                "cannot finalize a failed native stream".into(),
            ));
        }
        if let Err(error) = self.replay.append_finalize() {
            self.stream_failed = true;
            return Err(SttError::Inference(format!(
                "cannot preserve native stream finalization: {error}"
            )));
        }
        let response = self.call(&Request::StreamFinalize, &[]);
        self.stream_failed = response.is_err();
        match response? {
            Response::Text(text) => Ok(text),
            _ => Err(SttError::Inference("unexpected finalization reply".into())),
        }
    }
    fn stream_reset(&mut self) {
        self.replay.clear();
        self.stream_failed = false;
        if let Err(error) = self.call(&Request::StreamReset, &[]) {
            log::warn!("[stt-worker] stream reset failed: {error}");
            self.session.take();
        }
    }
    fn shutdown(&mut self) {
        self.session.take();
        self.replay.clear();
    }
}
