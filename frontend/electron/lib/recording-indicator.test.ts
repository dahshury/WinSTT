import { describe, expect, mock, test } from "bun:test";
import { PNG } from "pngjs";
import { debugLogMock } from "../../test/mocks/debug-log";
import { electronMock } from "../../test/mocks/electron";
import { storeMock } from "../../test/mocks/store";

const TEST_TINT: readonly [number, number, number] = [59, 130, 246]; // ptt blue

// Mock electron with a `nativeImage` that round-trips PNG buffers so
// renderBarsIcon's output can actually be inspected.
const lastPngBuffers: Buffer[] = [];
mock.module("electron", () => {
	const base = electronMock();
	base.nativeImage = {
		createFromPath: (_p: string) => ({
			isEmpty: () => true,
			getSize: () => ({ width: 0, height: 0 }),
			toPNG: () => Buffer.alloc(0),
		}),
		createFromBuffer: (buf: Buffer) => {
			lastPngBuffers.push(buf);
			return {
				isEmpty: () => false,
				getSize: () => ({ width: 32, height: 32 }),
				toPNG: () => buf,
			};
		},
	} as unknown as typeof base.nativeImage;
	return base;
});

mock.module("./debug-log", () => debugLogMock());
mock.module("./store", () => storeMock());

const {
	initRecordingIndicator,
	onRecordingStart,
	onRecordingStop,
	onAudioLevel,
	cleanupRecordingIndicator,
	computeAmplified,
	computeBandValue,
	renderBarsIcon,
	__recording_indicator_test_helpers__: helpers,
} = await import("./recording-indicator");

function makeTray(): { setImage: (icon: unknown) => void; isDestroyed: () => boolean } {
	let count = 0;
	return {
		setImage: () => {
			count += 1;
		},
		get count() {
			return count;
		},
		isDestroyed: () => false,
	} as unknown as { setImage: (icon: unknown) => void; isDestroyed: () => boolean };
}

function makeWin(): { setIcon: (icon: unknown) => void; isDestroyed: () => boolean } {
	let count = 0;
	return {
		setIcon: () => {
			count += 1;
		},
		get count() {
			return count;
		},
		isDestroyed: () => false,
	} as unknown as { setIcon: (icon: unknown) => void; isDestroyed: () => boolean };
}

function decodePng(buf: Buffer): PNG {
	return PNG.sync.read(buf);
}

describe("recording-indicator public API", () => {
	test("module exports are functions", () => {
		expect(typeof initRecordingIndicator).toBe("function");
		expect(typeof onRecordingStart).toBe("function");
		expect(typeof onRecordingStop).toBe("function");
		expect(typeof onAudioLevel).toBe("function");
		expect(typeof cleanupRecordingIndicator).toBe("function");
	});

	test("initRecordingIndicator with empty base icon does not throw", () => {
		const tray = makeTray();
		const win = makeWin();
		expect(() =>
			initRecordingIndicator(
				tray as unknown as Parameters<typeof initRecordingIndicator>[0],
				win as unknown as Parameters<typeof initRecordingIndicator>[1],
				"/fake/icon.png"
			)
		).not.toThrow();
		cleanupRecordingIndicator();
	});

	test("onRecordingStart / onAudioLevel / onRecordingStop do not throw", () => {
		const tray = makeTray();
		const win = makeWin();
		initRecordingIndicator(
			tray as unknown as Parameters<typeof initRecordingIndicator>[0],
			win as unknown as Parameters<typeof initRecordingIndicator>[1],
			"/fake/icon.png"
		);
		expect(() => onRecordingStart()).not.toThrow();
		expect(() => onAudioLevel(0.1)).not.toThrow();
		expect(() => onAudioLevel(0.9)).not.toThrow();
		expect(() => onAudioLevel(0)).not.toThrow();
		expect(() => onRecordingStop()).not.toThrow();
		cleanupRecordingIndicator();
	});

	test("onAudioLevel before recording is a no-op (does not throw)", () => {
		cleanupRecordingIndicator();
		expect(() => onAudioLevel(0.5)).not.toThrow();
	});

	test("cleanupRecordingIndicator clears state safely", () => {
		const tray = makeTray();
		const win = makeWin();
		initRecordingIndicator(
			tray as unknown as Parameters<typeof initRecordingIndicator>[0],
			win as unknown as Parameters<typeof initRecordingIndicator>[1],
			"/fake/icon.png"
		);
		onRecordingStart();
		expect(() => cleanupRecordingIndicator()).not.toThrow();
		// After cleanup, audio levels should not throw either.
		expect(() => onAudioLevel(0.3)).not.toThrow();
	});

	test("onRecordingStop before start is a no-op (guards against cold-start retry storm)", () => {
		cleanupRecordingIndicator();
		expect(() => onRecordingStop()).not.toThrow();
	});

	test("onRecordingStart triggers an immediate icon swap (does not wait for tick)", () => {
		const tray = makeTray() as ReturnType<typeof makeTray> & { count: number };
		const win = makeWin() as ReturnType<typeof makeWin> & { count: number };
		initRecordingIndicator(
			tray as unknown as Parameters<typeof initRecordingIndicator>[0],
			win as unknown as Parameters<typeof initRecordingIndicator>[1],
			"/fake/icon.png"
		);
		const before = tray.count;
		onRecordingStart();
		expect(tray.count).toBeGreaterThan(before);
		expect(win.count).toBeGreaterThan(0);
		onRecordingStop();
		cleanupRecordingIndicator();
	});
});

describe("computeAmplified (ported from pill)", () => {
	test("returns peak floored at PEAK_FLOOR=0.1", () => {
		const { peak } = computeAmplified(0, 0);
		expect(peak).toBeGreaterThanOrEqual(0.1);
	});

	test("peak rises to match a louder level", () => {
		const { peak } = computeAmplified(0.8, 0.2);
		expect(peak).toBe(0.8);
	});

	test("peak decays from prevPeak when level is below floor", () => {
		// prev=0.5, decay=0.99 → 0.495; level=0 → max(0.1, 0, 0.495) = 0.495
		const { peak } = computeAmplified(0, 0.5);
		expect(peak).toBeCloseTo(0.495, 4);
	});

	test("amplified is sqrt(level/peak), clamped to [0,1]", () => {
		const { amplified } = computeAmplified(0.5, 0.5);
		// level=peak=0.5 → 1.0
		expect(amplified).toBeCloseTo(1, 6);
	});

	test("amplified is 0 when audioLevel is 0", () => {
		const { amplified } = computeAmplified(0, 0.5);
		expect(amplified).toBe(0);
	});

	test("amplified saturates at 1 when level > peak (shouldn't happen but guarded)", () => {
		const { amplified } = computeAmplified(2, 0.5);
		expect(amplified).toBeLessThanOrEqual(1);
		expect(amplified).toBeGreaterThan(0.99);
	});

	test("amplified treats negative levels as 0 (defensive)", () => {
		const { amplified } = computeAmplified(-1, 0.5);
		expect(amplified).toBe(0);
	});
});

describe("computeBandValue (ported from pill)", () => {
	test("returns value in [0.05, 1]", () => {
		// Sweep time, band, amplified across a wide grid.
		for (let amp = 0; amp <= 1; amp += 0.25) {
			for (let t = 0; t < 2; t += 0.13) {
				for (let i = 0; i < 5; i++) {
					const v = computeBandValue(i, 5, t, amp);
					expect(v).toBeGreaterThanOrEqual(0.05);
					expect(v).toBeLessThanOrEqual(1);
				}
			}
		}
	});

	test("amplified=0 returns exactly the MIN floor 0.05", () => {
		expect(computeBandValue(0, 5, 0, 0)).toBe(0.05);
		expect(computeBandValue(2, 5, 1.23, 0)).toBe(0.05);
	});

	test("amplified=1 with v1+v2+v3=0 (pick any t) stays ≤ 0.8 ish on average", () => {
		// Sanity: average band value over a band span isn't pegged to 1.
		let sum = 0;
		const N = 100;
		for (let i = 0; i < N; i++) {
			sum += computeBandValue(0, 5, i * 0.05, 1);
		}
		const avg = sum / N;
		expect(avg).toBeGreaterThan(0.3);
		expect(avg).toBeLessThan(1);
	});

	test("different band indices produce different values at the same time (phase offset works)", () => {
		const v0 = computeBandValue(0, 5, 1.7, 1);
		const v1 = computeBandValue(1, 5, 1.7, 1);
		const v2 = computeBandValue(2, 5, 1.7, 1);
		// At least one pair differs.
		expect([v0, v1, v2].every((x) => x === v0)).toBe(false);
	});
});

describe("renderBarsIcon", () => {
	test("returns a NativeImage and the PNG buffer decodes to TARGET_SIZE×TARGET_SIZE", () => {
		lastPngBuffers.length = 0;
		const bands = [0.5, 0.5, 0.5, 0.5, 0.5];
		const img = renderBarsIcon(bands, TEST_TINT);
		expect(img).toBeDefined();
		expect(lastPngBuffers.length).toBe(1);
		const png = decodePng(lastPngBuffers[0]!);
		expect(png.width).toBe(helpers.TARGET_SIZE);
		expect(png.height).toBe(helpers.TARGET_SIZE);
	});

	test("PNG canvas is fully transparent outside any drawn bar (top-left corner)", () => {
		lastPngBuffers.length = 0;
		renderBarsIcon([0.1, 0.1, 0.1, 0.1, 0.1], TEST_TINT);
		const png = decodePng(lastPngBuffers[0]!);
		// Top-left corner is outside any bar geometry.
		expect(png.data[3]).toBe(0);
	});

	test("painted pixels use the tint color", () => {
		lastPngBuffers.length = 0;
		renderBarsIcon([1, 1, 1, 1, 1], TEST_TINT);
		const png = decodePng(lastPngBuffers[0]!);
		// Center column of the icon should land inside the middle bar.
		const cx = Math.floor(png.width / 2);
		const cy = Math.floor(png.height / 2);
		const idx = (cy * png.width + cx) * 4;
		expect(png.data[idx]).toBe(TEST_TINT[0]);
		expect(png.data[idx + 1]).toBe(TEST_TINT[1]);
		expect(png.data[idx + 2]).toBe(TEST_TINT[2]);
		expect(png.data[idx + 3]).toBeGreaterThan(0);
	});

	test("higher band value → taller painted region in that bar's column", () => {
		lastPngBuffers.length = 0;
		// All bands tiny except the middle bar at full height.
		renderBarsIcon([0.05, 0.05, 1, 0.05, 0.05], TEST_TINT);
		const png = decodePng(lastPngBuffers[0]!);
		// Count opaque pixels in the middle column.
		const cx = Math.floor(png.width / 2);
		let tallCount = 0;
		for (let y = 0; y < png.height; y++) {
			if ((png.data[(y * png.width + cx) * 4 + 3] ?? 0) > 0) {
				tallCount++;
			}
		}

		lastPngBuffers.length = 0;
		renderBarsIcon([0.05, 0.05, 0.05, 0.05, 0.05], TEST_TINT);
		const png2 = decodePng(lastPngBuffers[0]!);
		let shortCount = 0;
		for (let y = 0; y < png2.height; y++) {
			if ((png2.data[(y * png2.width + cx) * 4 + 3] ?? 0) > 0) {
				shortCount++;
			}
		}
		expect(tallCount).toBeGreaterThan(shortCount);
	});

	test("bars are vertically centered (top and bottom margins are roughly equal)", () => {
		lastPngBuffers.length = 0;
		renderBarsIcon([0.5, 0.5, 0.5, 0.5, 0.5], TEST_TINT);
		const png = decodePng(lastPngBuffers[0]!);
		const cx = Math.floor(png.width / 2);
		let firstOpaque = -1;
		let lastOpaque = -1;
		for (let y = 0; y < png.height; y++) {
			if ((png.data[(y * png.width + cx) * 4 + 3] ?? 0) > 0) {
				if (firstOpaque === -1) {
					firstOpaque = y;
				}
				lastOpaque = y;
			}
		}
		expect(firstOpaque).toBeGreaterThanOrEqual(0);
		const topMargin = firstOpaque;
		const bottomMargin = png.height - 1 - lastOpaque;
		expect(Math.abs(topMargin - bottomMargin)).toBeLessThanOrEqual(1);
	});

	test("alpha at the cap edge is feathered (not a binary 0/255 step)", () => {
		// Render a tall bar so its rounded caps are well-defined, then scan a
		// horizontal cap row for a non-{0,255} alpha pixel.
		lastPngBuffers.length = 0;
		renderBarsIcon([1, 1, 1, 1, 1], TEST_TINT);
		const png = decodePng(lastPngBuffers[0]!);
		let foundFeather = false;
		for (let y = 0; y < png.height; y++) {
			for (let x = 0; x < png.width; x++) {
				const a = png.data[(y * png.width + x) * 4 + 3] ?? 0;
				if (a > 0 && a < 255) {
					foundFeather = true;
					break;
				}
			}
			if (foundFeather) {
				break;
			}
		}
		expect(foundFeather).toBe(true);
	});

	test("clamps bands ≤ 0 to the minimum visible bar height (no zero-pixel bars)", () => {
		lastPngBuffers.length = 0;
		renderBarsIcon([0, -1, Number.NaN, 0, 0], TEST_TINT);
		const png = decodePng(lastPngBuffers[0]!);
		// At least some pixel should be opaque (bars never fully vanish).
		const hasAnyOpaque = png.data.some((_, i) => i % 4 === 3 && (png.data[i] ?? 0) > 0);
		expect(hasAnyOpaque).toBe(true);
	});
});

describe("recording-indicator helpers", () => {
	test("trayIsLive false after cleanup", () => {
		cleanupRecordingIndicator();
		expect(helpers.trayIsLive()).toBe(false);
	});

	test("winIsLive false after cleanup", () => {
		cleanupRecordingIndicator();
		expect(helpers.winIsLive()).toBe(false);
	});

	test("baseIconUsable false after cleanup (no base icon set)", () => {
		cleanupRecordingIndicator();
		expect(helpers.baseIconUsable()).toBe(false);
	});

	test("setIconOnTray no-op when tray is dead/null (no throw)", () => {
		cleanupRecordingIndicator();
		expect(() =>
			helpers.setIconOnTray({} as unknown as Parameters<typeof helpers.setIconOnTray>[0])
		).not.toThrow();
	});

	test("setIconOnWin no-op when win is dead/null (no throw)", () => {
		cleanupRecordingIndicator();
		expect(() =>
			helpers.setIconOnWin({} as unknown as Parameters<typeof helpers.setIconOnWin>[0])
		).not.toThrow();
	});

	test("clamp01 normalizes out-of-range and NaN values", () => {
		expect(helpers.clamp01(-1)).toBe(0);
		expect(helpers.clamp01(0)).toBe(0);
		expect(helpers.clamp01(0.5)).toBe(0.5);
		expect(helpers.clamp01(1)).toBe(1);
		expect(helpers.clamp01(2)).toBe(1);
		expect(helpers.clamp01(Number.NaN)).toBe(0);
	});

	test("discCoverage is 255 inside, 0 outside, fractional on the 1-pixel edge", () => {
		expect(helpers.discCoverage(0, 2)).toBe(255);
		expect(helpers.discCoverage(2, 2)).toBe(0);
		const edge = helpers.discCoverage(1.5, 2);
		expect(edge).toBeGreaterThan(0);
		expect(edge).toBeLessThan(255);
	});

	test("module constants match pill icon-size geometry", () => {
		expect(helpers.BAR_COUNT).toBe(5);
		expect(helpers.TARGET_SIZE).toBe(32);
		expect(helpers.TICK_MS).toBe(50);
	});
});
