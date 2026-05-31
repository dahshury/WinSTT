import { type NativeImage, nativeImage, type Tray } from "electron";
import { PNG } from "pngjs";
import { dbg } from "./debug-log";

/** The tray icon is intentionally monochrome white — it sits inside Windows'
 *  system tray which has no fixed background, so a single neutral color is
 *  more legible across themes than the per-mode accent the pill uses. The
 *  pill itself stays colored.
 *
 *  Scope: tray ONLY. The BrowserWindow / taskbar icon is intentionally left
 *  untouched — the static app icon set at window creation stays put through
 *  recording and thinking states (only the tray animates). */
const TRAY_INK: readonly [number, number, number] = [255, 255, 255];

// Avoid a runtime import dependency on tray-state for the restore-after-thinking
// case — main.ts wires it in via setReapplyTrayImage at boot.
let reapplyTrayImageFn: (() => void) | null = null;

export function setReapplyTrayImage(fn: (() => void) | null): void {
	reapplyTrayImageFn = fn;
}

// ── Bar visualizer parameters ────────────────────────────────────────
//
// "Recording" mirrors the pill's bar visualizer (frontend/src/features/
// audio-visualizer `size="icon"`): 5 bars, centered vertically, fully
// rounded ends. The pill math is ported below verbatim from
// use-multiband-volume.ts so the tray icon undulates the same way.

/** Output canvas size. Windows downscales for the tray cell as needed; a
 *  larger source keeps the icon sharp on HiDPI displays (150–200% scaling).
 *  48 is the sweet spot — bigger sizes don't change the visual size on
 *  screen, only sharpness, and 48 is still cheap to rasterize per frame. */
const TARGET_SIZE = 48;

/** Bar count — matches the pill's `size="icon"` default (resolveBarCount). */
const BAR_COUNT = 5;
/** Bar/gap dimensions chosen so 5 bars + 4 gaps fill the canvas ~98%, with
 *  the bar-to-gap ratio (≈ 2.3:1) staying within sight of the pill's 2:1. */
const BAR_WIDTH = 7;
const BAR_GAP = 3;
const VERTICAL_MARGIN = 2;

/** Update interval in ms — ~20 fps for bars, 30 fps for topology morph. */
const BAR_TICK_MS = 50;
const THINK_TICK_MS = 33;

const PEAK_FLOOR = 0.1;
const PEAK_DECAY = 0.99;

// ── Topology (thinking) animation ────────────────────────────────────
//
// Ports the SVG path-morph from frontend/src/shared/ui/thinking-indicator/
// ThinkingIndicator.tsx: a 6-second easeInOut loop morphing through
// CIRCLE_A → INFINITY → CIRCLE_B → INFINITY → CIRCLE_A. Each path has
// identical structure (1 MoveTo + 4 CubicBezier), so framer-motion's
// number-by-number d-attribute interpolation translates cleanly to a
// component-wise lerp of parsed control points.

const TOPOLOGY_DURATION_MS = 6000;
const TOPOLOGY_STROKE_WIDTH_SRC = 1.5;
const TOPOLOGY_SUBDIVISIONS_PER_SEGMENT = 32;
/** Padding around the content bbox in canvas pixels. Tighter than half the
 *  stroke width would let the rounded caps clip at the edges. */
const TOPOLOGY_PADDING = 2;

const CIRCLE_A =
	"M 12 8 C 14.21 8 16 9.79 16 12 C 16 14.21 14.21 16 12 16 C 9.79 16 8 14.21 8 12 C 8 9.79 9.79 8 12 8 Z";
const INFINITY_PATH =
	"M 12 12 C 14 8.5 19 8.5 19 12 C 19 15.5 14 15.5 12 12 C 10 8.5 5 8.5 5 12 C 5 15.5 10 15.5 12 12 Z";
const CIRCLE_B =
	"M 12 16 C 14.21 16 16 14.21 16 12 C 16 9.79 14.21 8 12 8 C 9.79 8 8 9.79 8 12 C 8 14.21 9.79 16 12 16 Z";

// ── Module state ─────────────────────────────────────────────────────
let trayRef: Tray | null = null;
let baseIcon: NativeImage | null = null;

type IndicatorView = "idle" | "recording" | "thinking";
let currentView: IndicatorView = "idle";

let isRecording = false;
let isTranscribing = false;
let isLlmThinking = false;

let rawLevel = 0;
let peak = PEAK_FLOOR;
let sessionStartMs = 0;
let thinkingStartMs = 0;

let tickHandle: ReturnType<typeof setInterval> | null = null;
let tickIntervalMs = BAR_TICK_MS;

// ── Visualizer style (mirrors the renderer's chosen visualizerType) ──
//
// Historically the tray only ever drew bars. The renderer's pill
// (features/audio-visualizer) renders whichever style the user picked, so the
// tray now honors the same choice. main.ts pushes these in via
// setTrayVisualizerStyle() — once on boot and again on every
// store.onDidChange("general"). Counts are clamped to stay legible at the 48px
// tray size; unknown/missing values fall back to the shipped defaults.
type VisualizerStyle = "bar" | "grid" | "radial" | "wave" | "aura";
const VISUALIZER_STYLES: readonly VisualizerStyle[] = ["bar", "grid", "radial", "wave", "aura"];

let visualizerStyle: VisualizerStyle = "bar";
let gridRows = 5;
let gridColumns = 5;
let radialDotCount = 24;
let waveLineWidth = 2;
let auraShape: "circle" | "line" = "circle";
let auraBlur = 0.2;

// ── Pill math (ported 1:1) ───────────────────────────────────────────

export function computeAmplified(
	audioLevel: number,
	prevPeak: number
): { amplified: number; peak: number } {
	const nextPeak = Math.max(PEAK_FLOOR, audioLevel, prevPeak * PEAK_DECAY);
	const amplified = Math.sqrt(Math.min(1, Math.max(0, audioLevel) / nextPeak));
	return { peak: nextPeak, amplified };
}

export function computeBandValue(
	bandIndex: number,
	bands: number,
	time: number,
	amplified: number
): number {
	const phase = (bandIndex / bands) * Math.PI * 2;
	const v1 = 0.3 * Math.sin(time * 3.7 + phase);
	const v2 = 0.2 * Math.sin(time * 7.3 + phase * 2.5);
	const v3 = 0.1 * Math.sin(time * 13.1 + phase * 0.7);
	return Math.max(0.05, Math.min(1, amplified * (0.8 + v1 + v2 + v3)));
}

// ── Public API ───────────────────────────────────────────────────────

export function initRecordingIndicator(tray: Tray, iconPath: string): void {
	trayRef = tray;
	baseIcon = nativeImage.createFromPath(iconPath);

	if (baseIcon.isEmpty()) {
		dbg("indicator", "Base icon is empty — indicator will skip revert step");
	}
	dbg("indicator", `Initialized: bars=${BAR_COUNT} target=${TARGET_SIZE}x${TARGET_SIZE}`);
}

function clampInt(value: unknown, lo: number, hi: number, fallback: number): number {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
	return Math.max(lo, Math.min(hi, n));
}

function asVisualizerStyle(value: unknown): VisualizerStyle {
	return typeof value === "string" && (VISUALIZER_STYLES as readonly string[]).includes(value)
		? (value as VisualizerStyle)
		: "bar";
}

/**
 * Sync the tray visualizer to the renderer's chosen `visualizerType` (and its
 * per-shape knobs). Called from main.ts with the raw `general` settings object
 * on boot and on every `store.onDidChange("general")`. Counts are clamped to
 * stay legible at the 48px tray icon; unknown/missing values fall back to the
 * shipped defaults, so a partial object is safe.
 */
export function setTrayVisualizerStyle(general: Record<string, unknown> | null | undefined): void {
	const g = general ?? {};
	visualizerStyle = asVisualizerStyle(g.visualizerType);
	gridRows = clampInt(g.visualizerGridRows, 3, 8, 5);
	gridColumns = clampInt(g.visualizerGridColumns, 3, 8, 5);
	radialDotCount = clampInt(g.visualizerRadialDotCount, 6, 24, 24);
	waveLineWidth = clampInt(g.visualizerWaveLineWidth, 1, 6, 2);
	auraShape = g.visualizerAuraShape === "line" ? "line" : "circle";
	auraBlur = clampInt(g.visualizerAuraBlur, 0, 100, 20) / 100;
}

export function onRecordingStart(): void {
	dbg("indicator", "Recording started");
	isRecording = true;
	rawLevel = 0;
	peak = PEAK_FLOOR;
	sessionStartMs = nowMs();
	reconcileView();
}

export function onRecordingStop(): void {
	if (!isRecording) {
		return;
	}
	dbg("indicator", "Recording stopped");
	isRecording = false;
	rawLevel = 0;
	peak = PEAK_FLOOR;
	reconcileView();
}

export function onAudioLevel(level: number): void {
	if (!isRecording) {
		return;
	}
	rawLevel = Math.max(0, Math.min(1, level));
}

/** STT model began processing buffered audio. Shows the thinking-indicator
 *  topology morph until onTranscribingStop or until the recording mode wins. */
export function onTranscribingStart(): void {
	if (isTranscribing) {
		return;
	}
	dbg("indicator", "Transcribing started");
	isTranscribing = true;
	if (!(isLlmThinking || isRecording)) {
		thinkingStartMs = nowMs();
	}
	reconcileView();
}

export function onTranscribingStop(): void {
	if (!isTranscribing) {
		return;
	}
	dbg("indicator", "Transcribing stopped");
	isTranscribing = false;
	reconcileView();
}

/** LLM post-processing began. Keeps (or starts) the thinking topology
 *  morph. Shares a single timeline with the transcribing phase so the
 *  morph doesn't reset between STT-done and LLM-start. */
export function onLlmThinkingStart(): void {
	if (isLlmThinking) {
		return;
	}
	dbg("indicator", "LLM thinking started");
	if (!(isTranscribing || isLlmThinking)) {
		thinkingStartMs = nowMs();
	}
	isLlmThinking = true;
	reconcileView();
}

export function onLlmThinkingStop(): void {
	if (!isLlmThinking) {
		return;
	}
	dbg("indicator", "LLM thinking stopped");
	isLlmThinking = false;
	reconcileView();
}

export function cleanupRecordingIndicator(): void {
	stopTick();
	trayRef = null;
	baseIcon = null;
	isRecording = false;
	isTranscribing = false;
	isLlmThinking = false;
	rawLevel = 0;
	peak = PEAK_FLOOR;
	currentView = "idle";
}

// ── View state machine ───────────────────────────────────────────────

function deriveView(): IndicatorView {
	if (isRecording) {
		return "recording";
	}
	if (isTranscribing || isLlmThinking) {
		return "thinking";
	}
	return "idle";
}

function reconcileView(): void {
	const next = deriveView();
	if (next === currentView) {
		// Same view: ensure the animation tick is alive (covers a redundant
		// on*Start that arrives after the tick was somehow torn down).
		if (next !== "idle" && tickHandle === null) {
			startTick();
		}
		return;
	}
	const previous = currentView;
	currentView = next;

	if (next === "idle") {
		enterIdle(previous);
		return;
	}
	enterActiveView(next);
}

/** Tear down the animation tick and restore the static tray image when no
 *  view wants the tray anymore. */
function enterIdle(previous: IndicatorView): void {
	stopTick();
	// Recording → idle has always reverted to the legacy base icon (tray-state
	// then layers its themed PNG on top via a microtask). For thinking → idle,
	// the static tray PNG is already current (fullSentence/llm-end already
	// passed through tray-state), so we just re-apply that to wipe the
	// morphing topology we last painted.
	if (previous === "recording") {
		revertIcons();
	} else {
		reapplyTrayImageFn?.();
	}
}

/** Install (or re-cadence) the animation tick for an active view and paint
 *  its first frame immediately so the swap isn't delayed by one interval. */
function enterActiveView(next: Exclude<IndicatorView, "idle">): void {
	const wantedInterval = next === "thinking" ? THINK_TICK_MS : BAR_TICK_MS;
	if (tickHandle !== null && tickIntervalMs !== wantedInterval) {
		stopTick();
	}
	startTick(wantedInterval);
	renderFrame();
}

// ── Render tick ──────────────────────────────────────────────────────

function nowMs(): number {
	return Date.now();
}

function startTick(intervalMs?: number): void {
	if (tickHandle !== null) {
		return;
	}
	tickIntervalMs = intervalMs ?? (currentView === "thinking" ? THINK_TICK_MS : BAR_TICK_MS);
	tickHandle = setInterval(renderFrame, tickIntervalMs);
}

function stopTick(): void {
	if (tickHandle !== null) {
		clearInterval(tickHandle);
		tickHandle = null;
	}
}

function renderFrame(): void {
	if (currentView === "recording") {
		renderRecordingFrame();
		return;
	}
	if (currentView === "thinking") {
		renderThinkingFrame();
	}
}

function renderRecordingFrame(): void {
	const next = computeAmplified(rawLevel, peak);
	peak = next.peak;
	const time = (nowMs() - sessionStartMs) / 1000;
	const icon = renderVisualizerFrame(next.amplified, rawLevel, time);
	setIconOnTray(icon);
}

/** Rasterize one recording-view frame in whichever style the user picked. The
 *  thinking view stays the topology morph regardless of style. */
function renderVisualizerFrame(amplified: number, level: number, time: number): NativeImage {
	switch (visualizerStyle) {
		case "grid":
			return renderGridIcon(amplified, time, TRAY_INK);
		case "radial":
			return renderRadialIcon(amplified, time, TRAY_INK);
		case "wave":
			return renderWaveIcon(level, time, TRAY_INK);
		case "aura":
			return renderAuraIcon(level, time, TRAY_INK);
		default:
			return renderBarsIcon(computeBands(BAR_COUNT, time, amplified), TRAY_INK);
	}
}

function renderThinkingFrame(): void {
	const elapsed = (nowMs() - thinkingStartMs) % TOPOLOGY_DURATION_MS;
	const tRaw = elapsed / TOPOLOGY_DURATION_MS;
	const path = interpolateTopology(tRaw);
	const icon = renderTopologyIcon(path, TRAY_INK);
	setIconOnTray(icon);
}

// ── Bar rasterization ───────────────────────────────────────────────

type RGB = readonly [number, number, number];

export function renderBarsIcon(bands: readonly number[], tint: RGB): NativeImage {
	const png = new PNG({ width: TARGET_SIZE, height: TARGET_SIZE });
	png.data.fill(0);

	const totalWidth = BAR_COUNT * BAR_WIDTH + (BAR_COUNT - 1) * BAR_GAP;
	const startX = Math.floor((TARGET_SIZE - totalWidth) / 2);
	const maxBarHeight = TARGET_SIZE - VERTICAL_MARGIN * 2;
	const cy = TARGET_SIZE / 2;

	for (let i = 0; i < BAR_COUNT; i++) {
		const band = clamp01(bands[i] ?? 0.05);
		const h = Math.max(BAR_WIDTH, Math.round(band * maxBarHeight));
		const x0 = startX + i * (BAR_WIDTH + BAR_GAP);
		drawRoundedBar(png.data, x0, cy, BAR_WIDTH, h, tint);
	}

	const buf = PNG.sync.write(png);
	return nativeImage.createFromBuffer(buf);
}

// ── Style rasterizers (grid / radial / wave / aura) ──────────────────
//
// Each ports the *speaking-state* math from the matching renderer component
// (features/audio-visualizer/ui/AudioVisualizer*.tsx) into a 48px monochrome
// PNG. Grid and radial are pure DOM math and port 1:1; wave and aura are WebGL
// shaders, approximated here as a 2D oscilloscope line and a soft pulsing SDF
// blob — faithful enough to read as the chosen style at tray size.

/** Per-band volume series shared by every style. Ported from
 *  use-multiband-volume's `computeBandValue`. */
function computeBands(count: number, time: number, amplified: number): number[] {
	const bands: number[] = [];
	for (let i = 0; i < count; i++) {
		bands.push(computeBandValue(i, count, time, amplified));
	}
	return bands;
}

/** Stamp an antialiased filled disc, scaling coverage by `intensity` (0–1).
 *  Used for the grid's dim/bright cells and the radial dots. */
function drawDot(
	data: Buffer,
	cx: number,
	cy: number,
	r: number,
	tint: RGB,
	intensity: number
): void {
	const minX = Math.max(0, Math.floor(cx - r - 1));
	const maxX = Math.min(TARGET_SIZE - 1, Math.ceil(cx + r + 1));
	const minY = Math.max(0, Math.floor(cy - r - 1));
	const maxY = Math.min(TARGET_SIZE - 1, Math.ceil(cy + r + 1));
	for (let py = minY; py <= maxY; py++) {
		for (let px = minX; px <= maxX; px++) {
			const dx = px + 0.5 - cx;
			const dy = py + 0.5 - cy;
			const alpha = Math.round(discCoverage(Math.hypot(dx, dy), r) * intensity);
			if (alpha > 0) {
				blitPixel(data, px, py, tint, alpha);
			}
		}
	}
}

/** Ported verbatim from AudioVisualizerGrid.isSpeakingCellHighlighted: a cell
 *  lights up when its column's band clears the row's distance-from-middle
 *  threshold, giving a volume-driven per-column bar graph. */
export function isSpeakingCellHighlighted(
	index: number,
	columnCount: number,
	rowCount: number,
	volumeBands: readonly number[]
): boolean {
	const y = Math.floor(index / columnCount);
	const rowMidPoint = Math.floor(rowCount / 2);
	const volumeChunks = 1 / (rowMidPoint + 1);
	const distanceToMid = Math.abs(rowMidPoint - y);
	const threshold = distanceToMid * volumeChunks;
	return (volumeBands[index % columnCount] ?? 0) >= threshold;
}

/** 10%-opacity baseline for un-highlighted grid cells (renderer's `bg-current/10`). */
const GRID_DIM_INTENSITY = 0.18;
const GRID_MARGIN = 5;

export function renderGridIcon(amplified: number, time: number, tint: RGB): NativeImage {
	const png = new PNG({ width: TARGET_SIZE, height: TARGET_SIZE });
	png.data.fill(0);

	const cols = gridColumns;
	const rows = gridRows;
	const bands = computeBands(cols, time, amplified);
	const usable = TARGET_SIZE - GRID_MARGIN * 2;
	const cellW = usable / cols;
	const cellH = usable / rows;
	const dotR = Math.max(1, Math.min(cellW, cellH) * 0.32);

	for (let index = 0; index < rows * cols; index++) {
		const col = index % cols;
		const row = Math.floor(index / cols);
		const cx = GRID_MARGIN + (col + 0.5) * cellW;
		const cy = GRID_MARGIN + (row + 0.5) * cellH;
		const intensity = isSpeakingCellHighlighted(index, cols, rows, bands) ? 1 : GRID_DIM_INTENSITY;
		drawDot(png.data, cx, cy, dotR, tint, intensity);
	}

	return nativeImage.createFromBuffer(PNG.sync.write(png));
}

const RADIAL_INNER = 7;
const RADIAL_OUTER = 21;
const RADIAL_DOT_R = 1.8;

export function renderRadialIcon(amplified: number, time: number, tint: RGB): NativeImage {
	const png = new PNG({ width: TARGET_SIZE, height: TARGET_SIZE });
	png.data.fill(0);

	const count = radialDotCount;
	const bands = computeBands(count, time, amplified);
	const cx = TARGET_SIZE / 2;
	const cy = TARGET_SIZE / 2;

	for (let i = 0; i < count; i++) {
		// Start at 12 o'clock, sweep clockwise so the ring reads upright.
		const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
		const band = clamp01(bands[i] ?? 0.05);
		const radius = RADIAL_INNER + band * (RADIAL_OUTER - RADIAL_INNER);
		const px = cx + Math.cos(angle) * radius;
		const py = cy + Math.sin(angle) * radius;
		drawDot(png.data, px, py, RADIAL_DOT_R, tint, 1);
	}

	return nativeImage.createFromBuffer(PNG.sync.write(png));
}

// Speaking-branch wave params from use-wave-animator.ts. `speaking` falls to the
// switch's default case, so uSpeed = DEFAULT_SPEED * 2 = 10.
const WAVE_SPEED = 10;
const WAVE_MAX_AMPLITUDE = 0.4;
const WAVE_AMPLITUDE_BASE = 0.06;
const WAVE_AMPLITUDE_GAIN = 0.9;

export function renderWaveIcon(level: number, time: number, tint: RGB): NativeImage {
	const png = new PNG({ width: TARGET_SIZE, height: TARGET_SIZE });
	png.data.fill(0);

	const lvl = clamp01(level);
	const amplitude = Math.min(
		WAVE_MAX_AMPLITUDE,
		WAVE_AMPLITUDE_BASE + WAVE_AMPLITUDE_GAIN * Math.sqrt(lvl)
	);
	const frequency = 20 + 60 * lvl;
	const r = Math.max(1, waveLineWidth) / 2;

	// Oscilloscope line ported from the wave shader:
	//   y = 0.5 + sin(relX*freq + t*speed) * amp * bell(relX)
	// sampled at 3× pixel density so the stroke stays continuous at high freq.
	const samples = TARGET_SIZE * 3;
	for (let s = 0; s <= samples; s++) {
		const uvx = s / samples;
		const relX = uvx - 0.5;
		const normDist = Math.min(1, Math.abs(relX) * 2);
		const bell = Math.cos((normDist * Math.PI) / 4) ** 16;
		const wave = Math.sin(relX * frequency + time * WAVE_SPEED) * amplitude * bell;
		const px = uvx * (TARGET_SIZE - 1);
		const py = (0.5 + wave) * (TARGET_SIZE - 1);
		drawDot(png.data, px, py, r, tint, 1);
	}

	return nativeImage.createFromBuffer(PNG.sync.write(png));
}

export function renderAuraIcon(level: number, time: number, tint: RGB): NativeImage {
	const png = new PNG({ width: TARGET_SIZE, height: TARGET_SIZE });
	png.data.fill(0);

	const lvl = clamp01(level);
	// uScale speaking branch from use-aura-animator.ts: 0.2 + 0.2 * level. The
	// WebGL aura animates turbulence over time; here a gentle ±4 % breathing
	// pulse keeps the blob alive at a steady level without a shader.
	const breathe = 1 + 0.04 * Math.sin(time * 2.2);
	const scale = (0.2 + 0.2 * lvl) * breathe;
	const edge = 2 + auraBlur * 6; // soft glow falloff, widened by the blur knob
	const cx = TARGET_SIZE / 2;
	const cy = TARGET_SIZE / 2;

	if (auraShape === "line") {
		const halfLen = Math.min(TARGET_SIZE / 2 - 3, 4 + scale * TARGET_SIZE);
		paintSoftField(png.data, tint, edge, 3, (px, py) => {
			const qx = Math.max(cx - halfLen, Math.min(cx + halfLen, px));
			return Math.hypot(px - qx, py - cy);
		});
	} else {
		const radius = scale * TARGET_SIZE;
		paintSoftField(png.data, tint, edge, radius, (px, py) => Math.hypot(px - cx, py - cy));
	}

	return nativeImage.createFromBuffer(PNG.sync.write(png));
}

/** Fill pixels within `core` of the shape at full intensity, fading to zero
 *  over `edge` px beyond it — the soft pulsing blob/bar that stands in for the
 *  WebGL aura at tray size. */
function paintSoftField(
	data: Buffer,
	tint: RGB,
	edge: number,
	core: number,
	distanceAt: (px: number, py: number) => number
): void {
	for (let py = 0; py < TARGET_SIZE; py++) {
		for (let px = 0; px < TARGET_SIZE; px++) {
			const d = distanceAt(px + 0.5, py + 0.5);
			let intensity: number;
			if (d <= core) {
				intensity = 1;
			} else if (d >= core + edge) {
				intensity = 0;
			} else {
				intensity = 1 - (d - core) / edge;
			}
			if (intensity > 0) {
				blitPixel(data, px, py, tint, Math.round(255 * intensity));
			}
		}
	}
}

function clamp01(v: number): number {
	if (Number.isNaN(v)) {
		return 0;
	}
	return Math.max(0, Math.min(1, v));
}

function drawRoundedBar(
	data: Buffer,
	x0: number,
	cy: number,
	w: number,
	h: number,
	tint: RGB
): void {
	const r = w / 2;
	const y0 = cy - h / 2;
	const y1 = cy + h / 2;

	for (let py = 0; py < TARGET_SIZE; py++) {
		// Skip scanlines the bar doesn't intersect (above its top or at/below
		// its bottom). The `py + 1 <= y0` test keeps a partially-covered top row.
		if (py + 1 <= y0 || py >= y1) {
			continue;
		}
		paintBarScanline(data, x0, py, y0, y1, r, w, tint);
	}
}

/** Paint one horizontal scanline of a rounded bar, antialiasing the rounded
 *  caps via capCoverage. Split out of drawRoundedBar to keep the per-pixel
 *  clamp/coverage branches out of the row loop. */
function paintBarScanline(
	data: Buffer,
	x0: number,
	py: number,
	y0: number,
	y1: number,
	r: number,
	w: number,
	tint: RGB
): void {
	for (let dx = 0; dx < w; dx++) {
		const px = x0 + dx;
		if (px < 0 || px >= TARGET_SIZE) {
			continue;
		}
		const alpha = capCoverage(px - x0, py, x0, y0, y1, r, w);
		if (alpha <= 0) {
			continue;
		}
		blitPixel(data, px, py, tint, alpha);
	}
}

function capCoverage(
	localX: number,
	py: number,
	_x0: number,
	y0: number,
	y1: number,
	r: number,
	w: number
): number {
	const localCenterX = w / 2;
	const dx = localX + 0.5 - localCenterX;
	const pyCenter = py + 0.5;

	if (pyCenter >= y0 + r && pyCenter <= y1 - r) {
		return 255;
	}
	if (pyCenter < y0 + r) {
		const dy = pyCenter - (y0 + r);
		return discCoverage(Math.hypot(dx, dy), r);
	}
	const dy = pyCenter - (y1 - r);
	return discCoverage(Math.hypot(dx, dy), r);
}

function discCoverage(d: number, r: number): number {
	if (d <= r - 1) {
		return 255;
	}
	if (d >= r) {
		return 0;
	}
	return Math.round((r - d) * 255);
}

function blitPixel(data: Buffer, x: number, y: number, tint: RGB, alpha: number): void {
	const idx = (y * TARGET_SIZE + x) * 4;
	const dstA = data[idx + 3] ?? 0;
	if (dstA === 0) {
		data[idx] = tint[0];
		data[idx + 1] = tint[1];
		data[idx + 2] = tint[2];
		data[idx + 3] = alpha;
		return;
	}
	const srcA = alpha / 255;
	const outA = srcA + (dstA / 255) * (1 - srcA);
	if (outA <= 0) {
		return;
	}
	data[idx] = Math.round((tint[0] * srcA + (data[idx] ?? 0) * (dstA / 255) * (1 - srcA)) / outA);
	data[idx + 1] = Math.round(
		(tint[1] * srcA + (data[idx + 1] ?? 0) * (dstA / 255) * (1 - srcA)) / outA
	);
	data[idx + 2] = Math.round(
		(tint[2] * srcA + (data[idx + 2] ?? 0) * (dstA / 255) * (1 - srcA)) / outA
	);
	data[idx + 3] = Math.round(outA * 255);
}

// ── Topology path parsing + interpolation ────────────────────────────

interface CubicSegment {
	c1: [number, number];
	c2: [number, number];
	end: [number, number];
}

interface ParsedPath {
	segments: CubicSegment[];
	start: [number, number];
}

const PATH_COMMA_RE = /,/g;
const PATH_WHITESPACE_RE = /\s+/;

/** Parses the limited SVG path subset used by the thinking indicator
 *  (`M x y (C x1 y1 x2 y2 x y)+ Z`). Tokens are space-delimited. */
export function parsePath(d: string): ParsedPath {
	const tokens = d
		.replace(PATH_COMMA_RE, " ")
		.split(PATH_WHITESPACE_RE)
		.filter((t) => t.length > 0);
	let i = 0;
	const readNum = (): number => {
		const v = Number.parseFloat(tokens[i++] ?? "");
		if (Number.isNaN(v)) {
			throw new Error(`parsePath: bad number at token ${i}`);
		}
		return v;
	};
	let start: [number, number] | null = null;
	const segments: CubicSegment[] = [];
	while (i < tokens.length) {
		const tok = tokens[i++];
		if (tok === "M") {
			start = [readNum(), readNum()];
			continue;
		}
		if (tok === "C") {
			segments.push({
				c1: [readNum(), readNum()],
				c2: [readNum(), readNum()],
				end: [readNum(), readNum()],
			});
			continue;
		}
		if (tok === "Z" || tok === "z") {
			break;
		}
		throw new Error(`parsePath: unsupported command "${tok}"`);
	}
	if (!start) {
		throw new Error("parsePath: missing M command");
	}
	return { start, segments };
}

const TOPOLOGY_KEYFRAMES: readonly ParsedPath[] = [
	parsePath(CIRCLE_A),
	parsePath(INFINITY_PATH),
	parsePath(CIRCLE_B),
	parsePath(INFINITY_PATH),
	parsePath(CIRCLE_A),
];

/** easeInOutSine — visually equivalent to CSS `ease-in-out` for a 6 s
 *  morph. Cheaper than evaluating cubic-bezier(0.42, 0, 0.58, 1) and
 *  matches motion's default well enough at this scale. */
export function easeInOutSine(t: number): number {
	return 0.5 * (1 - Math.cos(Math.PI * Math.max(0, Math.min(1, t))));
}

export function lerpPath(a: ParsedPath, b: ParsedPath, t: number): ParsedPath {
	if (a.segments.length !== b.segments.length) {
		throw new Error("lerpPath: keyframes have different topology");
	}
	const lerp = (u: number, v: number): number => u + (v - u) * t;
	const segments: CubicSegment[] = a.segments.map((seg, idx) => {
		const other = b.segments[idx];
		if (!other) {
			throw new Error("lerpPath: missing segment");
		}
		return {
			c1: [lerp(seg.c1[0], other.c1[0]), lerp(seg.c1[1], other.c1[1])],
			c2: [lerp(seg.c2[0], other.c2[0]), lerp(seg.c2[1], other.c2[1])],
			end: [lerp(seg.end[0], other.end[0]), lerp(seg.end[1], other.end[1])],
		};
	});
	return {
		start: [lerp(a.start[0], b.start[0]), lerp(a.start[1], b.start[1])],
		segments,
	};
}

export function interpolateTopology(tRaw: number): ParsedPath {
	const N = TOPOLOGY_KEYFRAMES.length - 1; // 4 segments between 5 keyframes
	const wrapped = ((tRaw % 1) + 1) % 1;
	const scaled = wrapped * N;
	const segIdx = Math.min(N - 1, Math.floor(scaled));
	const segT = scaled - segIdx;
	const a = TOPOLOGY_KEYFRAMES[segIdx];
	const b = TOPOLOGY_KEYFRAMES[segIdx + 1];
	if (!(a && b)) {
		throw new Error("interpolateTopology: out-of-bounds keyframes");
	}
	return lerpPath(a, b, easeInOutSine(segT));
}

// ── Topology rasterization ───────────────────────────────────────────

function evalCubic(
	p0: [number, number],
	p1: [number, number],
	p2: [number, number],
	p3: [number, number],
	t: number
): [number, number] {
	const u = 1 - t;
	const uu = u * u;
	const tt = t * t;
	const x = uu * u * p0[0] + 3 * uu * t * p1[0] + 3 * u * tt * p2[0] + tt * t * p3[0];
	const y = uu * u * p0[1] + 3 * uu * t * p1[1] + 3 * u * tt * p2[1] + tt * t * p3[1];
	return [x, y];
}

interface Bbox {
	maxX: number;
	maxY: number;
	minX: number;
	minY: number;
}

/** Compute the union bbox of every keyframe's actual curve geometry (not the
 *  enclosing viewBox). The SVG paths only paint inside a small portion of
 *  their 24×24 source — sampling the curves themselves lets us scale the
 *  drawn shape to fill the tray icon, not the empty space around it. */
function computeKeyframesBbox(frames: readonly ParsedPath[]): Bbox {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	const visit = (p: readonly [number, number]): void => {
		if (p[0] < minX) {
			minX = p[0];
		}
		if (p[1] < minY) {
			minY = p[1];
		}
		if (p[0] > maxX) {
			maxX = p[0];
		}
		if (p[1] > maxY) {
			maxY = p[1];
		}
	};
	const SAMPLES = 32;
	for (const frame of frames) {
		visit(frame.start);
		let cursor = frame.start;
		for (const seg of frame.segments) {
			for (let s = 1; s <= SAMPLES; s++) {
				visit(evalCubic(cursor, seg.c1, seg.c2, seg.end, s / SAMPLES));
			}
			cursor = seg.end;
		}
	}
	return { minX, minY, maxX, maxY };
}

const TOPOLOGY_BBOX = computeKeyframesBbox(TOPOLOGY_KEYFRAMES);

export function renderTopologyIcon(path: ParsedPath, stroke: RGB): NativeImage {
	const png = new PNG({ width: TARGET_SIZE, height: TARGET_SIZE });
	png.data.fill(0);

	const bbox = TOPOLOGY_BBOX;
	const bboxWidth = bbox.maxX - bbox.minX;
	const bboxHeight = bbox.maxY - bbox.minY;
	const available = TARGET_SIZE - 2 * TOPOLOGY_PADDING;
	const scale = Math.min(available / bboxWidth, available / bboxHeight);
	const offsetX = (TARGET_SIZE - bboxWidth * scale) / 2 - bbox.minX * scale;
	const offsetY = (TARGET_SIZE - bboxHeight * scale) / 2 - bbox.minY * scale;
	const strokeRadius = (TOPOLOGY_STROKE_WIDTH_SRC * scale) / 2;
	const toCanvas = (p: readonly [number, number]): [number, number] => [
		p[0] * scale + offsetX,
		p[1] * scale + offsetY,
	];

	let cursor = toCanvas(path.start);
	stampDisc(png.data, cursor[0], cursor[1], strokeRadius, stroke);
	for (const seg of path.segments) {
		const p0 = cursor;
		const p1 = toCanvas(seg.c1);
		const p2 = toCanvas(seg.c2);
		const p3 = toCanvas(seg.end);
		for (let s = 1; s <= TOPOLOGY_SUBDIVISIONS_PER_SEGMENT; s++) {
			const t = s / TOPOLOGY_SUBDIVISIONS_PER_SEGMENT;
			const point = evalCubic(p0, p1, p2, p3, t);
			stampDisc(png.data, point[0], point[1], strokeRadius, stroke);
		}
		cursor = p3;
	}

	const buf = PNG.sync.write(png);
	return nativeImage.createFromBuffer(buf);
}

function stampDisc(data: Buffer, cx: number, cy: number, r: number, tint: RGB): void {
	const minX = Math.max(0, Math.floor(cx - r - 1));
	const maxX = Math.min(TARGET_SIZE - 1, Math.ceil(cx + r + 1));
	const minY = Math.max(0, Math.floor(cy - r - 1));
	const maxY = Math.min(TARGET_SIZE - 1, Math.ceil(cy + r + 1));
	for (let py = minY; py <= maxY; py++) {
		for (let px = minX; px <= maxX; px++) {
			const dx = px + 0.5 - cx;
			const dy = py + 0.5 - cy;
			const d = Math.hypot(dx, dy);
			const alpha = discCoverage(d, r);
			if (alpha > 0) {
				blitPixel(data, px, py, tint, alpha);
			}
		}
	}
}

// ── Helpers ──────────────────────────────────────────────────────────

function trayIsLive(): boolean {
	return trayRef !== null && !trayRef.isDestroyed();
}

function setIconOnTray(icon: NativeImage): void {
	if (trayIsLive()) {
		trayRef?.setImage(icon);
	}
}

function baseIconUsable(): boolean {
	return baseIcon !== null && !baseIcon.isEmpty();
}

function revertIcons(): void {
	if (!baseIconUsable()) {
		return;
	}
	setIconOnTray(baseIcon as NativeImage);
}

export const __recording_indicator_test_helpers__ = {
	computeAmplified,
	computeBandValue,
	renderBarsIcon,
	renderTopologyIcon,
	parsePath,
	lerpPath,
	easeInOutSine,
	interpolateTopology,
	evalCubic,
	stampDisc,
	clamp01,
	discCoverage,
	capCoverage,
	drawRoundedBar,
	blitPixel,
	trayIsLive,
	setIconOnTray,
	baseIconUsable,
	computeBands,
	drawDot,
	paintSoftField,
	renderVisualizerFrame,
	getVisualizerStyle: (): VisualizerStyle => visualizerStyle,
	getVisualizerConfig: () => ({
		gridRows,
		gridColumns,
		radialDotCount,
		waveLineWidth,
		auraShape,
		auraBlur,
	}),
	getCurrentView: (): IndicatorView => currentView,
	get BAR_COUNT() {
		return BAR_COUNT;
	},
	get TARGET_SIZE() {
		return TARGET_SIZE;
	},
	get TOPOLOGY_KEYFRAMES() {
		return TOPOLOGY_KEYFRAMES;
	},
	get TOPOLOGY_DURATION_MS() {
		return TOPOLOGY_DURATION_MS;
	},
};
