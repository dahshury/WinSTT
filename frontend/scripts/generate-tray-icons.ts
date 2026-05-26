/**
 * Generates 18 placeholder tray-icon PNGs for the state-driven, theme-aware
 * tray (mirroring Handy's pattern — see examples/Handy/src-tauri/src/tray.rs).
 *
 *   tray_<state>_<theme>.png       (16×16, native resolution)
 *   tray_<state>_<theme>@2x.png    (32×32, HiDPI)
 *
 *   state ∈ {idle, recording, transcribing}
 *   theme ∈ {dark, light, color}
 *
 * Theme mapping (matches Handy):
 *   - dark   → light/white icons (rendered on a dark system tray)
 *   - light  → dark/black icons (rendered on a light system tray)
 *   - color  → brand purple (Linux always; uses the WinSTT accent #a78bfa)
 *
 * State glyph (intentionally simple — replace with the real brand mark when
 * a designer ships approved assets):
 *   - idle          → outlined circle (calm)
 *   - recording     → solid red dot (active capture; tinted variant of the
 *                     theme color is overridden to a recording red so the
 *                     state is unambiguous regardless of OS theme — Handy
 *                     does the same trick)
 *   - transcribing  → three centered dots (post-recording processing)
 *
 * Output: frontend/electron/resources/tray/*.png
 *
 * Usage: bun run scripts/generate-tray-icons.ts
 *
 * ASSET SPEC (for designers replacing these placeholders):
 *   - PNG, sRGB, 8-bit RGBA, transparent background.
 *   - 16×16 @1x and 32×32 @2x. Optionally add @3x (48×48) later — the
 *     resolver in electron/ipc/tray-state.ts picks @2x when
 *     `screen.getPrimaryDisplay().scaleFactor >= 1.5`.
 *   - Keep the glyph inside an 80% safe area; the OS may clip edges on
 *     macOS template renders.
 *   - For the dark theme variants, render glyph in `#f4f4f5` (light gray).
 *   - For the light theme variants, render glyph in `#18181b` (near-black).
 *   - For the color variants, render glyph in WinSTT accent `#a78bfa`.
 *   - Recording state across ALL themes uses `#ef4444` (red-500) so the
 *     "live mic" affordance is unambiguous regardless of system theme.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";

type Theme = "dark" | "light" | "color";
type State = "idle" | "recording" | "transcribing";

interface Rgba {
	a: number;
	b: number;
	g: number;
	r: number;
}

const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };

const THEME_COLOR: Record<Theme, Rgba> = {
	dark: { r: 0xf4, g: 0xf4, b: 0xf5, a: 0xff },
	light: { r: 0x18, g: 0x18, b: 0x1b, a: 0xff },
	color: { r: 0xa7, g: 0x8b, b: 0xfa, a: 0xff },
};

// Recording state uses red across ALL themes — the universal "live" cue.
const RECORDING_RED: Rgba = { r: 0xef, g: 0x44, b: 0x44, a: 0xff };

function colorForStateTheme(state: State, theme: Theme): Rgba {
	if (state === "recording") {
		return RECORDING_RED;
	}
	return THEME_COLOR[theme];
}

function setPixel(png: PNG, x: number, y: number, c: Rgba): void {
	if (x < 0 || y < 0 || x >= png.width || y >= png.height) {
		return;
	}
	const idx = (png.width * y + x) * 4;
	png.data[idx] = c.r;
	png.data[idx + 1] = c.g;
	png.data[idx + 2] = c.b;
	png.data[idx + 3] = c.a;
}

function drawCircleOutline(png: PNG, cx: number, cy: number, r: number, width: number, c: Rgba) {
	const rOuter = r;
	const rInner = Math.max(0, r - width);
	const outerSq = rOuter * rOuter;
	const innerSq = rInner * rInner;
	for (let y = Math.floor(cy - rOuter); y <= Math.ceil(cy + rOuter); y++) {
		for (let x = Math.floor(cx - rOuter); x <= Math.ceil(cx + rOuter); x++) {
			const dx = x - cx + 0.5;
			const dy = y - cy + 0.5;
			const d2 = dx * dx + dy * dy;
			if (d2 <= outerSq && d2 >= innerSq) {
				setPixel(png, x, y, c);
			}
		}
	}
}

function drawDisc(png: PNG, cx: number, cy: number, r: number, c: Rgba) {
	const rSq = r * r;
	for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
		for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
			const dx = x - cx + 0.5;
			const dy = y - cy + 0.5;
			if (dx * dx + dy * dy <= rSq) {
				setPixel(png, x, y, c);
			}
		}
	}
}

function fillBackground(png: PNG, c: Rgba): void {
	for (let y = 0; y < png.height; y++) {
		for (let x = 0; x < png.width; x++) {
			setPixel(png, x, y, c);
		}
	}
}

function renderState(state: State, theme: Theme, size: number): Buffer {
	const png = new PNG({ width: size, height: size });
	fillBackground(png, TRANSPARENT);
	const color = colorForStateTheme(state, theme);
	const cx = size / 2;
	const cy = size / 2;

	if (state === "idle") {
		// Outlined circle, ~38% radius, ~9% stroke.
		const r = size * 0.38;
		const w = Math.max(1, Math.round(size * 0.09));
		drawCircleOutline(png, cx, cy, r, w, color);
	} else if (state === "recording") {
		// Solid red dot, ~32% radius.
		drawDisc(png, cx, cy, size * 0.32, color);
	} else {
		// Three centered dots (transcribing — animated rendering is out of
		// scope; the static three-dot glyph is a stable affordance).
		const dotR = Math.max(1, size * 0.09);
		const gap = size * 0.22;
		drawDisc(png, cx - gap, cy, dotR, color);
		drawDisc(png, cx, cy, dotR, color);
		drawDisc(png, cx + gap, cy, dotR, color);
	}

	return PNG.sync.write(png);
}

const STATES: State[] = ["idle", "recording", "transcribing"];
const THEMES: Theme[] = ["dark", "light", "color"];

const outDir = join(import.meta.dirname, "..", "electron", "resources", "tray");
mkdirSync(outDir, { recursive: true });

let count = 0;
for (const state of STATES) {
	for (const theme of THEMES) {
		const base = renderState(state, theme, 16);
		const hi = renderState(state, theme, 32);
		writeFileSync(join(outDir, `tray_${state}_${theme}.png`), base);
		writeFileSync(join(outDir, `tray_${state}_${theme}@2x.png`), hi);
		count += 2;
	}
}

console.log(`Generated ${count} tray-icon PNGs → ${outDir}`);
console.log("Replace with designer-approved assets before release. See file header for spec.");
