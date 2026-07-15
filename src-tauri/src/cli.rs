//! Command-line entry points that run before the Tauri desktop lifecycle.
//!
//! The transcription route deliberately owns only media decoding, model resolution, and the STT
//! engine. It never constructs a Tauri app, so webviews, tray, microphone capture, clipboard/paste,
//! global shortcuts, and desktop background managers cannot start in headless mode.

use std::path::{Path, PathBuf};
use std::time::Instant;

use clap::{Parser, ValueEnum};
use serde::Serialize;

use crate::winstt::catalog::{self, ModelEntry};
use crate::winstt::stt::resolver::{self, ResolveRequest};
use crate::winstt::stt::{
    self, Accelerator, EngineConfig, EngineKind, Quantization, ResolvedModel, TranscribeOptions,
    Transcriber,
};

const DEFAULT_HEADLESS_MODEL: &str = "tiny.en";
const STT_SAMPLE_RATE: usize = 16_000;
const HEADLESS_STACK_BYTES: usize = 64 * 1024 * 1024;

#[derive(Parser, Debug, Clone)]
#[command(
    name = "winstt",
    about = "WinSTT — local-first speech-to-text",
    after_help = "HEADLESS EXAMPLES:\n  winstt --list-models\n  winstt --list-devices --json\n  winstt --transcribe-file recording.wav --model tiny.en\n  winstt --transcribe-file recording.mp3 --device directml --warm --repeat 3 --json\n  winstt --transcribe-file recording.wav --cold --repeat 3"
)]
pub struct CliArgs {
    /// Start with the main window hidden
    #[arg(long)]
    pub start_hidden: bool,

    /// Disable the system tray icon
    #[arg(long)]
    pub no_tray: bool,

    /// Toggle transcription on/off (sent to running instance)
    #[arg(long)]
    pub toggle_transcription: bool,

    /// Toggle transcription with post-processing on/off (sent to running instance)
    #[arg(long)]
    pub toggle_post_process: bool,

    /// Cancel the current operation (sent to running instance)
    #[arg(long)]
    pub cancel: bool,

    /// Enable debug mode with verbose logging
    #[arg(long)]
    pub debug: bool,

    /// Transcribe one media file without starting the desktop app
    #[arg(long, value_name = "PATH", conflicts_with_all = ["list_models", "list_devices"])]
    pub transcribe_file: Option<PathBuf>,

    /// Catalog model id for --transcribe-file (default: tiny.en)
    #[arg(long, value_name = "ID")]
    pub model: Option<String>,

    /// Execution device for --transcribe-file (default: auto)
    #[arg(long, value_enum, value_name = "DEVICE")]
    pub device: Option<HeadlessDevice>,

    /// Print the embedded local-STT model catalog without starting the desktop app
    #[arg(long, conflicts_with = "list_devices")]
    pub list_models: bool,

    /// Print execution providers compiled into this build without starting the desktop app
    #[arg(long, conflicts_with = "list_models")]
    pub list_devices: bool,

    /// Number of measured transcription passes
    #[arg(long, default_value_t = 1, value_name = "N")]
    pub repeat: usize,

    /// Emit machine-readable JSON
    #[arg(long)]
    pub json: bool,

    /// Warm provider kernels with one second of silence before measured decoding
    #[arg(long)]
    pub warm: bool,

    /// Rebuild model sessions before every repeated pass (provider/kernel-cold benchmark)
    #[arg(long)]
    pub cold: bool,
}

impl Default for CliArgs {
    fn default() -> Self {
        Self {
            start_hidden: false,
            no_tray: false,
            toggle_transcription: false,
            toggle_post_process: false,
            cancel: false,
            debug: false,
            transcribe_file: None,
            model: None,
            device: None,
            list_models: false,
            list_devices: false,
            repeat: 1,
            json: false,
            warm: false,
            cold: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, ValueEnum, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HeadlessDevice {
    Auto,
    Cpu,
    #[value(name = "directml", alias = "dml")]
    DirectMl,
    Cuda,
    #[value(name = "coreml")]
    CoreMl,
    Rocm,
    #[value(name = "openvino")]
    OpenVino,
    #[value(name = "webgpu", alias = "wgpu")]
    WebGpu,
}

impl HeadlessDevice {
    fn accelerator(self) -> Accelerator {
        match self {
            Self::Auto => {
                stt::resolve_accelerator(crate::winstt::settings_schema::DeviceType::Auto)
            }
            Self::Cpu => Accelerator::Cpu,
            Self::DirectMl => Accelerator::DirectMl,
            Self::Cuda => Accelerator::Cuda,
            Self::CoreMl => Accelerator::CoreMl,
            Self::Rocm => Accelerator::Rocm,
            Self::OpenVino => Accelerator::OpenVino,
            Self::WebGpu => Accelerator::WebGpu,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Cpu => "cpu",
            Self::DirectMl => "directml",
            Self::Cuda => "cuda",
            Self::CoreMl => "coreml",
            Self::Rocm => "rocm",
            Self::OpenVino => "openvino",
            Self::WebGpu => "webgpu",
        }
    }

    fn compiled(self) -> bool {
        match self {
            Self::Auto | Self::Cpu => true,
            Self::DirectMl => cfg!(windows),
            Self::Cuda => cfg!(feature = "cuda"),
            Self::CoreMl => cfg!(all(target_os = "macos", feature = "coreml")),
            Self::Rocm => cfg!(feature = "rocm"),
            Self::OpenVino => cfg!(feature = "openvino"),
            Self::WebGpu => cfg!(feature = "webgpu"),
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
struct CliError(String);

type CliResult<T> = Result<T, CliError>;

#[derive(Serialize)]
struct ErrorOutput<'a> {
    error: &'a str,
}

#[derive(Serialize)]
struct ModelOutput<'a> {
    id: &'a str,
    name: &'a str,
    family: &'a str,
    repository: &'a str,
    engine: String,
    parameters: u64,
    quantizations: &'a [&'a str],
}

#[derive(Serialize)]
struct DeviceOutput {
    id: &'static str,
    available: bool,
    resolved_provider: Option<&'static str>,
}

#[derive(Serialize)]
struct HeadlessReport {
    command: &'static str,
    input: String,
    model: String,
    model_name: String,
    family: String,
    engine: String,
    quantization: String,
    device_requested: String,
    device_resolved: String,
    audio_seconds: f64,
    audio_decode_ms: f64,
    model_resolve_ms: f64,
    rss_before_load_bytes: u64,
    runs: Vec<RunReport>,
    peak_rss_bytes: u64,
}

#[derive(Serialize)]
struct RunReport {
    pass: usize,
    mode: &'static str,
    load_ms: Option<f64>,
    warm_ms: Option<f64>,
    decode_ms: f64,
    rtf: f64,
    rss_after_load_bytes: Option<u64>,
    rss_after_warm_bytes: Option<u64>,
    rss_after_decode_bytes: u64,
    providers: Vec<String>,
    transcript: String,
}

struct ResolvedHeadlessModel {
    entry: &'static ModelEntry,
    kind: EngineKind,
    quantization: Quantization,
    primary: Accelerator,
    providers: Vec<Accelerator>,
    resolved: ResolvedModel,
}

/// Runs a headless action, returning its process exit code, or `None` when normal desktop startup
/// should continue. This function is called before Tauri is initialized.
pub fn run_headless(args: &CliArgs) -> Option<i32> {
    if !headless_requested(args) {
        return None;
    }

    let result = if args.list_models {
        validate_listing_args(args).and_then(|()| print_models(args.json))
    } else if args.list_devices {
        validate_listing_args(args).and_then(|()| print_devices(args.json))
    } else if args.transcribe_file.is_some() {
        validate_transcription_args(args).and_then(|()| run_transcription_worker(args.clone()))
    } else {
        Err(CliError(
            "headless options require --transcribe-file, --list-models, or --list-devices".into(),
        ))
    };

    match result {
        Ok(()) => Some(0),
        Err(error) => {
            print_error(&error, args.json);
            Some(2)
        }
    }
}

fn headless_requested(args: &CliArgs) -> bool {
    args.transcribe_file.is_some()
        || args.list_models
        || args.list_devices
        || args.model.is_some()
        || args.device.is_some()
        || args.repeat != 1
        || args.json
        || args.warm
        || args.cold
}

fn validate_listing_args(args: &CliArgs) -> CliResult<()> {
    if args.model.is_some() || args.device.is_some() || args.repeat != 1 || args.warm || args.cold {
        return Err(CliError(
            "--model, --device, --repeat, --warm, and --cold require --transcribe-file".into(),
        ));
    }
    Ok(())
}

fn validate_transcription_args(args: &CliArgs) -> CliResult<()> {
    if args.repeat == 0 {
        return Err(CliError("--repeat must be at least 1".into()));
    }
    let device = args.device.unwrap_or(HeadlessDevice::Auto);
    if !device.compiled() {
        return Err(CliError(format!(
            "device '{}' is not compiled into this WinSTT build; use --list-devices",
            device.label()
        )));
    }
    Ok(())
}

fn run_transcription_worker(args: CliArgs) -> CliResult<()> {
    let worker = std::thread::Builder::new()
        .name("winstt-headless-stt".into())
        .stack_size(HEADLESS_STACK_BYTES)
        .spawn(move || transcribe_file(&args))
        .map_err(|error| CliError(format!("failed to start headless STT worker: {error}")))?;
    worker
        .join()
        .map_err(|_| CliError("headless STT worker panicked".into()))?
}

fn transcribe_file(args: &CliArgs) -> CliResult<()> {
    let path = args
        .transcribe_file
        .as_deref()
        .ok_or_else(|| CliError("--transcribe-file requires a path".into()))?;
    if !path.is_file() {
        return Err(CliError(format!(
            "input file does not exist: {}",
            path.display()
        )));
    }

    let mut memory = ProcessMemory::new();
    let audio_started = Instant::now();
    let mut audio = crate::winstt::managers::transcode::decode_audio_to_pcm(path)
        .map_err(|error| CliError(format!("audio decode failed: {error}")))?;
    let audio_decode_ms = elapsed_ms(audio_started);
    peak_normalize(&mut audio);
    let audio_seconds = audio.len() as f64 / STT_SAMPLE_RATE as f64;

    let model_id = args.model.as_deref().unwrap_or(DEFAULT_HEADLESS_MODEL);
    let requested_device = args.device.unwrap_or(HeadlessDevice::Auto);
    let resolve_started = Instant::now();
    let resolved = resolve_headless_model(model_id, requested_device)?;
    let model_resolve_ms = elapsed_ms(resolve_started);
    let rss_before_load = memory.sample();

    let mut engine: Option<Box<dyn Transcriber>> = None;
    let mut runs = Vec::with_capacity(args.repeat);
    for pass in 1..=args.repeat {
        let needs_load = engine.is_none() || args.cold;
        if args.cold
            && let Some(mut previous) = engine.take()
        {
            previous.shutdown();
        }

        let (load_ms, rss_after_load) = if needs_load {
            let load_started = Instant::now();
            engine = Some(build_headless_engine(&resolved)?);
            let duration = elapsed_ms(load_started);
            (Some(duration), Some(memory.sample()))
        } else {
            (None, None)
        };
        let loaded = engine
            .as_mut()
            .ok_or_else(|| CliError("model engine was not initialized".into()))?;
        let providers = loaded.active_providers().to_vec();

        let (warm_ms, rss_after_warm) = if args.warm && needs_load {
            let warm_started = Instant::now();
            loaded
                .warmup(&vec![0.0; STT_SAMPLE_RATE], &TranscribeOptions::default())
                .map_err(|error| CliError(format!("model warmup failed: {error}")))?;
            (Some(elapsed_ms(warm_started)), Some(memory.sample()))
        } else {
            (None, None)
        };

        let decode_started = Instant::now();
        let transcript = decode_audio(loaded.as_mut(), resolved.kind, &audio, pass)?;
        let decode_ms = elapsed_ms(decode_started);
        let decode_seconds = decode_ms / 1000.0;
        let rtf = if audio_seconds > 0.0 {
            decode_seconds / audio_seconds
        } else {
            0.0
        };
        let rss_after_decode = memory.sample();
        let mode = if args.warm && needs_load {
            "warmed"
        } else if needs_load {
            "cold"
        } else {
            "hot"
        };
        runs.push(RunReport {
            pass,
            mode,
            load_ms,
            warm_ms,
            decode_ms,
            rtf,
            rss_after_load_bytes: rss_after_load,
            rss_after_warm_bytes: rss_after_warm,
            rss_after_decode_bytes: rss_after_decode,
            providers,
            transcript,
        });
    }

    if let Some(mut loaded) = engine {
        loaded.shutdown();
    }
    let report = HeadlessReport {
        command: "transcribe-file",
        input: path.display().to_string(),
        model: resolved.entry.id.to_string(),
        model_name: resolved.entry.display_name.to_string(),
        family: resolved.entry.family.as_str().to_string(),
        engine: format!("{:?}", resolved.kind),
        quantization: quantization_label(resolved.quantization).to_string(),
        device_requested: requested_device.label().to_string(),
        device_resolved: accelerator_label(resolved.primary).to_string(),
        audio_seconds,
        audio_decode_ms,
        model_resolve_ms,
        rss_before_load_bytes: rss_before_load,
        runs,
        peak_rss_bytes: memory.peak(),
    };
    print_report(&report, args.json)
}

fn resolve_headless_model(
    model_id: &str,
    requested_device: HeadlessDevice,
) -> CliResult<ResolvedHeadlessModel> {
    let canonical = catalog::canonical_model_id(model_id);
    let entry = catalog::find(canonical)
        .ok_or_else(|| CliError(format!("model '{model_id}' is not in the WinSTT catalog")))?;
    let kind =
        stt::cache_probe::engine_kind_for(entry.id, entry.family.as_str(), entry.onnx_model_name);
    let primary = requested_device.accelerator();
    let available: Vec<Quantization> = entry
        .available_quantizations
        .iter()
        .filter_map(|value| Quantization::parse(value))
        .collect();
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    let quantization = stt::fit_aware_auto_quant(
        &available,
        kind,
        primary,
        entry.param_count,
        system.available_memory(),
        crate::winstt::commands::runtime::detected_max_vram_bytes(),
    );
    let mut providers = stt::override_dml_to_cpu_for_kind(
        stt::providers_for_accelerator(primary),
        kind,
        quantization,
    );
    if kind == EngineKind::WhisperHf
        && providers.first() == Some(&Accelerator::DirectMl)
        && stt::whisper::directml_degenerate_model_blocked(entry.id)
    {
        providers = vec![Accelerator::Cpu];
    }

    let runtime = tokio::runtime::Runtime::new()
        .map_err(|error| CliError(format!("failed to create model resolver runtime: {error}")))?;
    let mut request = ResolveRequest {
        model_id: entry.onnx_model_name.to_string(),
        kind,
        effective_quant: quantization,
        local_dir: None,
        local_files_only: true,
    };
    let resolved = match runtime.block_on(resolver::resolve(&request)) {
        Ok(resolved) => resolved,
        Err(cache_error) => {
            request.local_files_only = false;
            runtime
                .block_on(resolver::resolve(&request))
                .map_err(|error| {
                    CliError(format!(
                        "model resolve/download failed (cache: {cache_error}; network: {error})"
                    ))
                })?
        }
    };
    if kind == EngineKind::CohereAsr
        && primary == Accelerator::DirectMl
        && providers.first() == Some(&Accelerator::Cpu)
        && stt::cohere_export_dml_safe(&resolved)
    {
        providers = stt::providers_for_accelerator(primary);
    }

    Ok(ResolvedHeadlessModel {
        entry,
        kind,
        quantization,
        primary,
        providers,
        resolved,
    })
}

fn build_headless_engine(model: &ResolvedHeadlessModel) -> CliResult<Box<dyn Transcriber>> {
    let config = EngineConfig {
        model_name: model.entry.id.to_string(),
        family: model.entry.family.as_str().to_string(),
        kind: model.kind,
        resolved: model.resolved.clone(),
        providers: model.providers.clone(),
        whisper_fp16_workaround: model.entry.family == catalog::Family::Whisper
            && model.quantization == Quantization::Fp16,
        language: None,
    };
    stt::build_engine(config).map_err(|error| CliError(format!("model load failed: {error}")))
}

fn decode_audio(
    engine: &mut dyn Transcriber,
    kind: EngineKind,
    audio: &[f32],
    pass: usize,
) -> CliResult<String> {
    let options = TranscribeOptions::default();
    let duration = audio.len() as f32 / STT_SAMPLE_RATE as f32;
    if duration <= kind.max_chunk_seconds() {
        return engine
            .transcribe(audio, &options)
            .map(|result| result.text)
            .map_err(|error| CliError(format!("transcription failed: {error}")));
    }

    let vad_path = segmentation_vad_path().ok_or_else(|| {
        CliError("long-form transcription requires resources/models/silero_vad_v4.onnx".into())
    })?;
    let mut vad = crate::audio_toolkit::vad::SileroVad::new(
        &vad_path,
        crate::audio_toolkit::vad::VAD_SPEECH_THRESHOLD,
    )
    .map_err(|error| CliError(format!("segmentation VAD load failed: {error}")))?;
    stt::vad_segment::vad_segment_decode(
        engine,
        audio,
        kind.max_chunk_seconds(),
        kind.needs_past_context(),
        &mut vad,
        &options,
        &format!("headless-{pass}"),
    )
    .map_err(|error| CliError(format!("long-form transcription failed: {error}")))
}

fn segmentation_vad_path() -> Option<PathBuf> {
    let relative = Path::new("resources/models/silero_vad_v4.onnx");
    let packaged = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|parent| parent.join(relative)));
    packaged.filter(|path| path.is_file()).or_else(|| {
        let development = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
        development.is_file().then_some(development)
    })
}

fn peak_normalize(audio: &mut [f32]) {
    let peak = audio
        .iter()
        .fold(0.0_f32, |current, sample| current.max(sample.abs()));
    if peak <= 0.0 {
        return;
    }
    let gain = 0.95 / peak;
    for sample in audio {
        *sample *= gain;
    }
}

fn print_models(json: bool) -> CliResult<()> {
    let models: Vec<ModelOutput<'_>> = catalog::STT_CATALOG
        .iter()
        .map(|entry| ModelOutput {
            id: entry.id,
            name: entry.display_name,
            family: entry.family.as_str(),
            repository: entry.onnx_model_name,
            engine: format!(
                "{:?}",
                stt::cache_probe::engine_kind_for(
                    entry.id,
                    entry.family.as_str(),
                    entry.onnx_model_name,
                )
            ),
            parameters: entry.param_count,
            quantizations: entry.available_quantizations,
        })
        .collect();
    if json {
        print_json(&models)
    } else {
        for model in models {
            println!(
                "{:<42} {:<18} {:<20} {}",
                model.id, model.family, model.engine, model.name
            );
        }
        Ok(())
    }
}

fn print_devices(json: bool) -> CliResult<()> {
    let auto = HeadlessDevice::Auto.accelerator();
    let devices = [
        DeviceOutput {
            id: "auto",
            available: true,
            resolved_provider: Some(accelerator_label(auto)),
        },
        DeviceOutput {
            id: "cpu",
            available: true,
            resolved_provider: Some(accelerator_label(Accelerator::Cpu)),
        },
        device_output(HeadlessDevice::DirectMl),
        device_output(HeadlessDevice::Cuda),
        device_output(HeadlessDevice::CoreMl),
        device_output(HeadlessDevice::Rocm),
        device_output(HeadlessDevice::OpenVino),
        device_output(HeadlessDevice::WebGpu),
    ];
    if json {
        print_json(&devices)
    } else {
        for device in devices.iter().filter(|device| device.available) {
            let resolved = device.resolved_provider.unwrap_or("unavailable");
            println!("{:<12} {resolved}", device.id);
        }
        Ok(())
    }
}

fn device_output(device: HeadlessDevice) -> DeviceOutput {
    DeviceOutput {
        id: device.label(),
        available: device.compiled(),
        resolved_provider: device
            .compiled()
            .then(|| accelerator_label(device.accelerator())),
    }
}

fn print_report(report: &HeadlessReport, json: bool) -> CliResult<()> {
    if json {
        return print_json(report);
    }
    println!(
        "model={} engine={} quant={} device={} audio={:.3}s resolve={:.2}ms decode_media={:.2}ms peak_rss={}MB",
        report.model,
        report.engine,
        report.quantization,
        report.device_resolved,
        report.audio_seconds,
        report.model_resolve_ms,
        report.audio_decode_ms,
        bytes_to_mib(report.peak_rss_bytes),
    );
    for run in &report.runs {
        println!(
            "pass={} mode={} load={} warm={} decode={:.2}ms rtf={:.4} rss={}MB providers={}",
            run.pass,
            run.mode,
            optional_ms(run.load_ms),
            optional_ms(run.warm_ms),
            run.decode_ms,
            run.rtf,
            bytes_to_mib(run.rss_after_decode_bytes),
            run.providers.join(","),
        );
        println!("{}", run.transcript);
    }
    Ok(())
}

fn print_json<T: Serialize + ?Sized>(value: &T) -> CliResult<()> {
    let output = serde_json::to_string_pretty(value)
        .map_err(|error| CliError(format!("failed to serialize JSON output: {error}")))?;
    println!("{output}");
    Ok(())
}

fn print_error(error: &CliError, json: bool) {
    if json {
        match serde_json::to_string(&ErrorOutput { error: &error.0 }) {
            Ok(output) => eprintln!("{output}"),
            Err(_) => eprintln!("{}", error.0),
        }
    } else {
        eprintln!("error: {error}");
    }
}

fn elapsed_ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

fn optional_ms(value: Option<f64>) -> String {
    value.map_or_else(|| "-".into(), |ms| format!("{ms:.2}ms"))
}

fn bytes_to_mib(bytes: u64) -> u64 {
    bytes / (1024 * 1024)
}

fn quantization_label(quantization: Quantization) -> &'static str {
    match quantization {
        Quantization::Default => "fp32",
        other => other.suffix(),
    }
}

fn accelerator_label(accelerator: Accelerator) -> &'static str {
    match accelerator {
        Accelerator::Cpu => "cpu",
        Accelerator::Cuda => "cuda",
        Accelerator::DirectMl => "directml",
        Accelerator::CoreMl => "coreml",
        Accelerator::Rocm => "rocm",
        Accelerator::OpenVino => "openvino",
        Accelerator::WebGpu => "webgpu",
    }
}

struct ProcessMemory {
    system: sysinfo::System,
    peak_sampled: u64,
}

impl ProcessMemory {
    fn new() -> Self {
        Self {
            system: sysinfo::System::new(),
            peak_sampled: 0,
        }
    }

    fn sample(&mut self) -> u64 {
        let current = sysinfo::get_current_pid().map_or(0, |pid| {
            let pids = [pid];
            self.system
                .refresh_processes(sysinfo::ProcessesToUpdate::Some(&pids), false);
            self.system.process(pid).map_or(0, sysinfo::Process::memory)
        });
        self.peak_sampled = self.peak_sampled.max(current);
        current
    }

    fn peak(&self) -> u64 {
        platform_peak_working_set().max(self.peak_sampled)
    }
}

#[cfg(windows)]
fn platform_peak_working_set() -> u64 {
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::GetCurrentProcess;

    let mut counters = PROCESS_MEMORY_COUNTERS {
        cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        ..Default::default()
    };
    // SAFETY: GetCurrentProcess returns a valid pseudo-handle for this process and `counters`
    // points to a correctly sized writable PROCESS_MEMORY_COUNTERS value for the duration of call.
    unsafe {
        GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb)
            .map_or(0, |()| counters.PeakWorkingSetSize as u64)
    }
}

#[cfg(not(windows))]
fn platform_peak_working_set() -> u64 {
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_arguments_do_not_select_headless_mode() {
        let args = CliArgs::try_parse_from(["winstt", "--start-hidden"]).expect("parse args");

        assert!(!headless_requested(&args));
    }

    #[test]
    fn transcribe_arguments_parse_all_benchmark_controls() {
        let args = CliArgs::try_parse_from([
            "winstt",
            "--transcribe-file",
            "sample.wav",
            "--model",
            "tiny.en",
            "--device",
            "directml",
            "--repeat",
            "3",
            "--warm",
            "--cold",
            "--json",
        ])
        .expect("parse args");

        assert_eq!(args.transcribe_file, Some(PathBuf::from("sample.wav")));
        assert_eq!(args.model.as_deref(), Some("tiny.en"));
        assert_eq!(args.device, Some(HeadlessDevice::DirectMl));
        assert_eq!(args.repeat, 3);
        assert!(args.warm && args.cold && args.json);
    }

    #[test]
    fn repeat_zero_is_rejected_before_runtime_initialization() {
        let args =
            CliArgs::try_parse_from(["winstt", "--transcribe-file", "sample.wav", "--repeat", "0"])
                .expect("parse args");

        assert!(validate_transcription_args(&args).is_err());
    }

    #[test]
    fn peak_normalize_scales_loudest_sample_to_point_nine_five() {
        let mut audio = [0.25_f32, -0.5, 0.1];

        peak_normalize(&mut audio);

        assert!((audio[1] + 0.95).abs() < f32::EPSILON);
    }

    #[test]
    fn list_models_rejects_transcription_only_switches() {
        let args =
            CliArgs::try_parse_from(["winstt", "--list-models", "--warm"]).expect("parse args");

        assert!(validate_listing_args(&args).is_err());
    }
}
