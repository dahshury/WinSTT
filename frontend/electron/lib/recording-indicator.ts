import { type BrowserWindow, type NativeImage, nativeImage, type Tray } from "electron";
import { PNG } from "pngjs";
import { dbg } from "./debug-log";

/** Number of discrete levels (0 through LEVELS inclusive). */
const LEVELS = 10;

/** Minimum interval (ms) between icon swaps — caps at ~20 fps. */
const THROTTLE_MS = 50;

/** Green tint color (RGB). */
const TINT_R = 0;
const TINT_G = 200;
const TINT_B = 50;

/** Blend opacity for tray icon tinting (0–1). */
const BLEND_ALPHA = 0.6;

// ── Adaptive level normalization ─────────────────────────────────────
// Tracks a rolling peak that rises fast and decays slowly, so the
// indicator always fills meaningfully regardless of absolute volume.

/** How fast the peak rises toward a louder sample (0–1, higher = faster). */
const PEAK_ATTACK = 0.8;

/** Per-tick multiplier that slowly shrinks the peak when audio is quieter. */
const PEAK_DECAY = 0.993;

/** Floor for the rolling peak — prevents division-by-tiny-number jitter. */
const PEAK_FLOOR = 0.005;

/** Power curve exponent — <1 expands quiet values, giving more visual range. */
const CURVE_EXP = 0.45;

/** Minimum visible level while recording (so silence still shows a sliver). */
const MIN_VISUAL = 0.08;

// ── Module state ─────────────────────────────────────────────────────
let trayRef: Tray | null = null;
let winRef: BrowserWindow | null = null;
let baseIcon: NativeImage | null = null;

/** Green-tinted icons shared by tray and taskbar. */
let levelIcons: NativeImage[] = []; // length = LEVELS + 1

let isRecording = false;
let currentIndex = -1;
let lastUpdateTs = 0;

/** Rolling peak for adaptive normalization. */
let rollingPeak = PEAK_FLOOR;

// ── Public API ───────────────────────────────────────────────────────

function tryGenerateLevelIcons(base: NativeImage): NativeImage[] {
	try {
		return generateLevelIcons(base);
	} catch (err) {
		dbg("indicator", "Failed to generate level icons:", String(err));
		return [];
	}
}

function logInitialized(base: NativeImage, icons: NativeImage[]): void {
	const size = base.getSize();
	dbg("indicator", `Initialized: ${size.width}x${size.height} base, ${icons.length} level icons`);
}

export function initRecordingIndicator(tray: Tray, win: BrowserWindow, iconPath: string): void {
	trayRef = tray;
	winRef = win;
	baseIcon = nativeImage.createFromPath(iconPath);

	if (baseIcon.isEmpty()) {
		dbg("indicator", "Base icon is empty — indicator disabled");
		levelIcons = [];
		return;
	}
	levelIcons = tryGenerateLevelIcons(baseIcon);
	logInitialized(baseIcon, levelIcons);
}

export function onRecordingStart(): void {
	dbg("indicator", "Recording started");
	isRecording = true;
	currentIndex = -1; // force first update
	rollingPeak = PEAK_FLOOR; // reset adaptive range for new session
	applyLevel(0);
}

export function onRecordingStop(): void {
	dbg("indicator", "Recording stopped");
	isRecording = false;
	currentIndex = -1;
	revertIcons();
}

function updateRollingPeak(level: number): void {
	if (level > rollingPeak) {
		// Rise fast toward louder input
		rollingPeak += PEAK_ATTACK * (level - rollingPeak);
	} else {
		// Decay slowly when quieter
		rollingPeak *= PEAK_DECAY;
	}
	rollingPeak = Math.max(rollingPeak, PEAK_FLOOR);
}

function shouldThrottle(now: number): boolean {
	return now - lastUpdateTs < THROTTLE_MS;
}

function computeLevelIndex(level: number): number {
	const normalized = Math.min(1, level / rollingPeak);
	const curved = normalized ** CURVE_EXP;
	const visual = MIN_VISUAL + curved * (1 - MIN_VISUAL);
	return Math.min(LEVELS, Math.max(0, Math.round(visual * LEVELS)));
}

function maybeApplyThrottledLevel(level: number, now: number): void {
	if (shouldThrottle(now)) {
		return;
	}
	const index = computeLevelIndex(level);
	if (index === currentIndex) {
		return;
	}
	lastUpdateTs = now;
	applyLevel(index);
}

export function onAudioLevel(level: number): void {
	if (!isRecording) {
		return;
	}
	updateRollingPeak(level);
	maybeApplyThrottledLevel(level, Date.now());
}

export function cleanupRecordingIndicator(): void {
	trayRef = null;
	winRef = null;
	baseIcon = null;
	levelIcons = [];
	isRecording = false;
	currentIndex = -1;
}

// ── Icon generation (via pngjs) ──────────────────────────────────────

function blendPixel(data: Buffer, idx: number): void {
	const a = data[idx + 3]!;
	if (a === 0) {
		return;
	}
	data[idx] = Math.round(data[idx]! * (1 - BLEND_ALPHA) + TINT_R * BLEND_ALPHA);
	data[idx + 1] = Math.round(data[idx + 1]! * (1 - BLEND_ALPHA) + TINT_G * BLEND_ALPHA);
	data[idx + 2] = Math.round(data[idx + 2]! * (1 - BLEND_ALPHA) + TINT_B * BLEND_ALPHA);
}

function blendRow(data: Buffer, y: number, width: number): void {
	for (let x = 0; x < width; x++) {
		const idx = (y * width + x) * 4;
		blendPixel(data, idx);
	}
}

function blendBottomRows(data: Buffer, width: number, height: number, startRow: number): void {
	for (let y = startRow; y < height; y++) {
		blendRow(data, y, width);
	}
}

function buildLevelIcon(
	basePng: { width: number; height: number; data: Buffer },
	lvl: number
): NativeImage {
	const { width, height } = basePng;
	const fraction = lvl / LEVELS;
	const greenRows = Math.round(height * fraction);
	const startRow = height - greenRows;
	const data = Buffer.from(basePng.data);
	blendBottomRows(data, width, height, startRow);

	const out = new PNG({ width, height });
	out.data = data;
	const pngBuf = PNG.sync.write(out);
	return nativeImage.createFromBuffer(pngBuf);
}

function generateLevelIcons(base: NativeImage): NativeImage[] {
	const basePngBuf = base.toPNG();
	const basePng = PNG.sync.read(basePngBuf);
	const icons: NativeImage[] = [];
	for (let lvl = 0; lvl <= LEVELS; lvl++) {
		icons.push(buildLevelIcon(basePng, lvl));
	}
	return icons;
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

function applyLevel(index: number): void {
	currentIndex = index;
	const icon = levelIcons[index];
	if (!icon) {
		return;
	}
	setIconOnTray(icon);
	setIconOnWin(icon);
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
	tryGenerateLevelIcons,
	logInitialized,
	updateRollingPeak,
	shouldThrottle,
	computeLevelIndex,
	maybeApplyThrottledLevel,
	blendPixel,
	blendRow,
	blendBottomRows,
	buildLevelIcon,
	trayIsLive,
	winIsLive,
	setIconOnTray,
	setIconOnWin,
	baseIconUsable,
};
