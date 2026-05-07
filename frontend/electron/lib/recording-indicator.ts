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

export function initRecordingIndicator(tray: Tray, win: BrowserWindow, iconPath: string): void {
	trayRef = tray;
	winRef = win;
	baseIcon = nativeImage.createFromPath(iconPath);

	if (baseIcon.isEmpty()) {
		dbg("indicator", "Base icon is empty — indicator disabled");
		levelIcons = [];
	} else {
		try {
			levelIcons = generateLevelIcons(baseIcon);
		} catch (err) {
			dbg("indicator", "Failed to generate level icons:", String(err));
			levelIcons = [];
		}
		const size = baseIcon.getSize();
		dbg(
			"indicator",
			`Initialized: ${size.width}x${size.height} base, ${levelIcons.length} level icons`
		);
	}
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

export function onAudioLevel(level: number): void {
	if (!isRecording) {
		return;
	}

	// ── Adaptive peak tracking (runs on every sample, not throttled) ──
	if (level > rollingPeak) {
		// Rise fast toward louder input
		rollingPeak += PEAK_ATTACK * (level - rollingPeak);
	} else {
		// Decay slowly when quieter
		rollingPeak *= PEAK_DECAY;
	}
	rollingPeak = Math.max(rollingPeak, PEAK_FLOOR);

	// ── Throttle icon updates ────────────────────────────────────────
	const now = Date.now();
	if (now - lastUpdateTs < THROTTLE_MS) {
		return;
	}

	// Normalize against rolling peak, apply power curve, enforce minimum
	const normalized = Math.min(1, level / rollingPeak);
	const curved = normalized ** CURVE_EXP;
	const visual = MIN_VISUAL + curved * (1 - MIN_VISUAL);

	const index = Math.min(LEVELS, Math.max(0, Math.round(visual * LEVELS)));
	if (index === currentIndex) {
		return;
	}

	lastUpdateTs = now;
	applyLevel(index);
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

function generateLevelIcons(base: NativeImage): NativeImage[] {
	const basePngBuf = base.toPNG();
	const basePng = PNG.sync.read(basePngBuf);
	const { width, height } = basePng;

	const icons: NativeImage[] = [];

	for (let lvl = 0; lvl <= LEVELS; lvl++) {
		const fraction = lvl / LEVELS;
		const greenRows = Math.round(height * fraction);
		const startRow = height - greenRows;

		// Clone pixel data (RGBA)
		const data = Buffer.from(basePng.data);

		// Blend green into the bottom `greenRows` of non-transparent pixels
		for (let y = startRow; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const idx = (y * width + x) * 4;
				const a = data[idx + 3]!;
				if (a === 0) {
					continue;
				}

				data[idx] = Math.round(data[idx]! * (1 - BLEND_ALPHA) + TINT_R * BLEND_ALPHA);
				data[idx + 1] = Math.round(data[idx + 1]! * (1 - BLEND_ALPHA) + TINT_G * BLEND_ALPHA);
				data[idx + 2] = Math.round(data[idx + 2]! * (1 - BLEND_ALPHA) + TINT_B * BLEND_ALPHA);
			}
		}

		const out = new PNG({ width, height });
		out.data = data;
		const pngBuf = PNG.sync.write(out);
		icons.push(nativeImage.createFromBuffer(pngBuf));
	}

	return icons;
}

// ── Helpers ──────────────────────────────────────────────────────────

function applyLevel(index: number): void {
	currentIndex = index;
	const icon = levelIcons[index];
	if (!icon) {
		return;
	}

	if (trayRef && !trayRef.isDestroyed()) {
		trayRef.setImage(icon);
	}

	if (winRef && !winRef.isDestroyed()) {
		winRef.setIcon(icon);
	}
}

function revertIcons(): void {
	if (!baseIcon || baseIcon.isEmpty()) {
		return;
	}

	if (trayRef && !trayRef.isDestroyed()) {
		trayRef.setImage(baseIcon);
	}

	if (winRef && !winRef.isDestroyed()) {
		winRef.setIcon(baseIcon);
	}
}
