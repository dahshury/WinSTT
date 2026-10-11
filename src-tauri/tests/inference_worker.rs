//! Real child-process fault tests: fake arithmetic, real transport/abort/timeout/replay.
#![cfg(debug_assertions)]
use std::sync::Mutex;
use std::time::{Duration, Instant};
use winstt_app_lib::winstt::stt::{
    Accelerator, EngineConfig, EngineKind, ResolvedModel, SttError, TranscribeOptions, inference,
};

// Cancellation is intentionally process-wide, so these cases run sequentially.
static TEST_LOCK: Mutex<()> = Mutex::new(());

fn config(name: &str) -> EngineConfig {
    EngineConfig {
        model_name: name.into(),
        family: "__worker_test__".into(),
        kind: EngineKind::WhisperHf,
        resolved: ResolvedModel::default(),
        providers: vec![Accelerator::DirectMl, Accelerator::Cpu],
        whisper_fp16_workaround: false,
        language: None,
    }
}

#[test]
fn gpu_load_abort_falls_back_before_the_app_sees_a_model() {
    let _guard = TEST_LOCK.lock().unwrap();
    let engine = inference::load(config("abort-load")).unwrap();
    assert_eq!(engine.active_providers(), ["CPU"]);
    assert!(engine.supports_native_streaming());
}

#[test]
fn native_abort_preserves_batch_results_and_timestamps_on_cpu_retry() {
    let _guard = TEST_LOCK.lock().unwrap();
    let mut engine = inference::load(config("abort-decode")).unwrap();
    let result = engine
        .transcribe(&[0.25, 0.5], &TranscribeOptions::default())
        .unwrap();
    assert_eq!(result.text, "[0.25, 0.5]");
    assert_eq!(result.words.unwrap()[0].start, 1.0);
    assert_eq!(result.segments.unwrap()[0].end, 2.0);
    assert_eq!(engine.active_providers(), ["CPU"]);
}

#[test]
fn hung_gpu_worker_is_killed_and_retried() {
    let _guard = TEST_LOCK.lock().unwrap();
    let mut engine = inference::load(config("hang-decode")).unwrap();
    let started = Instant::now();
    let result = engine
        .transcribe(&[0.5], &TranscribeOptions::default())
        .unwrap();
    assert_eq!(result.text, "[0.5]");
    assert!(started.elapsed() < Duration::from_secs(10));
    assert_eq!(engine.active_providers(), ["CPU"]);
}

#[test]
fn streaming_recovery_replays_frames_once_and_reset_clears_them() {
    let _guard = TEST_LOCK.lock().unwrap();
    let mut engine = inference::load(config("abort-stream")).unwrap();
    assert_eq!(engine.stream_accept(&[0.25]).unwrap().text, "[0.25]");
    assert_eq!(engine.stream_accept(&[0.5]).unwrap().text, "[0.25, 0.5]");
    assert_eq!(engine.stream_finalize().unwrap(), "[0.25, 0.5]");
    engine.stream_reset();
    assert_eq!(engine.stream_accept(&[0.75]).unwrap().text, "[0.75]");
    assert_eq!(engine.stream_finalize().unwrap(), "[0.75]");
}

#[test]
fn domain_error_is_returned_without_switching_providers() {
    let _guard = TEST_LOCK.lock().unwrap();
    let mut engine = inference::load(config("healthy")).unwrap();
    let options = TranscribeOptions {
        initial_prompt_text: Some("domain-error".into()),
        ..Default::default()
    };
    assert!(matches!(
        engine.transcribe(&[0.5], &options),
        Err(SttError::DegenerateDecode(_))
    ));
    assert_eq!(engine.active_providers(), ["GPU"]);
}

#[test]
fn continuous_stream_recovery_preserves_previous_finalization() {
    let _guard = TEST_LOCK.lock().unwrap();
    let mut engine = inference::load(config("finalize-then-abort")).unwrap();
    engine.stream_accept(&[0.25]).unwrap();
    assert_eq!(engine.stream_finalize().unwrap(), "[0.25, -0.5]");
    assert_eq!(
        engine.stream_accept(&[0.75]).unwrap().text,
        "[0.25, -0.5, 0.75]"
    );
    assert_eq!(engine.active_providers(), ["CPU"]);
    assert_eq!(
        engine.stream_finalize().unwrap(),
        "[0.25, -0.5, 0.75, -0.5]"
    );
}

#[test]
fn crashed_finalization_is_replayed_once_on_cpu() {
    let _guard = TEST_LOCK.lock().unwrap();
    let mut engine = inference::load(config("abort-finalize")).unwrap();
    engine.stream_accept(&[0.25]).unwrap();
    assert_eq!(engine.stream_finalize().unwrap(), "[0.25, -0.5]");
    assert_eq!(engine.active_providers(), ["CPU"]);
    engine.stream_reset();
    assert_eq!(engine.stream_accept(&[0.75]).unwrap().text, "[0.75]");
}

#[test]
fn cancel_terminates_native_work_without_retrying_it() {
    let _guard = TEST_LOCK.lock().unwrap();
    let mut engine = inference::load(config("hang-decode")).unwrap();
    let task = std::thread::spawn(move || engine.transcribe(&[0.5], &TranscribeOptions::default()));
    // Give the child time to receive the request; the fixture remains in native work.
    std::thread::sleep(Duration::from_millis(100));
    inference::cancel_active();
    let error = task.join().unwrap().unwrap_err();
    assert!(error.to_string().contains("cancelled"), "{error}");
}

#[test]
fn cpu_hang_returns_a_bounded_error_without_a_restart_loop() {
    let _guard = TEST_LOCK.lock().unwrap();
    let mut engine = inference::load(config("hang-all")).unwrap();
    let started = Instant::now();
    assert!(
        engine
            .transcribe(&[0.5], &TranscribeOptions::default())
            .is_err()
    );
    assert!(started.elapsed() < Duration::from_secs(10));
    assert!(!engine.is_ready());
}

#[test]
fn losing_parent_pipe_terminates_even_a_hung_native_worker() {
    use std::io::{Read, Write};
    use std::process::{Command, Stdio};
    let _guard = TEST_LOCK.lock().unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_winstt"));
    command
        .arg("--winstt-inference-worker")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    struct ChildGuard(std::process::Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut child = ChildGuard(command.spawn().unwrap());
    let mut input = child.0.stdin.take().unwrap();
    let mut output = child.0.stdout.take().unwrap();
    let consume_reply = |output: &mut std::process::ChildStdout| {
        let mut header = [0u8; 8];
        output.read_exact(&mut header).unwrap();
        let count = u32::from_le_bytes(header[..4].try_into().unwrap()) as usize;
        assert!(count < 4096);
        output.read_exact(&mut vec![0; count]).unwrap();
    };
    consume_reply(&mut output); // hello
    let send = |input: &mut std::process::ChildStdin, value: serde_json::Value| {
        let bytes = serde_json::to_vec(&value).unwrap();
        input
            .write_all(&(bytes.len() as u32).to_le_bytes())
            .unwrap();
        input.write_all(&0u32.to_le_bytes()).unwrap();
        input.write_all(&bytes).unwrap();
        input.flush().unwrap();
    };
    send(&mut input, serde_json::json!({"Load": config("hang-all")}));
    consume_reply(&mut output); // native engine is loaded
    send(
        &mut input,
        serde_json::json!({"Transcribe": TranscribeOptions::default()}),
    );
    // A real native hang has no response; closing stdin must end the process independently.
    std::thread::sleep(Duration::from_millis(100));
    drop(input);
    let deadline = Instant::now() + Duration::from_secs(5);
    while child.0.try_wait().unwrap().is_none() {
        assert!(
            Instant::now() < deadline,
            "worker survived parent pipe closure"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
