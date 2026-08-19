//! Headless Windows LE Audio transition probe.
//!
//! Reproduces WinSTT's on-demand lifecycle against the real default microphone
//! and render endpoints while timestamping every 16 kHz frame delivered by the
//! production `AudioRecorder`. Two orders are compared:
//!
//! - `capture-first`: start Communications capture, then create the matching
//!   renderer (WinSTT's on-demand ordering).
//! - `render-first`: create a silent Communications renderer, start capture,
//!   wait for stable frames, then write the tone through that existing renderer
//!   as a reference ordering.
//!
//! Run from `src-tauri`:
//! `cargo run --example le_audio_transition_probe -- both 3`

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("le_audio_transition_probe is Windows-only");
}

#[cfg(target_os = "windows")]
mod windows_probe {
    use std::{
        collections::VecDeque,
        error::Error,
        f32::consts::TAU,
        mem::size_of,
        sync::{
            Arc, Mutex,
            atomic::{AtomicU8, Ordering},
        },
        thread,
        time::{Duration, Instant},
    };

    use cpal::traits::{DeviceTrait, HostTrait};
    use wasapi::{
        AudioClient, AudioClientProperties, AudioRenderClient, Direction, SampleType,
        StreamCategory, StreamMode, WaveFormat,
    };
    use winstt_app_lib::audio_toolkit::AudioRecorder;

    type ProbeResult<T> = Result<T, Box<dyn Error>>;

    const BASELINE: Duration = Duration::from_millis(450);
    const TONE_DURATION: Duration = Duration::from_millis(350);
    const AFTER_TONE: Duration = Duration::from_millis(350);

    #[derive(Clone, Copy, Debug)]
    enum Order {
        CaptureFirst,
        RenderFirst,
    }

    impl Order {
        fn label(self) -> &'static str {
            match self {
                Self::CaptureFirst => "capture-first",
                Self::RenderFirst => "render-first",
            }
        }
    }

    struct CommunicationsOutput {
        audio_client: AudioClient,
        render_client: AudioRenderClient,
        sample_rate: u32,
        channels: u16,
        phase: f32,
    }

    impl CommunicationsOutput {
        fn open() -> ProbeResult<Self> {
            let enumerator = wasapi::DeviceEnumerator::new()?;
            let device = enumerator.get_default_device(&Direction::Render)?;
            let device_name = device.get_friendlyname()?;
            let mut audio_client = device.get_iaudioclient()?;
            audio_client.set_properties(
                AudioClientProperties::new().set_category(StreamCategory::Communications),
            )?;

            let mix = audio_client.get_mixformat()?;
            let sample_rate = mix.get_samplespersec();
            let channels = mix.get_nchannels();
            let format = WaveFormat::new(
                32,
                32,
                &SampleType::Float,
                sample_rate as usize,
                channels as usize,
                None,
            );
            let (default_period, _) = audio_client.get_device_period()?;
            audio_client.initialize_client(
                &format,
                &Direction::Render,
                &StreamMode::PollingShared {
                    autoconvert: true,
                    buffer_duration_hns: default_period,
                },
            )?;
            audio_client
                .get_audiosessioncontrol()?
                .set_ducking_preference(true)?;
            let render_client = audio_client.get_audiorenderclient()?;
            let buffer_frames = audio_client.get_buffer_size()? as usize;
            let silence = vec![0_u8; buffer_frames * channels as usize * size_of::<f32>()];
            render_client.write_to_device(buffer_frames, &silence, None)?;
            audio_client.start_stream()?;
            println!("  render-live endpoint={device_name:?} format={sample_rate}Hz/{channels}ch");
            Ok(Self {
                audio_client,
                render_client,
                sample_rate,
                channels,
                phase: 0.0,
            })
        }

        fn play_probe_tone(&mut self, duration: Duration) -> ProbeResult<()> {
            let deadline = Instant::now() + duration;
            while Instant::now() < deadline {
                let frames = self.audio_client.get_available_space_in_frames()? as usize;
                if frames == 0 {
                    thread::sleep(Duration::from_millis(2));
                    continue;
                }
                let mut bytes =
                    Vec::with_capacity(frames * self.channels as usize * size_of::<f32>());
                for _ in 0..frames {
                    let sample = (self.phase * TAU).sin() * 0.08;
                    self.phase = (self.phase + 880.0 / self.sample_rate as f32).fract();
                    for _ in 0..self.channels {
                        bytes.extend_from_slice(&sample.to_le_bytes());
                    }
                }
                self.render_client.write_to_device(frames, &bytes, None)?;
            }
            Ok(())
        }

        fn close(self) {
            // Match the deployed implementation: do not call IAudioClient::Stop,
            // because that call has blocked in Bluetooth topology transitions.
            drop(self.render_client);
            drop(self.audio_client);
        }
    }

    #[derive(Default)]
    struct FrameTrace {
        origin: Option<Instant>,
        events: VecDeque<(u8, Duration, f32)>,
    }

    impl FrameTrace {
        fn push(&mut self, phase: u8, rms: f32) {
            let now = Instant::now();
            let origin = *self.origin.get_or_insert(now);
            self.events
                .push_back((phase, now.duration_since(origin), rms));
        }

        fn report(&self) -> ProbeResult<()> {
            let mut max_gap = Duration::ZERO;
            let mut max_gap_phase = 0;
            let mut over_75ms = 0;
            for pair in self.events.as_slices().0.windows(2) {
                let gap = pair[1].1.saturating_sub(pair[0].1);
                if gap > max_gap {
                    max_gap = gap;
                    max_gap_phase = pair[1].0;
                }
                if gap >= Duration::from_millis(75) {
                    over_75ms += 1;
                }
            }
            println!(
                "  capture-events={} max-gap-ms={:.1} gap-phase={} gaps>=75ms={}",
                self.events.len(),
                max_gap.as_secs_f64() * 1000.0,
                max_gap_phase,
                over_75ms,
            );
            for phase in 0..=3 {
                let values: Vec<f32> = self
                    .events
                    .iter()
                    .filter_map(|event| (event.0 == phase).then_some(event.2))
                    .collect();
                if values.is_empty() {
                    continue;
                }
                let zeroish = values.iter().filter(|&&rms| rms <= 1.0e-7).count();
                let mean = values.iter().copied().sum::<f32>() / values.len() as f32;
                println!(
                    "  phase={phase} frames={} mean-rms={mean:.6} exact-zeroish={zeroish}",
                    values.len()
                );
            }
            if over_75ms > 0 {
                return Err(format!(
                    "capture was interrupted: {over_75ms} callback gap(s) reached 75 ms"
                )
                .into());
            }
            Ok(())
        }
    }

    fn wait_for_frames(trace: &Arc<Mutex<FrameTrace>>, minimum: usize) -> ProbeResult<()> {
        let deadline = Instant::now() + Duration::from_secs(4);
        while Instant::now() < deadline {
            if trace.lock().unwrap().events.len() >= minimum {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(10));
        }
        Err(format!("capture delivered fewer than {minimum} frames in 4 seconds").into())
    }

    fn run_take(order: Order, take: usize) -> ProbeResult<()> {
        println!("take={take} order={}", order.label());
        let phase = Arc::new(AtomicU8::new(0));
        let trace = Arc::new(Mutex::new(FrameTrace::default()));
        let phase_cb = Arc::clone(&phase);
        let trace_cb = Arc::clone(&trace);
        let mut recorder = AudioRecorder::new().with_chunk_callback(move |frame| {
            let rms = if frame.is_empty() {
                0.0
            } else {
                (frame.iter().map(|sample| sample * sample).sum::<f32>() / frame.len() as f32)
                    .sqrt()
            };
            trace_cb
                .lock()
                .unwrap()
                .push(phase_cb.load(Ordering::Relaxed), rms);
        });

        let mut output = if matches!(order, Order::RenderFirst) {
            let started = Instant::now();
            let output = CommunicationsOutput::open()?;
            println!(
                "  render-open-ms={:.1}",
                started.elapsed().as_secs_f64() * 1000.0
            );
            Some(output)
        } else {
            None
        };

        let open_started = Instant::now();
        recorder.open(None)?;
        recorder.start()?;
        println!(
            "  capture-open-ms={:.1}",
            open_started.elapsed().as_secs_f64() * 1000.0
        );
        wait_for_frames(&trace, 8)?;
        thread::sleep(BASELINE);

        if matches!(order, Order::CaptureFirst) {
            phase.store(1, Ordering::Relaxed);
            let started = Instant::now();
            output = Some(CommunicationsOutput::open()?);
            println!(
                "  render-open-ms={:.1}",
                started.elapsed().as_secs_f64() * 1000.0
            );
        }

        phase.store(2, Ordering::Relaxed);
        let tone_started = Instant::now();
        output.as_mut().unwrap().play_probe_tone(TONE_DURATION)?;
        println!(
            "  tone-write-ms={:.1}",
            tone_started.elapsed().as_secs_f64() * 1000.0
        );
        phase.store(3, Ordering::Relaxed);
        thread::sleep(AFTER_TONE);

        let stop_started = Instant::now();
        let captured = recorder.stop_captured()?;
        println!(
            "  recorder-stop-ms={:.1} captured-ms={:.1}",
            stop_started.elapsed().as_secs_f64() * 1000.0,
            captured.samples.len() as f64 / 16.0,
        );
        let close_started = Instant::now();
        recorder.close()?;
        println!(
            "  capture-close-ms={:.1}",
            close_started.elapsed().as_secs_f64() * 1000.0
        );
        let render_close_started = Instant::now();
        output.take().unwrap().close();
        println!(
            "  render-close-ms={:.1}",
            render_close_started.elapsed().as_secs_f64() * 1000.0
        );
        trace.lock().unwrap().report()?;
        Ok(())
    }

    pub fn run() -> ProbeResult<()> {
        wasapi::initialize_mta()
            .ok()
            .map_err(|error| format!("COM initialization failed: {error}"))?;
        let args: Vec<String> = std::env::args().collect();
        let mode = args.get(1).map_or("both", String::as_str);
        let takes = args.get(2).and_then(|v| v.parse().ok()).unwrap_or(3);
        let input_name = cpal::default_host()
            .default_input_device()
            .and_then(|device| device.description().ok().map(|d| d.name().to_string()))
            .unwrap_or_else(|| "<unknown>".to_string());
        println!("default-input={input_name:?} takes={takes} mode={mode}");

        let orders: &[Order] = match mode {
            "capture-first" => &[Order::CaptureFirst],
            "render-first" => &[Order::RenderFirst],
            "both" => &[Order::CaptureFirst, Order::RenderFirst],
            other => return Err(format!("unknown mode {other:?}").into()),
        };
        for &order in orders {
            for take in 1..=takes {
                run_take(order, take)?;
                thread::sleep(Duration::from_millis(500));
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn main() {
    if let Err(error) = windows_probe::run() {
        eprintln!("probe failed: {error}");
        std::process::exit(1);
    }
}
