use crate::winstt::commands::settings;
use crate::winstt::settings_schema::{GeneralSettings, VisualizerAuraShape, VisualizerType};
use crate::winstt::sync_ext::MutexExt;
use once_cell::sync::Lazy;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::image::Image;
use tauri::tray::TrayIcon;
use tauri::{AppHandle, Manager};

const TARGET_SIZE: u32 = 48;
const TARGET_SIZE_USIZE: usize = TARGET_SIZE as usize;
const TRAY_INK: Rgb = [255, 255, 255];

const BAR_COUNT: usize = 5;
const BAR_WIDTH: f64 = 7.0;
const BAR_GAP: f64 = 3.0;
const VERTICAL_MARGIN: f64 = 2.0;
const RECORDING_FRAME_INTERVAL_MS: u64 = 50;
const THINK_TICK_MS: u64 = 33;

const PEAK_FLOOR: f64 = 0.1;
const PEAK_DECAY: f64 = 0.99;

const TOPOLOGY_DURATION_MS: u128 = 6000;
const TOPOLOGY_STROKE_WIDTH_SRC: f64 = 1.5;
const TOPOLOGY_SUBDIVISIONS_PER_SEGMENT: usize = 32;
const TOPOLOGY_PADDING: f64 = 2.0;

const GRID_DIM_INTENSITY: f64 = 0.18;
const GRID_MARGIN: f64 = 5.0;

const RADIAL_INNER: f64 = 7.0;
const RADIAL_OUTER: f64 = 21.0;
const RADIAL_DOT_R: f64 = 1.8;

const WAVE_SPEED: f64 = 10.0;
const WAVE_MAX_AMPLITUDE: f64 = 0.4;
const WAVE_AMPLITUDE_BASE: f64 = 0.06;
const WAVE_AMPLITUDE_GAIN: f64 = 0.9;

type Rgb = [u8; 3];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum IndicatorView {
    Idle,
    Recording,
    Thinking,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum VisualizerStyle {
    Bar,
    Grid,
    Radial,
    Wave,
    Aura,
}

#[derive(Clone, Copy, Debug)]
struct VisualizerConfig {
    style: VisualizerStyle,
    grid_rows: usize,
    grid_columns: usize,
    radial_dot_count: usize,
    wave_line_width: f64,
    aura_shape: AuraShape,
    aura_blur: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AuraShape {
    Circle,
    Line,
}

impl Default for VisualizerConfig {
    fn default() -> Self {
        Self {
            style: VisualizerStyle::Bar,
            grid_rows: 5,
            grid_columns: 5,
            radial_dot_count: 24,
            wave_line_width: 2.0,
            aura_shape: AuraShape::Circle,
            aura_blur: 0.2,
        }
    }
}

impl VisualizerConfig {
    fn from_general(general: &GeneralSettings) -> Self {
        Self {
            style: match general.visualizer_type {
                VisualizerType::Grid => VisualizerStyle::Grid,
                VisualizerType::Radial => VisualizerStyle::Radial,
                VisualizerType::Wave => VisualizerStyle::Wave,
                VisualizerType::Aura => VisualizerStyle::Aura,
                VisualizerType::Bar => VisualizerStyle::Bar,
            },
            grid_rows: clamp_i64(general.visualizer_grid_rows, 3, 8, 5) as usize,
            grid_columns: clamp_i64(general.visualizer_grid_columns, 3, 8, 5) as usize,
            radial_dot_count: clamp_i64(general.visualizer_radial_dot_count, 6, 24, 24) as usize,
            wave_line_width: clamp_i64(general.visualizer_wave_line_width, 1, 6, 2) as f64,
            aura_shape: match general.visualizer_aura_shape {
                VisualizerAuraShape::Line => AuraShape::Line,
                VisualizerAuraShape::Circle => AuraShape::Circle,
            },
            aura_blur: (clamp_i64(general.visualizer_aura_blur, 0, 100, 20) as f64) / 100.0,
        }
    }
}

struct IndicatorState {
    current_view: IndicatorView,
    is_recording: bool,
    is_transcribing: bool,
    is_llm_thinking: bool,
    raw_level: f64,
    peak: f64,
    session_start: Instant,
    thinking_start: Instant,
    config: VisualizerConfig,
    recording_frame_pending: bool,
}

impl Default for IndicatorState {
    fn default() -> Self {
        let now = Instant::now();
        Self {
            current_view: IndicatorView::Idle,
            is_recording: false,
            is_transcribing: false,
            is_llm_thinking: false,
            raw_level: 0.0,
            peak: PEAK_FLOOR,
            session_start: now,
            thinking_start: now,
            config: VisualizerConfig::default(),
            recording_frame_pending: false,
        }
    }
}

struct TrayIndicator {
    state: Mutex<IndicatorState>,
    recording_frame_ready: Condvar,
    paint_gate: PaintGate,
}

/// Orders tray paints without ever holding a lock across a native tray call.
///
/// Every native call is handed to the main thread by [`paint_on_main_thread`],
/// so the event loop itself serializes paints and a mutex around them would buy
/// nothing but deadlocks: `TrayIcon::set_icon` posts a task to the main thread
/// and blocks on its reply, so a paint thread holding a shared lock while the
/// main thread was busy inside a blocking `#[tauri::command]` wedged the app
/// permanently (leaving listen mode paints an idle icon from the command thread
/// while the 50 ms recording renderer is mid-`set_icon`).
///
/// `generation` is the only ordering primitive left: it is stamped when the
/// paint is scheduled and re-checked once the closure actually runs on the main
/// thread, so a frame from a superseded animation can never land after the
/// static icon that replaced it.
struct PaintGate {
    generation: AtomicU64,
}

impl PaintGate {
    fn new() -> Self {
        Self {
            generation: AtomicU64::new(0),
        }
    }

    fn current_generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    fn advance_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn advance_and_paint(&self, paint: impl FnOnce(u64)) -> u64 {
        let generation = self.advance_generation();
        paint(generation);
        generation
    }

    fn paint_if_current(&self, generation: u64, paint: impl FnOnce(u64)) -> bool {
        if self.current_generation() != generation {
            return false;
        }
        paint(generation);
        true
    }
}

static TRAY_INDICATOR: Lazy<TrayIndicator> = Lazy::new(|| TrayIndicator {
    state: Mutex::new(IndicatorState::default()),
    recording_frame_ready: Condvar::new(),
    paint_gate: PaintGate::new(),
});

/// One lifecycle edge from the STT pipeline. Every tray view change goes through
/// [`apply_signal`], which is a PURE function of the flag set — that is what makes
/// the "does the icon always come back to idle?" question testable without a live
/// `AppHandle`, a tray, or a window event loop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum IndicatorSignal {
    RecordingStart,
    RecordingStop,
    TranscribingStart,
    TranscribingStop,
    LlmThinkingStart,
    LlmThinkingStop,
    /// Hard reset. Terminal events (`full_sentence`, `no_audio_detected`,
    /// `transcription_failed`, `session_aborted`) and every self-heal path use
    /// this, so it must clear EVERY flag rather than just the one it knows about.
    Idle,
}

/// Fold a lifecycle signal into the flag set and report the view it implies.
///
/// Returns `None` when the signal is inert (a stop for something that was never
/// started, a duplicate start) so the caller can skip the repaint entirely.
/// `Idle` always returns `Some` — it is the recovery valve, and a stuck animation
/// must repaint even when the bookkeeping already believed it was idle.
fn apply_signal(state: &mut IndicatorState, signal: IndicatorSignal) -> Option<IndicatorView> {
    match signal {
        IndicatorSignal::RecordingStart => {
            state.is_recording = true;
            state.raw_level = 0.0;
            state.peak = PEAK_FLOOR;
            state.session_start = Instant::now();
            state.recording_frame_pending = false;
        }
        IndicatorSignal::RecordingStop => {
            if !state.is_recording {
                return None;
            }
            state.is_recording = false;
            state.raw_level = 0.0;
            state.peak = PEAK_FLOOR;
            state.recording_frame_pending = false;
        }
        IndicatorSignal::TranscribingStart => {
            if state.is_transcribing {
                return None;
            }
            if !(state.is_llm_thinking || state.is_recording) {
                state.thinking_start = Instant::now();
            }
            state.is_transcribing = true;
        }
        IndicatorSignal::TranscribingStop => {
            if !state.is_transcribing {
                return None;
            }
            state.is_transcribing = false;
        }
        IndicatorSignal::LlmThinkingStart => {
            if state.is_llm_thinking {
                return None;
            }
            // Same guard as TranscribingStart: only restart the topology phase when
            // nothing was already driving it, so a cleanup pass that follows a decode
            // continues the animation instead of snapping back to frame zero.
            if !(state.is_transcribing || state.is_recording) {
                state.thinking_start = Instant::now();
            }
            state.is_llm_thinking = true;
        }
        IndicatorSignal::LlmThinkingStop => {
            if !state.is_llm_thinking {
                return None;
            }
            state.is_llm_thinking = false;
        }
        IndicatorSignal::Idle => {
            state.is_recording = false;
            state.is_transcribing = false;
            state.is_llm_thinking = false;
            state.raw_level = 0.0;
            state.peak = PEAK_FLOOR;
            state.recording_frame_pending = false;
        }
    }
    Some(derive_view(state))
}

pub(crate) fn set_visualizer_style_from_general(general: &GeneralSettings) {
    TRAY_INDICATOR.state.lock_recover().config = VisualizerConfig::from_general(general);
}

pub(crate) fn sync_visualizer_style_from_settings(app: &AppHandle) {
    let general = settings::read_settings(app).general;
    set_visualizer_style_from_general(&general);
}

pub(crate) fn on_recording_start(app: &AppHandle) {
    sync_visualizer_style_from_settings(app);
    reconcile_view(app, IndicatorSignal::RecordingStart);
}

pub(crate) fn on_recording_stop(app: &AppHandle) {
    reconcile_view(app, IndicatorSignal::RecordingStop);
}

pub(crate) fn on_audio_level(level: f32) {
    let mut state = TRAY_INDICATOR.state.lock_recover();
    if !state.is_recording {
        return;
    }
    state.raw_level = (level as f64).clamp(0.0, 1.0);
    state.recording_frame_pending = true;
    drop(state);
    // The recorder callback only updates shared state and wakes the coalescing
    // renderer. Pixel generation and native tray calls remain off the audio
    // thread.
    TRAY_INDICATOR.recording_frame_ready.notify_one();
}

pub(crate) fn on_transcribing_start(app: &AppHandle) {
    reconcile_view(app, IndicatorSignal::TranscribingStart);
}

pub(crate) fn on_transcribing_stop(app: &AppHandle) {
    reconcile_view(app, IndicatorSignal::TranscribingStop);
}

pub(crate) fn on_llm_thinking_start(app: &AppHandle) {
    reconcile_view(app, IndicatorSignal::LlmThinkingStart);
}

pub(crate) fn on_llm_thinking_stop(app: &AppHandle) {
    reconcile_view(app, IndicatorSignal::LlmThinkingStop);
}

/// Hard reset to the static idle icon. UNCONDITIONAL: it repaints even when the
/// flag set already read idle, because this is the only lever that can rescue a
/// tray whose animation outlived the pipeline that started it (a lost stop event,
/// a panicking pipeline task, a recorder that closed itself).
pub(crate) fn on_idle(app: &AppHandle) {
    let mut state = TRAY_INDICATOR.state.lock_recover();
    let _ = apply_signal(&mut state, IndicatorSignal::Idle);
    state.current_view = IndicatorView::Idle;
    drop(state);
    TRAY_INDICATOR.paint_gate.advance_and_paint(|generation| {
        paint_static_on_main_thread(app, crate::tray::TrayIconState::Idle, generation);
    });
    TRAY_INDICATOR.recording_frame_ready.notify_all();
}

fn derive_view(state: &IndicatorState) -> IndicatorView {
    if state.is_recording {
        IndicatorView::Recording
    } else if state.is_transcribing || state.is_llm_thinking {
        IndicatorView::Thinking
    } else {
        IndicatorView::Idle
    }
}

fn reconcile_view(app: &AppHandle, signal: IndicatorSignal) {
    let next = {
        let mut state = TRAY_INDICATOR.state.lock_recover();
        let Some(next) = apply_signal(&mut state, signal) else {
            return;
        };
        if next == state.current_view {
            return;
        }
        state.current_view = next;
        next
    };

    match next {
        IndicatorView::Idle => {
            TRAY_INDICATOR.paint_gate.advance_and_paint(|generation| {
                paint_static_on_main_thread(app, crate::tray::TrayIconState::Idle, generation);
            });
        }
        IndicatorView::Recording => {
            let generation = TRAY_INDICATOR.paint_gate.advance_generation();
            render_frame_for_generation(app, generation);
            spawn_recording_renderer(app.clone(), generation);
        }
        IndicatorView::Thinking => {
            let generation = TRAY_INDICATOR.paint_gate.advance_generation();
            render_frame_for_generation(app, generation);
            spawn_thinking_animation(app.clone(), generation);
        }
    }
    // A recording renderer may be blocked waiting for its next level callback.
    // Wake it so generation changes stop it immediately.
    TRAY_INDICATOR.recording_frame_ready.notify_all();
}

/// Condvar waits that RECOVER a poisoned lock instead of bailing out.
///
/// The animation threads used to `return` on a poisoned lock, and every mutating
/// entry point used to silently skip its work — so ONE panic anywhere under this
/// mutex froze the tray on whatever frame it happened to be showing, with no way
/// back to idle for the rest of the process. Recovering the value (the crate-wide
/// [`MutexExt::lock_recover`] policy) turns that permanent wedge into a transient.
fn wait_recover(guard: std::sync::MutexGuard<'static, IndicatorState>) -> WaitGuard {
    TRAY_INDICATOR
        .recording_frame_ready
        .wait(guard)
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn wait_timeout_recover(guard: WaitGuard, timeout: Duration) -> WaitGuard {
    match TRAY_INDICATOR
        .recording_frame_ready
        .wait_timeout(guard, timeout)
    {
        Ok((guard, _)) => guard,
        Err(poisoned) => poisoned.into_inner().0,
    }
}

type WaitGuard = std::sync::MutexGuard<'static, IndicatorState>;

/// Paint recording frames only in response to recorder level callbacks.
///
/// The condition variable eliminates the former fixed-rate polling loop. A
/// deadline merely rate-limits bursts to the previous 20 FPS cadence; callbacks
/// received before the deadline are coalesced into the latest level.
fn spawn_recording_renderer(app: AppHandle, generation: u64) {
    thread::spawn(move || {
        let frame_interval = Duration::from_millis(RECORDING_FRAME_INTERVAL_MS);
        let mut next_frame_at = Instant::now() + frame_interval;

        loop {
            let mut state = TRAY_INDICATOR.state.lock_recover();
            while !state.recording_frame_pending
                && TRAY_INDICATOR.paint_gate.current_generation() == generation
            {
                state = wait_recover(state);
            }
            if TRAY_INDICATOR.paint_gate.current_generation() != generation {
                return;
            }

            while let Some(remaining) = next_frame_at.checked_duration_since(Instant::now()) {
                state = wait_timeout_recover(state, remaining);
                if TRAY_INDICATOR.paint_gate.current_generation() != generation {
                    return;
                }
            }

            state.recording_frame_pending = false;
            drop(state);
            render_frame_for_generation(&app, generation);
            next_frame_at = Instant::now() + frame_interval;
        }
    });
}

fn spawn_thinking_animation(app: AppHandle, generation: u64) {
    thread::spawn(move || {
        let frame_interval = Duration::from_millis(THINK_TICK_MS);
        loop {
            let deadline = Instant::now() + frame_interval;
            let mut state = TRAY_INDICATOR.state.lock_recover();
            while TRAY_INDICATOR.paint_gate.current_generation() == generation {
                let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                    break;
                };
                state = wait_timeout_recover(state, remaining);
            }
            if TRAY_INDICATOR.paint_gate.current_generation() != generation {
                return;
            }
            drop(state);
            render_frame_for_generation(&app, generation);
        }
    });
}

fn render_frame_for_generation(app: &AppHandle, generation: u64) {
    if TRAY_INDICATOR.paint_gate.current_generation() != generation {
        return;
    }

    enum Frame {
        Recording {
            config: VisualizerConfig,
            amplified: f64,
            raw_level: f64,
            time: f64,
        },
        Thinking(ParsedPath),
    }

    let frame = {
        let mut state = TRAY_INDICATOR.state.lock_recover();
        match state.current_view {
            IndicatorView::Recording => {
                let raw_level = state.raw_level;
                let next = compute_amplified(raw_level, state.peak);
                state.peak = next.peak;
                let time = state.session_start.elapsed().as_secs_f64();
                Frame::Recording {
                    config: state.config,
                    amplified: next.amplified,
                    raw_level,
                    time,
                }
            }
            IndicatorView::Thinking => {
                let elapsed = state.thinking_start.elapsed().as_millis() % TOPOLOGY_DURATION_MS;
                let t_raw = elapsed as f64 / TOPOLOGY_DURATION_MS as f64;
                Frame::Thinking(interpolate_topology(t_raw))
            }
            IndicatorView::Idle => return,
        }
    };

    // Rendering is deliberately outside the state mutex so the real-time audio
    // callback never waits behind bitmap work.
    let rgba = match frame {
        Frame::Recording {
            config,
            amplified,
            raw_level,
            time,
        } => render_visualizer_frame(config, amplified, raw_level, time),
        Frame::Thinking(path) => render_topology_icon(path, TRAY_INK),
    };

    // Keep the final generation check and native call in one critical section.
    // Static paints use the same gate, so an old animation can never paint after
    // a newer idle icon has completed.
    TRAY_INDICATOR
        .paint_gate
        .paint_if_current(generation, |generation| {
            set_icon_on_tray(app, rgba, generation);
        });
}

/// Hand a native tray call to the main thread WITHOUT waiting for it.
///
/// `TrayIcon::set_icon`/`set_tooltip` post to the event loop and block on the
/// reply, so calling them from a worker while the main thread is inside a
/// blocking command is a deadlock waiting to happen. `run_on_main_thread` runs
/// the closure inline when the caller already IS the main thread and otherwise
/// queues it, so no caller ever parks on the event loop. The generation is
/// re-checked inside the closure because scheduling order, not call order, is
/// what decides which frame reaches the tray.
fn paint_on_main_thread(
    app: &AppHandle,
    generation: u64,
    paint: impl FnOnce(&AppHandle) + Send + 'static,
) {
    let app_for_paint = app.clone();
    let _ = app.run_on_main_thread(move || {
        if TRAY_INDICATOR.paint_gate.current_generation() != generation {
            return;
        }
        paint(&app_for_paint);
    });
}

fn paint_static_on_main_thread(app: &AppHandle, icon: crate::tray::TrayIconState, generation: u64) {
    paint_on_main_thread(app, generation, move |app| {
        crate::tray::paint_static_tray_icon(app, icon);
    });
}

fn set_icon_on_tray(app: &AppHandle, rgba: Vec<u8>, generation: u64) {
    paint_on_main_thread(app, generation, move |app| {
        let Some(tray) = app.try_state::<TrayIcon>() else {
            return;
        };
        let _ = tray.set_icon(Some(Image::new_owned(rgba, TARGET_SIZE, TARGET_SIZE)));
    });
}

fn clamp_i64(value: i64, lo: i64, hi: i64, _fallback: i64) -> i64 {
    value.clamp(lo, hi)
}

struct Amplified {
    amplified: f64,
    peak: f64,
}

fn compute_amplified(audio_level: f64, prev_peak: f64) -> Amplified {
    let next_peak = PEAK_FLOOR.max(audio_level).max(prev_peak * PEAK_DECAY);
    let amplified = (audio_level.clamp(0.0, 1.0) / next_peak).min(1.0).sqrt();
    Amplified {
        amplified,
        peak: next_peak,
    }
}

fn compute_band_value(band_index: usize, bands: usize, time: f64, amplified: f64) -> f64 {
    let phase = (band_index as f64 / bands as f64) * std::f64::consts::PI * 2.0;
    let v1 = 0.3 * (time * 3.7 + phase).sin();
    let v2 = 0.2 * (time * 7.3 + phase * 2.5).sin();
    let v3 = 0.1 * (time * 13.1 + phase * 0.7).sin();
    (amplified * (0.8 + v1 + v2 + v3)).clamp(0.05, 1.0)
}

fn compute_bands(count: usize, time: f64, amplified: f64) -> Vec<f64> {
    (0..count)
        .map(|i| compute_band_value(i, count, time, amplified))
        .collect()
}

fn blank_rgba() -> Vec<u8> {
    vec![0; TARGET_SIZE_USIZE * TARGET_SIZE_USIZE * 4]
}

fn render_visualizer_frame(
    config: VisualizerConfig,
    amplified: f64,
    level: f64,
    time: f64,
) -> Vec<u8> {
    match config.style {
        VisualizerStyle::Grid => render_grid_icon(config, amplified, time, TRAY_INK),
        VisualizerStyle::Radial => render_radial_icon(config, amplified, time, TRAY_INK),
        VisualizerStyle::Wave => render_wave_icon(config, level, time, TRAY_INK),
        VisualizerStyle::Aura => render_aura_icon(config, level, time, TRAY_INK),
        VisualizerStyle::Bar => {
            render_bars_icon(&compute_bands(BAR_COUNT, time, amplified), TRAY_INK)
        }
    }
}

fn render_bars_icon(bands: &[f64], tint: Rgb) -> Vec<u8> {
    let mut data = blank_rgba();
    let total_width = BAR_COUNT as f64 * BAR_WIDTH + (BAR_COUNT - 1) as f64 * BAR_GAP;
    let start_x = ((TARGET_SIZE as f64 - total_width) / 2.0).floor();
    let max_bar_height = TARGET_SIZE as f64 - VERTICAL_MARGIN * 2.0;
    let cy = TARGET_SIZE as f64 / 2.0;

    for i in 0..BAR_COUNT {
        let band = bands.get(i).copied().unwrap_or(0.05).clamp(0.0, 1.0);
        let height = BAR_WIDTH.max((band * max_bar_height).round());
        let x0 = start_x + i as f64 * (BAR_WIDTH + BAR_GAP);
        draw_rounded_bar(&mut data, x0, cy, BAR_WIDTH, height, tint);
    }
    data
}

fn render_grid_icon(config: VisualizerConfig, amplified: f64, time: f64, tint: Rgb) -> Vec<u8> {
    let mut data = blank_rgba();
    let cols = config.grid_columns;
    let rows = config.grid_rows;
    let bands = compute_bands(cols, time, amplified);
    let usable = TARGET_SIZE as f64 - GRID_MARGIN * 2.0;
    let cell_w = usable / cols as f64;
    let cell_h = usable / rows as f64;
    let dot_r = cell_w.min(cell_h).mul_add(0.32, 0.0).max(1.0);

    for index in 0..(rows * cols) {
        let col = index % cols;
        let row = index / cols;
        let cx = GRID_MARGIN + (col as f64 + 0.5) * cell_w;
        let cy = GRID_MARGIN + (row as f64 + 0.5) * cell_h;
        let intensity = if is_speaking_cell_highlighted(index, cols, rows, &bands) {
            1.0
        } else {
            GRID_DIM_INTENSITY
        };
        draw_dot(&mut data, cx, cy, dot_r, tint, intensity);
    }
    data
}

fn is_speaking_cell_highlighted(
    index: usize,
    column_count: usize,
    row_count: usize,
    volume_bands: &[f64],
) -> bool {
    let y = index / column_count;
    let row_mid_point = row_count / 2;
    let volume_chunks = 1.0 / (row_mid_point + 1) as f64;
    let distance_to_mid = row_mid_point.abs_diff(y);
    let threshold = distance_to_mid as f64 * volume_chunks;
    volume_bands
        .get(index % column_count)
        .copied()
        .unwrap_or(0.0)
        >= threshold
}

fn render_radial_icon(config: VisualizerConfig, amplified: f64, time: f64, tint: Rgb) -> Vec<u8> {
    let mut data = blank_rgba();
    let count = config.radial_dot_count;
    let bands = compute_bands(count, time, amplified);
    let cx = TARGET_SIZE as f64 / 2.0;
    let cy = TARGET_SIZE as f64 / 2.0;

    for i in 0..count {
        let angle =
            (i as f64 / count as f64) * std::f64::consts::PI * 2.0 - std::f64::consts::PI / 2.0;
        let band = bands.get(i).copied().unwrap_or(0.05).clamp(0.0, 1.0);
        let radius = RADIAL_INNER + band * (RADIAL_OUTER - RADIAL_INNER);
        draw_dot(
            &mut data,
            cx + angle.cos() * radius,
            cy + angle.sin() * radius,
            RADIAL_DOT_R,
            tint,
            1.0,
        );
    }
    data
}

fn render_wave_icon(config: VisualizerConfig, level: f64, time: f64, tint: Rgb) -> Vec<u8> {
    let mut data = blank_rgba();
    let level = level.clamp(0.0, 1.0);
    let amplitude =
        WAVE_MAX_AMPLITUDE.min(WAVE_AMPLITUDE_BASE + WAVE_AMPLITUDE_GAIN * level.sqrt());
    let frequency = 20.0 + 60.0 * level;
    let radius = config.wave_line_width.max(1.0) / 2.0;
    let samples = TARGET_SIZE_USIZE * 3;

    for sample in 0..=samples {
        let uvx = sample as f64 / samples as f64;
        let rel_x = uvx - 0.5;
        let norm_dist = (rel_x.abs() * 2.0).min(1.0);
        let bell = ((norm_dist * std::f64::consts::PI) / 4.0).cos().powi(16);
        let wave = (rel_x * frequency + time * WAVE_SPEED).sin() * amplitude * bell;
        let px = uvx * (TARGET_SIZE as f64 - 1.0);
        let py = (0.5 + wave) * (TARGET_SIZE as f64 - 1.0);
        draw_dot(&mut data, px, py, radius, tint, 1.0);
    }
    data
}

fn render_aura_icon(config: VisualizerConfig, level: f64, time: f64, tint: Rgb) -> Vec<u8> {
    let mut data = blank_rgba();
    let level = level.clamp(0.0, 1.0);
    let breathe = 1.0 + 0.04 * (time * 2.2).sin();
    let scale = (0.2 + 0.2 * level) * breathe;
    let edge = 2.0 + config.aura_blur * 6.0;
    let cx = TARGET_SIZE as f64 / 2.0;
    let cy = TARGET_SIZE as f64 / 2.0;

    match config.aura_shape {
        AuraShape::Line => {
            let half_len = (TARGET_SIZE as f64 / 2.0 - 3.0).min(4.0 + scale * TARGET_SIZE as f64);
            paint_soft_field(&mut data, tint, edge, 3.0, |px, py| {
                let qx = px.clamp(cx - half_len, cx + half_len);
                (px - qx).hypot(py - cy)
            });
        }
        AuraShape::Circle => {
            let radius = scale * TARGET_SIZE as f64;
            paint_soft_field(&mut data, tint, edge, radius, |px, py| {
                (px - cx).hypot(py - cy)
            });
        }
    }
    data
}

fn draw_dot(data: &mut [u8], cx: f64, cy: f64, radius: f64, tint: Rgb, intensity: f64) {
    let min_x = ((cx - radius - 1.0).floor() as i32).max(0);
    let max_x = ((cx + radius + 1.0).ceil() as i32).min(TARGET_SIZE as i32 - 1);
    let min_y = ((cy - radius - 1.0).floor() as i32).max(0);
    let max_y = ((cy + radius + 1.0).ceil() as i32).min(TARGET_SIZE as i32 - 1);

    for py in min_y..=max_y {
        for px in min_x..=max_x {
            let dx = px as f64 + 0.5 - cx;
            let dy = py as f64 + 0.5 - cy;
            let alpha = disc_coverage(dx.hypot(dy), radius) * intensity;
            if alpha > 0.0 {
                blit_pixel(data, px, py, tint, alpha);
            }
        }
    }
}

fn paint_soft_field(
    data: &mut [u8],
    tint: Rgb,
    edge: f64,
    core: f64,
    distance_at: impl Fn(f64, f64) -> f64,
) {
    for py in 0..TARGET_SIZE as i32 {
        for px in 0..TARGET_SIZE as i32 {
            let distance = distance_at(px as f64 + 0.5, py as f64 + 0.5);
            let intensity = if distance <= core {
                1.0
            } else if distance >= core + edge {
                0.0
            } else {
                1.0 - (distance - core) / edge
            };
            if intensity > 0.0 {
                blit_pixel(data, px, py, tint, (255.0 * intensity).round());
            }
        }
    }
}

fn draw_rounded_bar(data: &mut [u8], x0: f64, cy: f64, width: f64, height: f64, tint: Rgb) {
    let radius = width / 2.0;
    let y0 = cy - height / 2.0;
    let y1 = cy + height / 2.0;

    for py in 0..TARGET_SIZE as i32 {
        let py_f = py as f64;
        if py_f + 1.0 <= y0 || py_f >= y1 {
            continue;
        }
        paint_bar_scanline(data, x0, py, y0, y1, radius, width, tint);
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "scanline renderer passes tightly coupled geometry scalars in the hot path"
)]
fn paint_bar_scanline(
    data: &mut [u8],
    x0: f64,
    py: i32,
    y0: f64,
    y1: f64,
    radius: f64,
    width: f64,
    tint: Rgb,
) {
    for dx in 0..width as i32 {
        let px = x0 as i32 + dx;
        if !(0..TARGET_SIZE as i32).contains(&px) {
            continue;
        }
        let alpha = cap_coverage(dx as f64, py, y0, y1, radius, width);
        if alpha > 0.0 {
            blit_pixel(data, px, py, tint, alpha);
        }
    }
}

fn cap_coverage(local_x: f64, py: i32, y0: f64, y1: f64, radius: f64, width: f64) -> f64 {
    let local_center_x = width / 2.0;
    let dx = local_x + 0.5 - local_center_x;
    let py_center = py as f64 + 0.5;

    if py_center >= y0 + radius && py_center <= y1 - radius {
        return 255.0;
    }
    if py_center < y0 + radius {
        let dy = py_center - (y0 + radius);
        return disc_coverage(dx.hypot(dy), radius);
    }
    let dy = py_center - (y1 - radius);
    disc_coverage(dx.hypot(dy), radius)
}

fn disc_coverage(distance: f64, radius: f64) -> f64 {
    if distance <= radius - 1.0 {
        255.0
    } else if distance >= radius {
        0.0
    } else {
        ((radius - distance) * 255.0).round()
    }
}

fn blit_pixel(data: &mut [u8], x: i32, y: i32, tint: Rgb, alpha: f64) {
    if !(0..TARGET_SIZE as i32).contains(&x) || !(0..TARGET_SIZE as i32).contains(&y) {
        return;
    }
    let idx = (y as usize * TARGET_SIZE_USIZE + x as usize) * 4;
    let alpha = alpha.clamp(0.0, 255.0).round();
    if alpha <= 0.0 {
        return;
    }
    let dst_a = data[idx + 3] as f64;
    if dst_a == 0.0 {
        data[idx] = tint[0];
        data[idx + 1] = tint[1];
        data[idx + 2] = tint[2];
        data[idx + 3] = alpha as u8;
        return;
    }

    let src_a = alpha / 255.0;
    let dst_a_norm = dst_a / 255.0;
    let out_a = src_a + dst_a_norm * (1.0 - src_a);
    if out_a <= 0.0 {
        return;
    }
    for channel in 0..3 {
        let src = tint[channel] as f64;
        let dst = data[idx + channel] as f64;
        data[idx + channel] =
            ((src * src_a + dst * dst_a_norm * (1.0 - src_a)) / out_a).round() as u8;
    }
    data[idx + 3] = (out_a * 255.0).round() as u8;
}

#[derive(Clone, Copy)]
struct Point {
    x: f64,
    y: f64,
}

#[derive(Clone, Copy)]
struct CubicSegment {
    c1: Point,
    c2: Point,
    end: Point,
}

#[derive(Clone, Copy)]
struct ParsedPath {
    start: Point,
    segments: [CubicSegment; 4],
}

#[derive(Clone, Copy)]
struct Bbox {
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
}

const CIRCLE_A: ParsedPath = ParsedPath {
    start: Point { x: 12.0, y: 8.0 },
    segments: [
        CubicSegment {
            c1: Point { x: 14.21, y: 8.0 },
            c2: Point { x: 16.0, y: 9.79 },
            end: Point { x: 16.0, y: 12.0 },
        },
        CubicSegment {
            c1: Point { x: 16.0, y: 14.21 },
            c2: Point { x: 14.21, y: 16.0 },
            end: Point { x: 12.0, y: 16.0 },
        },
        CubicSegment {
            c1: Point { x: 9.79, y: 16.0 },
            c2: Point { x: 8.0, y: 14.21 },
            end: Point { x: 8.0, y: 12.0 },
        },
        CubicSegment {
            c1: Point { x: 8.0, y: 9.79 },
            c2: Point { x: 9.79, y: 8.0 },
            end: Point { x: 12.0, y: 8.0 },
        },
    ],
};

const INFINITY_PATH: ParsedPath = ParsedPath {
    start: Point { x: 12.0, y: 12.0 },
    segments: [
        CubicSegment {
            c1: Point { x: 14.0, y: 8.5 },
            c2: Point { x: 19.0, y: 8.5 },
            end: Point { x: 19.0, y: 12.0 },
        },
        CubicSegment {
            c1: Point { x: 19.0, y: 15.5 },
            c2: Point { x: 14.0, y: 15.5 },
            end: Point { x: 12.0, y: 12.0 },
        },
        CubicSegment {
            c1: Point { x: 10.0, y: 8.5 },
            c2: Point { x: 5.0, y: 8.5 },
            end: Point { x: 5.0, y: 12.0 },
        },
        CubicSegment {
            c1: Point { x: 5.0, y: 15.5 },
            c2: Point { x: 10.0, y: 15.5 },
            end: Point { x: 12.0, y: 12.0 },
        },
    ],
};

const CIRCLE_B: ParsedPath = ParsedPath {
    start: Point { x: 12.0, y: 16.0 },
    segments: [
        CubicSegment {
            c1: Point { x: 14.21, y: 16.0 },
            c2: Point { x: 16.0, y: 14.21 },
            end: Point { x: 16.0, y: 12.0 },
        },
        CubicSegment {
            c1: Point { x: 16.0, y: 9.79 },
            c2: Point { x: 14.21, y: 8.0 },
            end: Point { x: 12.0, y: 8.0 },
        },
        CubicSegment {
            c1: Point { x: 9.79, y: 8.0 },
            c2: Point { x: 8.0, y: 9.79 },
            end: Point { x: 8.0, y: 12.0 },
        },
        CubicSegment {
            c1: Point { x: 8.0, y: 14.21 },
            c2: Point { x: 9.79, y: 16.0 },
            end: Point { x: 12.0, y: 16.0 },
        },
    ],
};

const TOPOLOGY_KEYFRAMES: [ParsedPath; 5] =
    [CIRCLE_A, INFINITY_PATH, CIRCLE_B, INFINITY_PATH, CIRCLE_A];

static TOPOLOGY_BBOX: Lazy<Bbox> = Lazy::new(|| compute_keyframes_bbox(&TOPOLOGY_KEYFRAMES));

fn ease_in_out_sine(t: f64) -> f64 {
    0.5 * (1.0 - (std::f64::consts::PI * t.clamp(0.0, 1.0)).cos())
}

fn lerp_path(a: ParsedPath, b: ParsedPath, t: f64) -> ParsedPath {
    let lerp = |u: f64, v: f64| u + (v - u) * t;
    let mut segments = a.segments;
    for (idx, segment) in segments.iter_mut().enumerate() {
        let other = b.segments[idx];
        segment.c1 = Point {
            x: lerp(segment.c1.x, other.c1.x),
            y: lerp(segment.c1.y, other.c1.y),
        };
        segment.c2 = Point {
            x: lerp(segment.c2.x, other.c2.x),
            y: lerp(segment.c2.y, other.c2.y),
        };
        segment.end = Point {
            x: lerp(segment.end.x, other.end.x),
            y: lerp(segment.end.y, other.end.y),
        };
    }
    ParsedPath {
        start: Point {
            x: lerp(a.start.x, b.start.x),
            y: lerp(a.start.y, b.start.y),
        },
        segments,
    }
}

fn interpolate_topology(t_raw: f64) -> ParsedPath {
    let segment_count = TOPOLOGY_KEYFRAMES.len() - 1;
    let wrapped = t_raw.rem_euclid(1.0);
    let scaled = wrapped * segment_count as f64;
    let segment_index = (scaled.floor() as usize).min(segment_count - 1);
    let segment_t = scaled - segment_index as f64;
    lerp_path(
        TOPOLOGY_KEYFRAMES[segment_index],
        TOPOLOGY_KEYFRAMES[segment_index + 1],
        ease_in_out_sine(segment_t),
    )
}

fn compute_keyframes_bbox(frames: &[ParsedPath]) -> Bbox {
    let mut bbox = Bbox {
        min_x: f64::INFINITY,
        min_y: f64::INFINITY,
        max_x: f64::NEG_INFINITY,
        max_y: f64::NEG_INFINITY,
    };
    for frame in frames {
        visit_bbox(&mut bbox, frame.start);
        let mut cursor = frame.start;
        for segment in frame.segments {
            for sample in 1..=32 {
                visit_bbox(
                    &mut bbox,
                    eval_cubic(
                        cursor,
                        segment.c1,
                        segment.c2,
                        segment.end,
                        sample as f64 / 32.0,
                    ),
                );
            }
            cursor = segment.end;
        }
    }
    bbox
}

fn visit_bbox(bbox: &mut Bbox, point: Point) {
    bbox.min_x = bbox.min_x.min(point.x);
    bbox.min_y = bbox.min_y.min(point.y);
    bbox.max_x = bbox.max_x.max(point.x);
    bbox.max_y = bbox.max_y.max(point.y);
}

fn render_topology_icon(path: ParsedPath, tint: Rgb) -> Vec<u8> {
    let mut data = blank_rgba();
    let bbox = *TOPOLOGY_BBOX;
    let bbox_width = bbox.max_x - bbox.min_x;
    let bbox_height = bbox.max_y - bbox.min_y;
    let available = TARGET_SIZE as f64 - 2.0 * TOPOLOGY_PADDING;
    let scale = (available / bbox_width).min(available / bbox_height);
    let offset_x = (TARGET_SIZE as f64 - bbox_width * scale) / 2.0 - bbox.min_x * scale;
    let offset_y = (TARGET_SIZE as f64 - bbox_height * scale) / 2.0 - bbox.min_y * scale;
    let stroke_radius = (TOPOLOGY_STROKE_WIDTH_SRC * scale) / 2.0;
    let to_canvas = |point: Point| Point {
        x: point.x * scale + offset_x,
        y: point.y * scale + offset_y,
    };

    let mut cursor = to_canvas(path.start);
    stamp_disc(&mut data, cursor.x, cursor.y, stroke_radius, tint);
    for segment in path.segments {
        let p0 = cursor;
        let p1 = to_canvas(segment.c1);
        let p2 = to_canvas(segment.c2);
        let p3 = to_canvas(segment.end);
        for sample in 1..=TOPOLOGY_SUBDIVISIONS_PER_SEGMENT {
            let t = sample as f64 / TOPOLOGY_SUBDIVISIONS_PER_SEGMENT as f64;
            let point = eval_cubic(p0, p1, p2, p3, t);
            stamp_disc(&mut data, point.x, point.y, stroke_radius, tint);
        }
        cursor = p3;
    }
    data
}

fn eval_cubic(p0: Point, p1: Point, p2: Point, p3: Point, t: f64) -> Point {
    let u = 1.0 - t;
    let uu = u * u;
    let tt = t * t;
    Point {
        x: uu * u * p0.x + 3.0 * uu * t * p1.x + 3.0 * u * tt * p2.x + tt * t * p3.x,
        y: uu * u * p0.y + 3.0 * uu * t * p1.y + 3.0 * u * tt * p2.y + tt * t * p3.y,
    }
}

fn stamp_disc(data: &mut [u8], cx: f64, cy: f64, radius: f64, tint: Rgb) {
    let min_x = ((cx - radius - 1.0).floor() as i32).max(0);
    let max_x = ((cx + radius + 1.0).ceil() as i32).min(TARGET_SIZE as i32 - 1);
    let min_y = ((cy - radius - 1.0).floor() as i32).max(0);
    let max_y = ((cy + radius + 1.0).ceil() as i32).min(TARGET_SIZE as i32 - 1);

    for py in min_y..=max_y {
        for px in min_x..=max_x {
            let dx = px as f64 + 0.5 - cx;
            let dy = py as f64 + 0.5 - cy;
            let alpha = disc_coverage(dx.hypot(dy), radius);
            if alpha > 0.0 {
                blit_pixel(data, px, py, tint, alpha);
            }
        }
    }
}

/// Does the tray icon always come back to idle once recording is over?
///
/// The animation itself is fine — every stuck-tray report traces to a lifecycle
/// edge that was never delivered, so these tests replay the REAL emitter
/// sequences (transcribed call-for-call from the sites named in each test) against
/// the same reducer the live tray runs, and assert the view the user is left
/// looking at.
#[cfg(test)]
mod lifecycle_tests {
    use super::{IndicatorSignal, IndicatorState, IndicatorView, apply_signal};

    /// Headless mirror of the live indicator: same state, same reducer, no
    /// `AppHandle` and no native paints.
    struct TrayModel {
        state: IndicatorState,
        view: IndicatorView,
    }

    impl TrayModel {
        fn new() -> Self {
            Self {
                state: IndicatorState::default(),
                view: IndicatorView::Idle,
            }
        }

        /// Mirrors `reconcile_view`: inert signals change nothing.
        fn send(&mut self, signal: IndicatorSignal) {
            let Some(next) = apply_signal(&mut self.state, signal) else {
                return;
            };
            if next == self.view {
                return;
            }
            self.view = next;
        }

        /// Mirrors `on_idle`: unconditional hard reset, repaints even when the
        /// bookkeeping already read idle.
        fn force_idle(&mut self) {
            let _ = apply_signal(&mut self.state, IndicatorSignal::Idle);
            self.view = IndicatorView::Idle;
        }
    }

    // ── the production emitters, transcribed 1:1 ────────────────────────────────
    //
    // Each method is exactly what the named source site does to the tray, so a
    // scenario below reads as the sequence of events the pipeline actually emits.
    impl TrayModel {
        /// `SttEvents::recording_start` → `tray::on_tray_recording_start`.
        fn recording_start(&mut self) {
            self.send(IndicatorSignal::RecordingStart);
        }

        /// `SttEvents::recording_stop` → `tray::on_tray_recording_stop`.
        fn recording_stop(&mut self) {
            self.send(IndicatorSignal::RecordingStop);
        }

        /// `SttEvents::transcription_start` → `tray::on_tray_transcription_start`.
        fn transcription_start(&mut self) {
            self.send(IndicatorSignal::TranscribingStart);
        }

        /// The shared terminal epilogue of `SttEvents::full_sentence`,
        /// `no_audio_detected`, `transcription_failed` and `session_aborted`:
        /// `on_tray_transcription_stop` followed by `on_tray_idle`.
        fn terminal(&mut self) {
            self.send(IndicatorSignal::TranscribingStop);
            self.force_idle();
        }

        /// `LlmCommandProcessingGuard::new` / `TransformProcessingGuard::new`.
        fn llm_guard_enter(&mut self) {
            self.send(IndicatorSignal::LlmThinkingStart);
        }

        /// The matching `Drop` impls.
        fn llm_guard_exit(&mut self) {
            self.send(IndicatorSignal::LlmThinkingStop);
        }

        /// `tray::change_tray_icon(app, TrayIconState::Idle)`.
        fn change_tray_icon_idle(&mut self) {
            self.force_idle();
        }
    }

    // ── paths that DO pair up ───────────────────────────────────────────────────

    #[test]
    fn push_to_talk_round_trip_returns_to_idle() {
        let mut tray = TrayModel::new();
        // actions/transcribe.rs: start() → stop() → async decode → full_sentence.
        tray.recording_start();
        assert_eq!(tray.view, IndicatorView::Recording);
        tray.recording_stop();
        tray.transcription_start();
        assert_eq!(tray.view, IndicatorView::Thinking);
        tray.terminal();
        tray.change_tray_icon_idle();
        assert_eq!(tray.view, IndicatorView::Idle);
    }

    #[test]
    fn llm_cleanup_between_decode_and_paste_returns_to_idle() {
        let mut tray = TrayModel::new();
        tray.recording_start();
        tray.recording_stop();
        tray.transcription_start();
        tray.llm_guard_enter();
        assert_eq!(tray.view, IndicatorView::Thinking);
        tray.llm_guard_exit();
        tray.terminal();
        assert_eq!(tray.view, IndicatorView::Idle);
    }

    #[test]
    fn silent_recording_returns_to_idle() {
        let mut tray = TrayModel::new();
        // transcribe.rs: is_silent_recording_with_mask → no_audio_detected.
        tray.recording_start();
        tray.recording_stop();
        tray.terminal();
        assert_eq!(tray.view, IndicatorView::Idle);
    }

    #[test]
    fn decode_failure_returns_to_idle() {
        let mut tray = TrayModel::new();
        // transcribe.rs: Err(err) → transcription_failed.
        tray.recording_start();
        tray.recording_stop();
        tray.transcription_start();
        tray.terminal();
        assert_eq!(tray.view, IndicatorView::Idle);
    }

    #[test]
    fn escape_cancel_mid_recording_returns_to_idle() {
        let mut tray = TrayModel::new();
        // utils::cancel_current_operation → change_tray_icon(Idle),
        // then commands/cancel.rs → session_aborted.
        tray.recording_start();
        tray.change_tray_icon_idle();
        tray.terminal();
        assert_eq!(tray.view, IndicatorView::Idle);
    }

    #[test]
    fn microphone_open_failure_never_shows_recording() {
        let mut tray = TrayModel::new();
        // transcribe.rs start(): recording_error.is_some() skips recording_start
        // entirely and paints idle.
        tray.change_tray_icon_idle();
        assert_eq!(tray.view, IndicatorView::Idle);
    }

    #[test]
    fn preview_before_pasting_returns_to_idle_before_the_pill_closes() {
        let mut tray = TrayModel::new();
        // transcribe.rs preview branch: preview_ready → full_sentence →
        // change_tray_icon(Idle). The pill outlives the tray animation by design.
        tray.recording_start();
        tray.recording_stop();
        tray.transcription_start();
        tray.terminal();
        tray.change_tray_icon_idle();
        assert_eq!(tray.view, IndicatorView::Idle);
        // preview.rs confirm_paste / cancel_preview repaint idle again; still idle.
        tray.change_tray_icon_idle();
        assert_eq!(tray.view, IndicatorView::Idle);
    }

    #[test]
    fn listen_mode_stop_returns_to_idle() {
        let mut tray = TrayModel::new();
        // listen.rs start_listen → recording_start; stop_listen_runtime →
        // recording_stop (listen never emits transcription_start).
        tray.recording_start();
        assert_eq!(tray.view, IndicatorView::Recording);
        tray.recording_stop();
        assert_eq!(tray.view, IndicatorView::Idle);
    }

    #[test]
    fn listen_mode_restart_is_idempotent_and_still_stops() {
        let mut tray = TrayModel::new();
        // LoopbackManager::start is idempotent, but start_listen emits
        // recording_start on every Ok — so a second start must not need a second stop.
        tray.recording_start();
        tray.recording_start();
        tray.recording_stop();
        assert_eq!(tray.view, IndicatorView::Idle);
    }

    #[test]
    fn transforms_hotkey_without_any_recording_returns_to_idle() {
        let mut tray = TrayModel::new();
        // transforms.rs: TransformProcessingGuard has no recording phase at all.
        tray.llm_guard_enter();
        assert_eq!(tray.view, IndicatorView::Thinking);
        tray.llm_guard_exit();
        assert_eq!(tray.view, IndicatorView::Idle);
    }

    // ── the gaps ────────────────────────────────────────────────────────────────

    #[test]
    fn a_recorder_that_closes_itself_is_rescued_by_the_stage_self_heal() {
        // The recorder closed on its own — device unplugged, WASAPI drop, stream end
        // — so `TranscribeAction::stop`, the ONLY emitter of `stt:recording-stop`,
        // never runs for this take.
        let mut stranded = TrayModel::new();
        stranded.recording_start();
        assert_eq!(
            stranded.view,
            IndicatorView::Recording,
            "nothing inside the reducer can leave Recording on its own — a caller must"
        );

        // `recover_wedged_stage` used to reset Stage::Recording → Idle silently, which
        // is what left the visualizer animating with no pipeline behind it. It now
        // routes through `reset_ui_after_silent_stage_recovery` → session_aborted.
        let mut rescued = TrayModel::new();
        rescued.recording_start();
        rescued.terminal();
        assert_eq!(rescued.view, IndicatorView::Idle);
    }

    #[test]
    fn a_panicking_pipeline_task_is_rescued_by_the_finish_guard() {
        // transcribe.rs spawns the decode task; a panic inside it unwinds past every
        // terminal emitter, so the thinking animation had nothing left to stop it.
        let mut stranded = TrayModel::new();
        stranded.recording_start();
        stranded.recording_stop();
        stranded.transcription_start();
        assert_eq!(stranded.view, IndicatorView::Thinking);

        // `FinishGuard::drop` runs during the unwind and now paints idle whenever the
        // panicking session is still the current one.
        let mut rescued = TrayModel::new();
        rescued.recording_start();
        rescued.recording_stop();
        rescued.transcription_start();
        rescued.change_tray_icon_idle();
        assert_eq!(rescued.view, IndicatorView::Idle);
    }

    #[test]
    fn a_start_that_never_became_a_recording_is_disarmed() {
        let mut tray = TrayModel::new();
        // `TranscribeAction::start` emits recording_start as soon as the mic opens
        // without error, but the coordinator's `start()` then finds the recorder
        // already closed (an open that immediately dropped, or a racing cancel) and
        // leaves the stage Idle — so no stop is ever issued for this take.
        tray.recording_start();
        assert_eq!(tray.view, IndicatorView::Recording);
        // The `staying idle` branch now disarms the tray it just armed.
        tray.change_tray_icon_idle();
        assert_eq!(tray.view, IndicatorView::Idle);
    }

    #[test]
    fn escape_is_a_reset_even_when_the_pipeline_believes_it_is_idle() {
        let mut tray = TrayModel::new();
        // Worst case: the icon is animating a take every automatic path has already
        // forgotten. `cancel_current_operation` short-circuits on
        // `!dictation_was_active`, and now repaints idle before it does.
        tray.recording_start();
        tray.change_tray_icon_idle();
        assert_eq!(tray.view, IndicatorView::Idle);
    }

    #[test]
    fn a_terminal_event_must_not_cancel_a_newer_recording() {
        let mut tray = TrayModel::new();
        // Take 1 is still decoding when take 2 starts (fast re-press: the decode is
        // async and the coordinator only serializes the recorder, not the tray).
        tray.recording_start();
        tray.recording_stop();
        tray.transcription_start();
        tray.recording_start();
        assert_eq!(tray.view, IndicatorView::Recording);

        // Take 1's terminal lands. It is an UNCONDITIONAL hard reset, so it wipes
        // take 2's live recording flag — the icon drops to idle while the mic is open.
        tray.terminal();
        assert_eq!(
            tray.view,
            IndicatorView::Idle,
            "known: a stale terminal outranks a live recording"
        );

        // Take 2 then self-heals through its own terminal, so this is transient
        // rather than sticky — the icon is wrong, not stuck.
        tray.recording_stop();
        tray.transcription_start();
        tray.terminal();
        assert_eq!(tray.view, IndicatorView::Idle);
    }

    #[test]
    fn concurrent_llm_guards_release_the_animation_early() {
        let mut tray = TrayModel::new();
        // `is_llm_thinking` is a bool, not a refcount: a transforms hotkey fired
        // while a dictation cleanup is running shares the single flag.
        tray.llm_guard_enter(); // dictation cleanup
        tray.llm_guard_enter(); // transforms hotkey — inert, flag already set
        tray.llm_guard_exit(); // transforms finishes first
        assert_eq!(
            tray.view,
            IndicatorView::Idle,
            "known: the first exit clears the flag for both"
        );
        tray.llm_guard_exit(); // dictation cleanup finishes — inert
        assert_eq!(tray.view, IndicatorView::Idle, "errs idle, never stuck");
    }

    // ── invariants of the reducer itself ────────────────────────────────────────

    #[test]
    fn idle_recovers_from_every_reachable_flag_combination() {
        // Exhaustive over the eight flag combinations: the hard reset is the one
        // lever every self-heal path relies on, so it must be total.
        for recording in [false, true] {
            for transcribing in [false, true] {
                for llm in [false, true] {
                    let mut tray = TrayModel::new();
                    if recording {
                        tray.recording_start();
                    }
                    if transcribing {
                        tray.transcription_start();
                    }
                    if llm {
                        tray.llm_guard_enter();
                    }
                    tray.force_idle();
                    assert_eq!(
                        tray.view,
                        IndicatorView::Idle,
                        "stuck from recording={recording} transcribing={transcribing} llm={llm}"
                    );
                    assert!(!tray.state.is_recording);
                    assert!(!tray.state.is_transcribing);
                    assert!(!tray.state.is_llm_thinking);
                }
            }
        }
    }

    #[test]
    fn every_signal_sequence_up_to_length_four_ends_idle_after_a_terminal() {
        const ALPHABET: [IndicatorSignal; 6] = [
            IndicatorSignal::RecordingStart,
            IndicatorSignal::RecordingStop,
            IndicatorSignal::TranscribingStart,
            IndicatorSignal::TranscribingStop,
            IndicatorSignal::LlmThinkingStart,
            IndicatorSignal::LlmThinkingStop,
        ];

        // Brute force every ordering — including the malformed ones a dropped or
        // duplicated event produces — and assert the terminal always wins.
        let mut sequences: Vec<Vec<IndicatorSignal>> = vec![Vec::new()];
        for _ in 0..4 {
            let mut next = Vec::new();
            for sequence in &sequences {
                for signal in ALPHABET {
                    let mut extended = sequence.clone();
                    extended.push(signal);
                    next.push(extended);
                }
            }
            sequences.extend(next);
        }

        for sequence in &sequences {
            let mut tray = TrayModel::new();
            for signal in sequence {
                tray.send(*signal);
            }
            tray.force_idle();
            assert_eq!(
                tray.view,
                IndicatorView::Idle,
                "sequence left the tray stuck: {sequence:?}"
            );
        }
    }

    #[test]
    fn recording_outranks_thinking_while_the_microphone_is_open() {
        let mut tray = TrayModel::new();
        // Realtime dictation decodes WHILE recording; the icon must stay on the
        // visualizer rather than flipping to the topology animation mid-take.
        tray.recording_start();
        tray.transcription_start();
        assert_eq!(tray.view, IndicatorView::Recording);
        tray.llm_guard_enter();
        assert_eq!(tray.view, IndicatorView::Recording);
        // Once the mic closes, the still-running decode takes over.
        tray.recording_stop();
        assert_eq!(tray.view, IndicatorView::Thinking);
        tray.transcription_stop_then_llm_exit();
        assert_eq!(tray.view, IndicatorView::Idle);
    }

    impl TrayModel {
        fn transcription_stop_then_llm_exit(&mut self) {
            self.send(IndicatorSignal::TranscribingStop);
            self.send(IndicatorSignal::LlmThinkingStop);
        }
    }

    #[test]
    fn an_unpaired_stop_is_inert_rather_than_corrupting() {
        let mut tray = TrayModel::new();
        // Duplicate releases and double terminals are routine; they must not push
        // the flag set negative or leave a phantom view behind.
        tray.recording_stop();
        tray.send(IndicatorSignal::TranscribingStop);
        tray.llm_guard_exit();
        assert_eq!(tray.view, IndicatorView::Idle);

        tray.recording_start();
        tray.recording_stop();
        tray.recording_stop();
        assert_eq!(tray.view, IndicatorView::Idle);
    }
}

/// A panic under the indicator mutex must not freeze the tray for the rest of the
/// process. Exercises the REAL static, not the headless model.
#[cfg(test)]
mod poisoning_tests {
    use super::{IndicatorSignal, IndicatorView, TRAY_INDICATOR, apply_signal, derive_view};
    use crate::winstt::sync_ext::MutexExt;

    #[test]
    fn a_poisoned_lock_still_reconciles_back_to_idle() {
        TRAY_INDICATOR.state.lock_recover().is_recording = true;

        let poisoner = std::thread::spawn(|| {
            let _guard = TRAY_INDICATOR.state.lock_recover();
            panic!("simulated panic while the tray state is locked");
        });
        assert!(
            poisoner.join().is_err(),
            "the poisoner should have panicked"
        );

        // Before `lock_recover`, every entry point here took `if let Ok(..) = lock()`
        // and silently did nothing from this point on — the tray stayed on the
        // recording animation until restart.
        let mut state = TRAY_INDICATOR.state.lock_recover();
        assert!(state.is_recording, "the value must survive the poisoning");
        let view = apply_signal(&mut state, IndicatorSignal::Idle);
        assert_eq!(view, Some(IndicatorView::Idle));
        assert_eq!(derive_view(&state), IndicatorView::Idle);
        state.current_view = IndicatorView::Idle;
    }
}

#[cfg(test)]
mod concurrency_tests {
    use super::PaintGate;
    use std::sync::Mutex;

    #[test]
    fn stale_animation_cannot_paint_after_new_static_generation() {
        let gate = PaintGate::new();
        let painted = Mutex::new(Vec::new());
        let animation_generation = gate.advance_generation();

        let static_generation = gate.advance_and_paint(|_| {
            painted.lock().expect("paint log should lock").push("idle");
        });

        assert!(!gate.paint_if_current(animation_generation, |_| {
            painted
                .lock()
                .expect("paint log should lock")
                .push("stale animation");
        }));
        assert_eq!(gate.current_generation(), static_generation);
        assert_eq!(
            *painted.lock().expect("paint log should lock"),
            vec!["idle"]
        );
    }
}
