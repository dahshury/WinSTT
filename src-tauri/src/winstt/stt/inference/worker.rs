//! Only this process creates STT sessions. EOF terminates it even during a native hang.
use std::io::{self, BufReader, BufWriter};
use std::sync::mpsc;

use super::super::{SttError, Transcriber};
use super::protocol::{self, LoadedInfo, Request, Response};

pub(super) fn run() -> i32 {
    let (sender, receiver) = mpsc::sync_channel(1);
    // Reading independently also detects a dead parent while the inference thread is stuck.
    let input = std::thread::spawn(move || {
        let mut stdin = BufReader::new(io::stdin());
        loop {
            match protocol::read::<Request>(&mut stdin) {
                Ok(request) => {
                    if sender.send(request).is_err() {
                        super::process_tree::exit();
                    }
                }
                _ => super::process_tree::exit(),
            }
        }
    });
    drop(input);
    let mut stdout = BufWriter::new(io::stdout());
    if protocol::write(&mut stdout, &Response::Hello(protocol::VERSION)).is_err() {
        return 1;
    }
    let mut engine: Option<Box<dyn Transcriber>> = None;
    while let Ok((request, pcm)) = receiver.recv() {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            match request {
                Request::Load(config) => {
                    // Do not initialize a GPU before receiving the resolved provider intent.
                    let loaded = build_engine(config)?;
                    let info = LoadedInfo {
                        providers: loaded.active_providers().to_vec(),
                        word_timestamps: loaded.supports_word_timestamps(),
                        native_streaming: loaded.supports_native_streaming(),
                    };
                    engine = Some(loaded);
                    Ok(Response::Loaded(info))
                }
                request => {
                    let engine = engine
                        .as_mut()
                        .ok_or_else(|| SttError::Inference("worker has no loaded model".into()))?;
                    match request {
                        Request::Transcribe(options) => engine
                            .transcribe(&pcm, &options)
                            .map(Response::Transcription),
                        Request::Warmup(options) => {
                            engine.warmup(&pcm, &options).map(|()| Response::Done)
                        }
                        Request::StreamAccept => engine.stream_accept(&pcm).map(Response::Update),
                        Request::StreamFinalize => engine.stream_finalize().map(Response::Text),
                        Request::StreamReset => {
                            engine.stream_reset();
                            Ok(Response::Done)
                        }
                        Request::Load(_) => unreachable!(),
                    }
                }
            }
        }));
        let response = match result {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => Response::Error(error.into()),
            // A panicking runtime may have corrupted its native state. Exit so the supervisor
            // replaces the entire process instead of attempting to reuse that state.
            Err(_) => return 2,
        };
        if protocol::write(&mut stdout, &response).is_err() {
            return 1;
        }
    }
    0
}

fn build_engine(
    config: super::super::EngineConfig,
) -> super::super::SttResult<Box<dyn Transcriber>> {
    #[cfg(debug_assertions)]
    if config.family == "__worker_test__" {
        return Ok(Box::new(test_engine::Engine::new(config)));
    }
    super::super::build_engine(config)
}

// Debug builds only: process integration tests exercise real aborts/hangs and pipes
// without downloading weights or requiring a GPU. Release workers have no fake engine.
#[cfg(debug_assertions)]
mod test_engine {
    use super::super::super::*;

    pub(super) struct Engine {
        config: EngineConfig,
        providers: Vec<String>,
        samples: Vec<f32>,
        feeds: usize,
        descendant: Option<std::process::Child>,
    }

    impl Engine {
        pub(super) fn new(config: EngineConfig) -> Self {
            let gpu = config.providers.iter().any(|p| *p != Accelerator::Cpu);
            if gpu && config.model_name == "abort-load" {
                std::process::abort();
            }
            Self {
                config,
                providers: vec![if gpu { "GPU" } else { "CPU" }.into()],
                samples: vec![],
                feeds: 0,
                descendant: None,
            }
        }

        fn fault(&self) {
            if self.config.model_name == "hang-all" {
                loop {
                    std::thread::park();
                }
            }
            if self.config.providers.iter().all(|p| *p == Accelerator::Cpu) {
                return;
            }
            match self.config.model_name.as_str() {
                "abort-decode" => std::process::abort(),
                "hang-decode" => loop {
                    std::thread::park();
                },
                "abort-stream" | "finalize-then-abort" if self.feeds == 2 => std::process::abort(),
                _ => {}
            }
        }
    }

    impl Transcriber for Engine {
        fn kind(&self) -> EngineKind {
            self.config.kind
        }
        fn model_name(&self) -> &str {
            &self.config.model_name
        }
        fn is_ready(&self) -> bool {
            true
        }
        fn active_providers(&self) -> &[String] {
            &self.providers
        }
        fn supports_word_timestamps(&self) -> bool {
            true
        }
        fn supports_native_streaming(&self) -> bool {
            true
        }
        fn transcribe(
            &mut self,
            audio: &[f32],
            options: &TranscribeOptions,
        ) -> SttResult<Transcription> {
            if self.config.model_name == "descendant" {
                if options.initial_prompt_text.as_deref() == Some("abort-parent") {
                    std::process::abort();
                }
                let mut command = std::process::Command::new(std::env::current_exe().unwrap());
                command
                    .arg("--winstt-inference-worker")
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null());
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    command.creation_flags(0x0800_0000);
                }
                let child = command.spawn().unwrap();
                let pid = child.id();
                // Keep stdin open. Only process-tree containment, not EOF or a
                // Rust destructor, can stop this child after the parent aborts.
                self.descendant = Some(child);
                return Ok(Transcription {
                    text: pid.to_string(),
                    ..Default::default()
                });
            }
            self.fault();
            if options.initial_prompt_text.as_deref() == Some("domain-error") {
                return Err(SttError::DegenerateDecode("fixture".into()));
            }
            Ok(Transcription {
                text: format!("{:?}", audio),
                segments: Some(vec![Segment {
                    speaker: None,
                    text: "segment".into(),
                    start: 1.0,
                    end: 2.0,
                }]),
                words: Some(vec![WordResult {
                    speaker: None,
                    text: "word".into(),
                    start: 1.0,
                    end: 2.0,
                }]),
            })
        }
        fn stream_accept(&mut self, pcm: &[f32]) -> SttResult<NativeStreamUpdate> {
            self.feeds += 1;
            self.samples.extend_from_slice(pcm);
            self.fault();
            Ok(NativeStreamUpdate {
                text: format!("{:?}", self.samples),
                is_final: false,
            })
        }
        fn stream_finalize(&mut self) -> SttResult<String> {
            if matches!(
                self.config.model_name.as_str(),
                "finalize-then-abort" | "abort-finalize"
            ) {
                self.samples.push(-0.5); // native finalization mutates carried decoder state
                if self.config.model_name == "abort-finalize"
                    && self.config.providers.iter().any(|p| *p != Accelerator::Cpu)
                {
                    std::process::abort();
                }
            }
            Ok(format!("{:?}", self.samples))
        }
        fn stream_reset(&mut self) {
            self.samples.clear();
            self.feeds = 0;
        }
    }
}
