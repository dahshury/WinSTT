// Generate `build/splash.bmp` from `build/icon.png`.
//
// The portable target in electron-builder accepts a `splashImage` option:
// a 24-bit Windows BMP shown by the embedded 7z stub during extraction.
// It is not a progress bar — electron-builder's portable target has no
// progress callback hook — but it is the only built-in way to tell the
// user "the app is launching, please wait" while the first-run extract
// runs (subsequent runs are instant thanks to `unpackDirName`).
//
// We compose a small 600 x 300 splash: the app icon on the left, a
// "Extracting WinSTT…" caption on the right, on a flat dark background.
// Output is a 24-bit BGR uncompressed BMP, which 7z's splash code reads
// directly.
//
// Pure pngjs + manual BMP writer — no extra deps, runs under Node and Bun.

const fs = require("node:fs");
const path = require("node:path");
const { PNG } = require("pngjs");

const SPLASH_W = 600;
const SPLASH_H = 300;
const BG = { r: 0x10, g: 0x12, b: 0x18 }; // near-black
const FG = { r: 0xff, g: 0xff, b: 0xff };

const buildDir = path.resolve(__dirname, "..", "build");
// public/icon.png is the committed 256px brand mark emitted by
// generate-icons.py (same mark used everywhere). Compositing its transparent
// PNG over the dark splash background gives a clean installer splash.
const iconPath = path.resolve(__dirname, "..", "public", "icon.png");
const outPath = path.join(buildDir, "splash.bmp");

// ──────────────────────────────────────────────────────────────────────
// 1. Read PNG icon
// ──────────────────────────────────────────────────────────────────────
function readIcon() {
	const buf = fs.readFileSync(iconPath);
	return PNG.sync.read(buf);
}

// Nearest-neighbour resize. Quality doesn't matter here — the icon is
// shown for ~10 seconds during first-time install and never again.
function resizeRgba(src, dstW, dstH) {
	const dst = new Uint8Array(dstW * dstH * 4);
	for (let y = 0; y < dstH; y++) {
		const sy = Math.min(src.height - 1, Math.floor((y * src.height) / dstH));
		for (let x = 0; x < dstW; x++) {
			const sx = Math.min(src.width - 1, Math.floor((x * src.width) / dstW));
			const si = (sy * src.width + sx) * 4;
			const di = (y * dstW + x) * 4;
			dst[di] = src.data[si];
			dst[di + 1] = src.data[si + 1];
			dst[di + 2] = src.data[si + 2];
			dst[di + 3] = src.data[si + 3];
		}
	}
	return { width: dstW, height: dstH, data: dst };
}

// ──────────────────────────────────────────────────────────────────────
// 2. Build canvas (RGBA over BG)
// ──────────────────────────────────────────────────────────────────────
const canvas = new Uint8Array(SPLASH_W * SPLASH_H * 4);
for (let i = 0; i < canvas.length; i += 4) {
	canvas[i] = BG.r;
	canvas[i + 1] = BG.g;
	canvas[i + 2] = BG.b;
	canvas[i + 3] = 0xff;
}

function blitRgba(src, dstX, dstY) {
	for (let y = 0; y < src.height; y++) {
		const cy = dstY + y;
		if (cy < 0 || cy >= SPLASH_H) continue;
		for (let x = 0; x < src.width; x++) {
			const cx = dstX + x;
			if (cx < 0 || cx >= SPLASH_W) continue;
			const si = (y * src.width + x) * 4;
			const a = src.data[si + 3] / 255;
			const ci = (cy * SPLASH_W + cx) * 4;
			canvas[ci] = Math.round(src.data[si] * a + canvas[ci] * (1 - a));
			canvas[ci + 1] = Math.round(src.data[si + 1] * a + canvas[ci + 1] * (1 - a));
			canvas[ci + 2] = Math.round(src.data[si + 2] * a + canvas[ci + 2] * (1 - a));
		}
	}
}

// 3x5 bitmap font — only the glyphs we use in the splash caption. Each
// glyph is a 3-wide x 5-tall column-major bitmap, 1 = pixel, 0 = empty.
// Rendered at a scale factor for readability.
const GLYPHS = {
	A: ["010", "101", "111", "101", "101"],
	B: ["110", "101", "110", "101", "110"],
	C: ["011", "100", "100", "100", "011"],
	D: ["110", "101", "101", "101", "110"],
	E: ["111", "100", "110", "100", "111"],
	G: ["011", "100", "101", "101", "011"],
	I: ["111", "010", "010", "010", "111"],
	N: ["101", "111", "111", "111", "101"],
	P: ["110", "101", "110", "100", "100"],
	R: ["110", "101", "110", "101", "101"],
	S: ["011", "100", "010", "001", "110"],
	T: ["111", "010", "010", "010", "010"],
	W: ["101", "101", "101", "111", "101"],
	X: ["101", "101", "010", "101", "101"],
	a: ["000", "011", "101", "101", "011"],
	c: ["000", "011", "100", "100", "011"],
	d: ["001", "001", "011", "101", "011"],
	e: ["000", "010", "111", "100", "011"],
	g: ["011", "101", "011", "001", "010"],
	i: ["010", "000", "010", "010", "010"],
	l: ["010", "010", "010", "010", "010"],
	n: ["000", "110", "101", "101", "101"],
	o: ["000", "010", "101", "101", "010"],
	p: ["000", "110", "101", "110", "100"],
	r: ["000", "101", "110", "100", "100"],
	s: ["000", "011", "010", "100", "011"],
	t: ["010", "111", "010", "010", "001"],
	u: ["000", "101", "101", "101", "011"],
	w: ["000", "101", "101", "111", "101"],
	x: ["000", "101", "010", "101", "101"],
	y: ["000", "101", "101", "011", "110"],
	" ": ["000", "000", "000", "000", "000"],
	".": ["00", "00", "00", "00", "10"],
	"…": ["00000", "00000", "00000", "00000", "10101"],
	"-": ["000", "000", "111", "000", "000"],
};

function drawText(text, baseX, baseY, scale, color) {
	let cursorX = baseX;
	for (const ch of text) {
		const glyph = GLYPHS[ch] ?? GLYPHS[" "];
		const glyphW = glyph[0].length;
		for (let gy = 0; gy < glyph.length; gy++) {
			const row = glyph[gy];
			for (let gx = 0; gx < row.length; gx++) {
				if (row[gx] !== "1") continue;
				for (let sy = 0; sy < scale; sy++) {
					for (let sx = 0; sx < scale; sx++) {
						const px = cursorX + gx * scale + sx;
						const py = baseY + gy * scale + sy;
						if (px < 0 || py < 0 || px >= SPLASH_W || py >= SPLASH_H) continue;
						const ci = (py * SPLASH_W + px) * 4;
						canvas[ci] = color.r;
						canvas[ci + 1] = color.g;
						canvas[ci + 2] = color.b;
					}
				}
			}
		}
		cursorX += (glyphW + 1) * scale;
	}
}

// ──────────────────────────────────────────────────────────────────────
// 3. Compose
// ──────────────────────────────────────────────────────────────────────
const icon = readIcon();
const iconSize = 160;
const iconResized = resizeRgba(icon, iconSize, iconSize);
const iconX = 60;
const iconY = (SPLASH_H - iconSize) / 2;
blitRgba(iconResized, iconX, iconY);

const textX = iconX + iconSize + 40;
drawText("WinSTT", textX, 100, 5, FG);
drawText("Extracting please wait", textX, 165, 3, { r: 0xa0, g: 0xa8, b: 0xb8 });

// ──────────────────────────────────────────────────────────────────────
// 4. Encode 24-bit uncompressed BMP (top-down via negative height)
// ──────────────────────────────────────────────────────────────────────
const rowSize = Math.floor((24 * SPLASH_W + 31) / 32) * 4; // padded to 4 bytes
const pixelDataSize = rowSize * SPLASH_H;
const fileSize = 14 + 40 + pixelDataSize;
const bmp = Buffer.alloc(fileSize);

// BITMAPFILEHEADER
bmp.write("BM", 0, "ascii");
bmp.writeUInt32LE(fileSize, 2);
bmp.writeUInt32LE(0, 6); // reserved
bmp.writeUInt32LE(14 + 40, 10); // data offset

// BITMAPINFOHEADER
bmp.writeUInt32LE(40, 14);
bmp.writeInt32LE(SPLASH_W, 18);
bmp.writeInt32LE(-SPLASH_H, 22); // negative => top-down rows
bmp.writeUInt16LE(1, 26);
bmp.writeUInt16LE(24, 28);
bmp.writeUInt32LE(0, 30); // BI_RGB
bmp.writeUInt32LE(pixelDataSize, 34);
bmp.writeUInt32LE(2835, 38); // 72 dpi
bmp.writeUInt32LE(2835, 42);
bmp.writeUInt32LE(0, 46);
bmp.writeUInt32LE(0, 50);

// Pixel data (BGR, row-padded)
let off = 54;
for (let y = 0; y < SPLASH_H; y++) {
	for (let x = 0; x < SPLASH_W; x++) {
		const ci = (y * SPLASH_W + x) * 4;
		bmp[off++] = canvas[ci + 2]; // B
		bmp[off++] = canvas[ci + 1]; // G
		bmp[off++] = canvas[ci]; // R
	}
	const padding = rowSize - SPLASH_W * 3;
	for (let p = 0; p < padding; p++) bmp[off++] = 0;
}

fs.writeFileSync(outPath, bmp);
console.log(
	`[generate-splash-bmp] wrote ${outPath} (${SPLASH_W}x${SPLASH_H}, ${bmp.length} bytes)`
);
