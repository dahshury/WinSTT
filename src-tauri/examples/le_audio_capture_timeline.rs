//! Headless Bluetooth LE Audio capture timeline.
//!
//! `le_audio_transition_probe` only timestamps capture callbacks, so it reports a
//! clean run whenever the callbacks keep arriving on schedule. On an LE Audio
//! headset that is not enough: WASAPI keeps handing us perfectly-cadenced buffers
//! full of EXACT digital silence while the isochronous link is still being set up
//! or renegotiated. Callback cadence stays flat; the audio is simply not there.
//!
//! This probe measures the audio itself. It reads raw CPAL input frames (no
//! downmix, no resample, no VAD — so a dead window here is the device, not
//! WinSTT's DSP) and bins them into fixed windows, reporting for each bin how many
//! samples were non-zero and what the peak/RMS were. A run of `nonzero=0` bins is
//! a period during which the microphone was open but capturing nothing.
//!
//! It then replays WinSTT's two candidate orderings around that timeline:
//!
//! - `capture-then-render`: open capture, wait, then add the silent Communications
//!   renderer the recording chime plays through (what the app does today).
//! - `render-then-capture`: open the renderer first, then capture.
//! - `capture-only`: baseline with no renderer at all.
//!
//! What matters is where the dead bins land relative to `capture-open` and
//! `render-open`, because WinSTT chimes "speak now" on the FIRST capture callback —
//! which arrives long before the device is actually delivering audio.
//!
//! Run from `src-tauri`:
//! `cargo run --release --example le_audio_capture_timeline -- all 6`

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("le_audio_capture_timeline is Windows-only");
}

#[cfg(target_os = "windows")]
mod timeline {
    use std::{
        error::Error,
        f32::consts::TAU,
        mem::size_of,
        sync::{Arc, Mutex},
        thread,
        time::{Duration, Instant},
    };

    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use wasapi::{
        AudioClient, AudioClientProperties, AudioRenderClient, Direction, SampleType,
        StreamCategory, StreamMode, WaveFormat,
    };

    type ProbeResult<T> = Result<T, Box<dyn Error>>;

    /// Timeline resolution. 100 ms is short enough to place a dead window against
    /// the chime (which WinSTT fires on the first callback) and long enough that a
    /// single short WASAPI buffer cannot skew a bin.
    const BIN: Duration = Duration::from_millis(100);
    /// Below this peak a bin counts as "not really capturing". The WH-1000XM6 idles
    /// around 3e-4 peak, and a genuinely dead LE bin reads exact 0.0, so this only
    /// has to separate "bit-exact silence" from "a real, quiet noise floor".
    const LIVE_PEAK: f32 = 1.0e-6;

    #[derive(Clone, Copy, Default)]
    struct Bin {
        samples: usize,
        nonzero: usize,
        peak: f32,
        sum_squares: f64,
    }

    impl Bin {
        fn rms(&self) -> f64 {
            if self.samples == 0 {
                0.0
            } else {
                (self.sum_squares / self.samples as f64).sqrt()
            }
        }

        fn is_live(&self) -> bool {
            self.samples > 0 && self.peak >= LIVE_PEAK
        }
    }

    struct Timeline {
        origin: Instant,
        bins: Vec<Bin>,
        /// (label, offset from origin) for the events we want to read the bins against.
        marks: Vec<(&'static str, Duration)>,
    }

    impl Timeline {
        fn new(origin: Instant) -> Self {
            Self {
                origin,
                bins: Vec::new(),
                marks: Vec::new(),
            }
        }

        fn push(&mut self, data: &[f32]) {
            let index = self.origin.elapsed().as_millis() as usize / BIN.as_millis() as usize;
            if self.bins.len() <= index {
                self.bins.resize(index + 1, Bin::default());
            }
            let bin = &mut self.bins[index];
            bin.samples += data.len();
            for &sample in data {
                if sample != 0.0 {
                    bin.nonzero += 1;
                }
                bin.peak = bin.peak.max(sample.abs());
                bin.sum_squares += f64::from(sample) * f64::from(sample);
            }
        }

        fn mark(&mut self, label: &'static str) {
            let at = self.origin.elapsed();
            self.marks.push((label, at));
        }

        fn report(&self) {
            for (label, at) in &self.marks {
                println!("    mark {label} @ {}ms", at.as_millis());
            }
            let mut first_live: Option<usize> = None;
            for (index, bin) in self.bins.iter().enumerate() {
                let at = index * BIN.as_millis() as usize;
                let marks: Vec<&str> = self
                    .marks
                    .iter()
                    .filter(|(_, mark_at)| {
                        let mark_index = mark_at.as_millis() as usize / BIN.as_millis() as usize;
                        mark_index == index
                    })
                    .map(|(label, _)| *label)
                    .collect();
                let marker = if marks.is_empty() {
                    String::new()
                } else {
                    format!("   <-- {}", marks.join(", "))
                };
                println!(
                    "    t={at:>5}ms samples={:>5} nonzero={:>5} peak={:.6} rms={:.6} {}{marker}",
                    bin.samples,
                    bin.nonzero,
                    bin.peak,
                    bin.rms(),
                    if bin.is_live() { "LIVE" } else { "DEAD" },
                );
                if first_live.is_none() && bin.is_live() {
                    first_live = Some(index);
                }
            }

            let capture_open = self
                .marks
                .iter()
                .find(|(label, _)| *label == "capture-open")
                .map(|(_, at)| *at);
            match (first_live, capture_open) {
                (Some(index), Some(open_at)) => {
                    let live_at = Duration::from_millis((index * BIN.as_millis() as usize) as u64);
                    println!(
                        "  SUMMARY: first real audio {}ms after capture-open (dead window = {} bins)",
                        live_at.saturating_sub(open_at).as_millis(),
                        index,
                    );
                }
                (None, _) => println!("  SUMMARY: no live audio at any point in this run"),
                _ => {}
            }

            // A dead run AFTER audio has already been live is a genuine interruption —
            // that is the "the chime cut my microphone" symptom, as opposed to the
            // device simply not having started yet.
            let mut seen_live = false;
            let mut worst_gap = 0usize;
            let mut current_gap = 0usize;
            for bin in &self.bins {
                if bin.is_live() {
                    seen_live = true;
                    worst_gap = worst_gap.max(current_gap);
                    current_gap = 0;
                } else if seen_live {
                    current_gap += 1;
                }
            }
            println!(
                "  SUMMARY: longest dead window after audio went live = {}ms",
                worst_gap * BIN.as_millis() as usize
            );
        }
    }

    /// The silent Communications renderer WinSTT keeps open for the chime.
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
            println!("    render endpoint={device_name:?} {sample_rate}Hz/{channels}ch");
            Ok(Self {
                audio_client,
                render_client,
                sample_rate,
                channels,
                phase: 0.0,
            })
        }

        /// Stand-in for the recording chime.
        fn play_tone(&mut self, duration: Duration) -> ProbeResult<()> {
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
    }

    #[derive(Clone, Copy)]
    enum Order {
        CaptureOnly,
        CaptureThenRender,
        RenderThenCapture,
    }

    impl Order {
        fn label(self) -> &'static str {
            match self {
                Self::CaptureOnly => "capture-only",
                Self::CaptureThenRender => "capture-then-render",
                Self::RenderThenCapture => "render-then-capture",
            }
        }
    }

    fn open_capture(timeline: &Arc<Mutex<Timeline>>) -> ProbeResult<cpal::Stream> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or("no default input device")?;
        let config = device.default_input_config()?;
        let timeline_cb = Arc::clone(timeline);
        let stream = device.build_input_stream(
            &config.into(),
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                timeline_cb.lock().expect("timeline").push(data);
            },
            |error| eprintln!("    capture stream error: {error}"),
            None,
        )?;
        stream.play()?;
        Ok(stream)
    }

    fn run_take(order: Order, seconds: u64) -> ProbeResult<()> {
        println!("  order={} duration={seconds}s", order.label());
        let timeline = Arc::new(Mutex::new(Timeline::new(Instant::now())));

        let mut output = None;
        if matches!(order, Order::RenderThenCapture) {
            let started = Instant::now();
            output = Some(CommunicationsOutput::open()?);
            println!("    render-open took {}ms", started.elapsed().as_millis());
            timeline.lock().expect("timeline").mark("render-open");
        }

        let started = Instant::now();
        let stream = open_capture(&timeline)?;
        println!("    capture-open took {}ms", started.elapsed().as_millis());
        timeline.lock().expect("timeline").mark("capture-open");

        // WinSTT fires the chime on the first capture callback, so mark that instant.
        let deadline = Instant::now() + Duration::from_secs(4);
        while Instant::now() < deadline {
            if !timeline.lock().expect("timeline").bins.is_empty() {
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        timeline.lock().expect("timeline").mark("first-callback");

        if matches!(order, Order::CaptureThenRender) {
            // The app opens the renderer immediately after capture, before arming.
            let started = Instant::now();
            output = Some(CommunicationsOutput::open()?);
            println!("    render-open took {}ms", started.elapsed().as_millis());
            timeline.lock().expect("timeline").mark("render-open");
        }

        if let Some(output) = output.as_mut() {
            timeline.lock().expect("timeline").mark("tone-start");
            output.play_tone(Duration::from_millis(400))?;
            timeline.lock().expect("timeline").mark("tone-end");
        }

        thread::sleep(Duration::from_secs(seconds));
        drop(stream);
        drop(output);
        timeline.lock().expect("timeline").report();
        Ok(())
    }

    pub fn run() -> ProbeResult<()> {
        wasapi::initialize_mta()
            .ok()
            .map_err(|error| format!("COM initialization failed: {error}"))?;
        let args: Vec<String> = std::env::args().collect();
        let mode = args.get(1).map_or("all", String::as_str);
        let seconds: u64 = args
            .get(2)
            .and_then(|value| value.parse().ok())
            .unwrap_or(5);

        let orders: &[Order] = match mode {
            "capture-only" => &[Order::CaptureOnly],
            "capture-then-render" => &[Order::CaptureThenRender],
            "render-then-capture" => &[Order::RenderThenCapture],
            "all" => &[
                Order::CaptureOnly,
                Order::CaptureThenRender,
                Order::RenderThenCapture,
            ],
            other => return Err(format!("unknown mode {other:?}").into()),
        };

        for &order in orders {
            run_take(order, seconds)?;
            // Let the LE link fully tear down so the next take starts from idle,
            // the same state a fresh on-demand hotkey press starts from.
            thread::sleep(Duration::from_millis(1500));
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn main() {
    if let Err(error) = timeline::run() {
        eprintln!("probe failed: {error}");
        std::process::exit(1);
    }
}
