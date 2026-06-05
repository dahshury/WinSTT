use crate::winstt::commands::settings;
use crate::winstt::settings_schema::{GeneralSettings, VisualizerAuraShape, VisualizerType};
use once_cell::sync::Lazy;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
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
const BAR_TICK_MS: u64 = 50;
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
        }
    }
}

struct TrayIndicator {
    state: Mutex<IndicatorState>,
    generation: AtomicU64,
}

static TRAY_INDICATOR: Lazy<TrayIndicator> = Lazy::new(|| TrayIndicator {
    state: Mutex::new(IndicatorState::default()),
    generation: AtomicU64::new(0),
});

pub(crate) fn set_visualizer_style_from_general(general: &GeneralSettings) {
    if let Ok(mut state) = TRAY_INDICATOR.state.lock() {
        state.config = VisualizerConfig::from_general(general);
    }
}

pub(crate) fn sync_visualizer_style_from_settings(app: &AppHandle) {
    let general = settings::read_settings(app).general;
    set_visualizer_style_from_general(&general);
}

pub(crate) fn on_recording_start(app: &AppHandle) {
    sync_visualizer_style_from_settings(app);
    if let Ok(mut state) = TRAY_INDICATOR.state.lock() {
        state.is_recording = true;
        state.raw_level = 0.0;
        state.peak = PEAK_FLOOR;
        state.session_start = Instant::now();
    }
    reconcile_view(app);
}

pub(crate) fn on_recording_stop(app: &AppHandle) {
    if let Ok(mut state) = TRAY_INDICATOR.state.lock() {
        if !state.is_recording {
            return;
        }
        state.is_recording = false;
        state.raw_level = 0.0;
        state.peak = PEAK_FLOOR;
    }
    reconcile_view(app);
}

pub(crate) fn on_audio_level(level: f32) {
    if let Ok(mut state) = TRAY_INDICATOR.state.lock() {
        if state.is_recording {
            state.raw_level = (level as f64).clamp(0.0, 1.0);
        }
    }
}

pub(crate) fn on_transcribing_start(app: &AppHandle) {
    if let Ok(mut state) = TRAY_INDICATOR.state.lock() {
        if state.is_transcribing {
            return;
        }
        if !(state.is_llm_thinking || state.is_recording) {
            state.thinking_start = Instant::now();
        }
        state.is_transcribing = true;
    }
    reconcile_view(app);
}

pub(crate) fn on_transcribing_stop(app: &AppHandle) {
    if let Ok(mut state) = TRAY_INDICATOR.state.lock() {
        if !state.is_transcribing {
            return;
        }
        state.is_transcribing = false;
    }
    reconcile_view(app);
}

pub(crate) fn on_llm_thinking_start(app: &AppHandle) {
    if let Ok(mut state) = TRAY_INDICATOR.state.lock() {
        if state.is_llm_thinking {
            return;
        }
        if !(state.is_transcribing || state.is_llm_thinking) {
            state.thinking_start = Instant::now();
        }
        state.is_llm_thinking = true;
    }
    reconcile_view(app);
}

pub(crate) fn on_llm_thinking_stop(app: &AppHandle) {
    if let Ok(mut state) = TRAY_INDICATOR.state.lock() {
        if !state.is_llm_thinking {
            return;
        }
        state.is_llm_thinking = false;
    }
    reconcile_view(app);
}

pub(crate) fn on_idle(app: &AppHandle) {
    if let Ok(mut state) = TRAY_INDICATOR.state.lock() {
        state.is_recording = false;
        state.is_transcribing = false;
        state.is_llm_thinking = false;
        state.raw_level = 0.0;
        state.peak = PEAK_FLOOR;
        state.current_view = IndicatorView::Idle;
    }
    TRAY_INDICATOR.generation.fetch_add(1, Ordering::SeqCst);
    crate::tray::paint_static_tray_icon(app, crate::tray::TrayIconState::Idle);
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

fn reconcile_view(app: &AppHandle) {
    let mut next = IndicatorView::Idle;
    let mut changed = false;
    if let Ok(mut state) = TRAY_INDICATOR.state.lock() {
        next = derive_view(&state);
        changed = next != state.current_view;
        if changed {
            state.current_view = next;
        }
    }

    if !changed {
        return;
    }

    let generation = TRAY_INDICATOR.generation.fetch_add(1, Ordering::SeqCst) + 1;
    match next {
        IndicatorView::Idle => {
            crate::tray::paint_static_tray_icon(app, crate::tray::TrayIconState::Idle);
        }
        IndicatorView::Recording | IndicatorView::Thinking => {
            let interval = if next == IndicatorView::Thinking {
                THINK_TICK_MS
            } else {
                BAR_TICK_MS
            };
            render_frame_for_generation(app, generation);
            spawn_tick(app.clone(), generation, Duration::from_millis(interval));
        }
    }
}

fn spawn_tick(app: AppHandle, generation: u64, interval: Duration) {
    thread::spawn(move || loop {
        thread::sleep(interval);
        if TRAY_INDICATOR.generation.load(Ordering::SeqCst) != generation {
            break;
        }
        render_frame_for_generation(&app, generation);
    });
}

fn render_frame_for_generation(app: &AppHandle, generation: u64) {
    if TRAY_INDICATOR.generation.load(Ordering::SeqCst) != generation {
        return;
    }

    let rgba = {
        let mut state = match TRAY_INDICATOR.state.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        match state.current_view {
            IndicatorView::Recording => {
                let raw_level = state.raw_level;
                let next = compute_amplified(raw_level, state.peak);
                state.peak = next.peak;
                let time = state.session_start.elapsed().as_secs_f64();
                render_visualizer_frame(state.config, next.amplified, raw_level, time)
            }
            IndicatorView::Thinking => {
                let elapsed = state.thinking_start.elapsed().as_millis() % TOPOLOGY_DURATION_MS;
                let t_raw = elapsed as f64 / TOPOLOGY_DURATION_MS as f64;
                let path = interpolate_topology(t_raw);
                render_topology_icon(path, TRAY_INK)
            }
            IndicatorView::Idle => return,
        }
    };

    if TRAY_INDICATOR.generation.load(Ordering::SeqCst) != generation {
        return;
    }
    set_icon_on_tray(app, rgba);
}

fn set_icon_on_tray(app: &AppHandle, rgba: Vec<u8>) {
    let Some(tray) = app.try_state::<TrayIcon>() else {
        return;
    };
    let _ = tray.set_icon(Some(Image::new_owned(rgba, TARGET_SIZE, TARGET_SIZE)));
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
