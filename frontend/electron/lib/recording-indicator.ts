import { type BrowserWindow, type NativeImage, nativeImage, type Tray } from "electron";
import { PNG } from "pngjs";
import {
	RECORDING_MODE_COLOR_RGB,
	type RecordingMode,
} from "../../src/shared/config/recording-mode-color";
import { dbg } from "./debug-log";
import { getStoreValue } from "./store";

// ── Bar visualizer parameters ────────────────────────────────────────
//
// Mirrors the pill's bar visualizer (frontend/src/features/audio-visualizer
// `size="icon"`): 5 bars, 4px wide, 2px gap, centered vertically, fully
// rounded ends. The pill math is ported below verbatim from
// use-multiband-volume.ts so the tray icon undulates the same way.

/** Output canvas size. Windows scales 32×32 down to 16×16 at 100% DPI. */
const TARGET_SIZE = 32;

/** Bar count — matches the pill's `size="icon"` default (resolveBarCount). */
const BAR_COUNT = 5;

/** Bar width in pixels (matches pill `w-[4px]`). */
const BAR_WIDTH = 4;

/** Gap between bars in pixels (matches pill `gap-[2px]`). */
const BAR_GAP = 2;

/** Vertical margin so the tallest bar doesn't touch the icon edge. */
const VERTICAL_MARGIN = 2;

/** Update interval in ms — ~20 fps tick (pill uses rAF at ~60 fps; 20 fps is
 *  the highest rate Windows can visibly render a tray icon swap at). */
const TICK_MS = 50;

// Pill math constants — ported from
// frontend/src/features/audio-visualizer/lib/use-multiband-volume.ts
const PEAK_FLOOR = 0.1;
const PEAK_DECAY = 0.99;

// ── Module state ─────────────────────────────────────────────────────
let trayRef: Tray | null = null;
let winRef: BrowserWindow | null = null;
let baseIcon: NativeImage | null = null;

/** Mode active for the current recording session — captured at onRecordingStart so
 * mid-session mode toggles can't swap the bar color under us. */
let activeMode: RecordingMode = "ptt";

let isRecording = false;

/** Latest raw audio level from onAudioLevel; read by the render tick. */
let rawLevel = 0;

/** Rolling peak for adaptive amplification (matches pill). */
let peak = PEAK_FLOOR;

/** Recording start timestamp; feeds the time-based sinusoidal phases. */
let sessionStartMs = 0;

/** setInterval handle for the render tick. */
let tickHandle: ReturnType<typeof setInterval> | null = null;

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

export function initRecordingIndicator(tray: Tray, win: BrowserWindow, iconPath: string): void {
	trayRef = tray;
	winRef = win;
	baseIcon = nativeImage.createFromPath(iconPath);

	if (baseIcon.isEmpty()) {
		dbg("indicator", "Base icon is empty — indicator will skip revert step");
	}
	dbg(
		"indicator",
		`Initialized: bars=${BAR_COUNT} target=${TARGET_SIZE}x${TARGET_SIZE} tick=${TICK_MS}ms`
	);
}

function readRecordingMode(): RecordingMode {
	try {
		return getStoreValue("general.recordingMode");
	} catch {
		return "ptt";
	}
}

export function onRecordingStart(): void {
	dbg("indicator", "Recording started");
	activeMode = readRecordingMode();
	isRecording = true;
	rawLevel = 0;
	peak = PEAK_FLOOR;
	sessionStartMs = nowMs();
	startTick();
	renderFrame();
}

export function onRecordingStop(): void {
	// No-op when we weren't recording. Without this guard, every WebSocket
	// disconnect (cold-start retry loop) would log "Recording stopped" and
	// revertIcons() for a state we never showed.
	if (!isRecording) {
		return;
	}
	dbg("indicator", "Recording stopped");
	isRecording = false;
	rawLevel = 0;
	peak = PEAK_FLOOR;
	stopTick();
	revertIcons();
}

export function onAudioLevel(level: number): void {
	if (!isRecording) {
		return;
	}
	rawLevel = Math.max(0, Math.min(1, level));
}

export function cleanupRecordingIndicator(): void {
	stopTick();
	trayRef = null;
	winRef = null;
	baseIcon = null;
	isRecording = false;
	rawLevel = 0;
	peak = PEAK_FLOOR;
}

// ── Render tick ──────────────────────────────────────────────────────

function nowMs(): number {
	return Date.now();
}

function startTick(): void {
	if (tickHandle !== null) {
		return;
	}
	tickHandle = setInterval(renderFrame, TICK_MS);
}

function stopTick(): void {
	if (tickHandle !== null) {
		clearInterval(tickHandle);
		tickHandle = null;
	}
}

function renderFrame(): void {
	if (!isRecording) {
		return;
	}
	const next = computeAmplified(rawLevel, peak);
	peak = next.peak;
	const time = (nowMs() - sessionStartMs) / 1000;
	const bands: number[] = [];
	for (let i = 0; i < BAR_COUNT; i++) {
		bands.push(computeBandValue(i, BAR_COUNT, time, next.amplified));
	}
	const icon = renderBarsIcon(bands, RECORDING_MODE_COLOR_RGB[activeMode]);
	setIconOnTray(icon);
	setIconOnWin(icon);
}

// ── Bar rasterization (transparent PNG via pngjs) ────────────────────

type RGB = readonly [number, number, number];

/** Render a transparent PNG of the bar visualizer state. Bars grow from
 *  the vertical center outward (matches pill's `items-center`). Pixel
 *  coverage at the rounded caps is alpha-blended for visual smoothness
 *  at the tray icon's tiny scale. */
export function renderBarsIcon(bands: readonly number[], tint: RGB): NativeImage {
	const png = new PNG({ width: TARGET_SIZE, height: TARGET_SIZE });
	png.data.fill(0); // fully transparent canvas

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

function clamp01(v: number): number {
	if (Number.isNaN(v)) {
		return 0;
	}
	return Math.max(0, Math.min(1, v));
}

/** Draws a vertically-centered rounded-cap bar with anti-aliased ends.
 *  Origin of the bar is (x0, cy - h/2). The bar is BAR_WIDTH px wide and
 *  `h` px tall, with semicircular caps of radius BAR_WIDTH/2. */
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

	// The bar runs from y0 to y1. Cap regions are the top r pixels (y0 .. y0+r)
	// and the bottom r pixels (y1-r .. y1); the straight middle runs y0+r .. y1-r.
	for (let py = 0; py < TARGET_SIZE; py++) {
		// Quick reject: pixel must fall inside the bar's vertical extent.
		if (py + 1 <= y0 || py >= y1) {
			continue;
		}
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
}

/** Returns 0..255 coverage for a pixel given the bar's cap geometry. The
 *  middle (non-cap) region has full coverage; caps fade based on the
 *  signed distance from the cap circle's edge. */
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

	// In the straight middle section.
	if (pyCenter >= y0 + r && pyCenter <= y1 - r) {
		return 255;
	}

	// In the top cap.
	if (pyCenter < y0 + r) {
		const dy = pyCenter - (y0 + r);
		const d = Math.hypot(dx, dy);
		return discCoverage(d, r);
	}

	// In the bottom cap.
	const dy = pyCenter - (y1 - r);
	const d = Math.hypot(dx, dy);
	return discCoverage(d, r);
}

/** Simple linear 1-pixel-wide anti-aliasing for a filled disc. */
function discCoverage(d: number, r: number): number {
	if (d <= r - 1) {
		return 255;
	}
	if (d >= r) {
		return 0;
	}
	return Math.round((r - d) * 255);
}

/** Premultiplied SRC_OVER blit. The canvas starts fully transparent, so
 *  this is effectively just "paint with given alpha" for any pixel a bar
 *  hasn't yet written; for cap pixels where two bars never overlap, the
 *  fast path also applies. */
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
	// SRC_OVER for the rare overlap case (shouldn't happen with our layout
	// but kept defensive for correctness if gap/width are ever changed).
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

// ── Helpers ──────────────────────────────────────────────────────────

function trayIsLive(): boolean {
	return trayRef !== null && !trayRef.isDestroyed();
}

function winIsLive(): boolean {
	return winRef !== null && !winRef.isDestroyed();
}

function setIconOnTray(icon: NativeImage): void {
	if (trayIsLive()) {
		trayRef?.setImage(icon);
	}
}

function setIconOnWin(icon: NativeImage): void {
	if (winIsLive()) {
		winRef?.setIcon(icon);
	}
}

function baseIconUsable(): boolean {
	return baseIcon !== null && !baseIcon.isEmpty();
}

function revertIcons(): void {
	if (!baseIconUsable()) {
		return;
	}
	const icon = baseIcon as NativeImage;
	setIconOnTray(icon);
	setIconOnWin(icon);
}

export const __recording_indicator_test_helpers__ = {
	computeAmplified,
	computeBandValue,
	renderBarsIcon,
	clamp01,
	discCoverage,
	capCoverage,
	drawRoundedBar,
	blitPixel,
	trayIsLive,
	winIsLive,
	setIconOnTray,
	setIconOnWin,
	baseIconUsable,
	get BAR_COUNT() {
		return BAR_COUNT;
	},
	get TARGET_SIZE() {
		return TARGET_SIZE;
	},
	get TICK_MS() {
		return TICK_MS;
	},
};
