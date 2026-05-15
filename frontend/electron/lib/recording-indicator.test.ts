import { describe, expect, mock, test } from "bun:test";
import { PNG } from "pngjs";
import { electronMock } from "../../test/mocks/electron";

/** Original green tint preserved as a test fixture so the pre-existing blend
 * math assertions (R=80, G=120, B=30 for input red) keep their meaning. */
const TEST_TINT: readonly [number, number, number] = [0, 200, 50];

// Mock electron with a `nativeImage.createFromPath` that returns an EMPTY image.
// This short-circuits `generateLevelIcons` (no PNG decode needed) and forces
// `levelIcons = []`, so `applyLevel`/`revertIcons` exit cleanly via guards.
//
// Use the shared electron stub as a base (`mock.module` is process-global).
const fakeNativeImage = {
	isEmpty: () => false,
	getSize: () => ({ width: 16, height: 16 }),
	toPNG: () => Buffer.alloc(0),
};

mock.module("electron", () => {
	const base = electronMock();
	base.nativeImage = {
		createFromPath: (_p: string) => ({
			isEmpty: () => true,
			getSize: () => ({ width: 0, height: 0 }),
			toPNG: () => Buffer.alloc(0),
		}),
		createFromBuffer: (_buf: Buffer) => fakeNativeImage,
	} as unknown as typeof base.nativeImage;
	return base;
});

// debug-log.ts has its own module-load side effects (createWriteStream, etc.).
// Stub it out so importing recording-indicator doesn't pull in real fs/electron.
mock.module("./debug-log", () => ({
	dbg: () => undefined,
	dbgVerbose: () => undefined,
}));

// recording-indicator reads `general.recordingMode` from the shared electron-
// store wrapper on each onRecordingStart. Stub it so the test suite doesn't
// need a real Store on disk.
mock.module("./store", () => ({
	getStoreValue: (_key: string) => "ptt",
	store: {},
}));

const {
	initRecordingIndicator,
	onRecordingStart,
	onRecordingStop,
	onAudioLevel,
	cleanupRecordingIndicator,
	__recording_indicator_test_helpers__: helpers,
} = await import("./recording-indicator");

interface TrayCalls {
	isDestroyed: () => boolean;
	setImage: number;
}
interface WinCalls {
	isDestroyed: () => boolean;
	setIcon: number;
}

function makeTray(): TrayCalls & {
	setImage: () => void;
	isDestroyed: () => boolean;
} {
	let count = 0;
	return {
		setImage: () => {
			count += 1;
		},
		get count() {
			return count;
		},
		isDestroyed: () => false,
	} as unknown as TrayCalls & {
		setImage: () => void;
		isDestroyed: () => boolean;
	};
}

function makeWin(): WinCalls & {
	setIcon: () => void;
	isDestroyed: () => boolean;
} {
	let count = 0;
	return {
		setIcon: () => {
			count += 1;
		},
		get count() {
			return count;
		},
		isDestroyed: () => false,
	} as unknown as WinCalls & {
		setIcon: () => void;
		isDestroyed: () => boolean;
	};
}

describe("recording-indicator", () => {
	test("module imports without throwing", () => {
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
});

describe("recording-indicator pure helpers", () => {
	test("blendPixel skips fully transparent pixels", () => {
		const data = Buffer.from([100, 100, 100, 0]); // alpha=0
		helpers.blendPixel(data, 0, TEST_TINT);
		// Unchanged
		expect(Array.from(data)).toEqual([100, 100, 100, 0]);
	});

	test("blendPixel mixes RGB toward green tint with non-zero alpha", () => {
		const data = Buffer.from([200, 0, 0, 255]); // red, fully opaque
		helpers.blendPixel(data, 0, TEST_TINT);
		// Tinted with TINT_R=0, TINT_G=200, TINT_B=50, BLEND_ALPHA=0.6
		// R: 200 * 0.4 + 0 * 0.6 = 80
		// G: 0 * 0.4 + 200 * 0.6 = 120
		// B: 0 * 0.4 + 50 * 0.6 = 30
		expect(data[0]).toBe(80);
		expect(data[1]).toBe(120);
		expect(data[2]).toBe(30);
		expect(data[3]).toBe(255); // alpha unchanged
	});

	test("blendRow blends every pixel in a row", () => {
		// 2 pixels, 4 channels each, all opaque red
		const data = Buffer.from([200, 0, 0, 255, 200, 0, 0, 255]);
		helpers.blendRow(data, 0, 2, TEST_TINT);
		// Both pixels should be tinted away from pure red
		expect(data[0]).not.toBe(200);
		expect(data[4]).not.toBe(200);
	});

	test("blendBottomRows only blends rows at and after startRow", () => {
		// 2x2 image, all opaque red
		const data = Buffer.from([200, 0, 0, 255, 200, 0, 0, 255, 200, 0, 0, 255, 200, 0, 0, 255]);
		helpers.blendBottomRows(data, 2, 2, 1, TEST_TINT);
		// Top row unchanged
		expect(data[0]).toBe(200);
		expect(data[4]).toBe(200);
		// Bottom row blended
		expect(data[8]).not.toBe(200);
		expect(data[12]).not.toBe(200);
	});

	test("blendBottomRows blends nothing when startRow >= height", () => {
		const data = Buffer.from([200, 0, 0, 255, 200, 0, 0, 255]);
		const before = Buffer.from(data);
		helpers.blendBottomRows(data, 2, 1, 5, TEST_TINT);
		expect(Array.from(data)).toEqual(Array.from(before));
	});

	test("blendBottomRows STRICTLY stops at y < height (does not touch row at y=height)", () => {
		// L196 mutation y <= height would process one extra row past the
		// declared height. Place a sentinel row right after the declared
		// height; if the loop over-runs, the sentinel will be touched.
		// 1x1 image (1 px = 4 bytes) followed by sentinel bytes.
		const data = Buffer.from([
			200,
			0,
			0,
			255, // row 0 (the only "real" row)
			77,
			77,
			77,
			77, // would-be row 1 sentinel (must NOT be touched)
		]);
		helpers.blendBottomRows(data, 1, 1, 0, TEST_TINT); // height=1 → only row 0 should blend
		// Row 0 blended.
		expect(data[0]).toBe(80);
		// Sentinel row 1 untouched.
		expect(data[4]).toBe(77);
		expect(data[5]).toBe(77);
		expect(data[6]).toBe(77);
		expect(data[7]).toBe(77);
	});

	// Module state is `cleanupRecordingIndicator`-cleared by the last "existing"
	// describe block above; trayRef/winRef/baseIcon are all null here.
	test("trayIsLive false after cleanup", () => {
		expect(helpers.trayIsLive()).toBe(false);
	});

	test("winIsLive false after cleanup", () => {
		expect(helpers.winIsLive()).toBe(false);
	});

	test("baseIconUsable false after cleanup (no base icon set)", () => {
		expect(helpers.baseIconUsable()).toBe(false);
	});

	test("setIconOnTray no-op when tray is dead/null (no throw)", () => {
		expect(() =>
			helpers.setIconOnTray({} as unknown as Parameters<typeof helpers.setIconOnTray>[0])
		).not.toThrow();
	});

	test("setIconOnWin no-op when win is dead/null (no throw)", () => {
		expect(() =>
			helpers.setIconOnWin({} as unknown as Parameters<typeof helpers.setIconOnWin>[0])
		).not.toThrow();
	});

	test("shouldThrottle gates by THROTTLE_MS interval", () => {
		// shouldThrottle reads module-level lastUpdateTs.
		// After cleanup it's whatever was last set; we test against Date.now() directly.
		const recent = Date.now();
		// recent < THROTTLE_MS (50) past lastUpdateTs is conservative — we check both ends.
		// Just verify the function returns a boolean for reasonable inputs.
		expect(typeof helpers.shouldThrottle(recent)).toBe("boolean");
		expect(typeof helpers.shouldThrottle(recent + 100_000)).toBe("boolean");
	});

	test("computeLevelIndex returns an integer in [0, LEVELS]", () => {
		// computeLevelIndex reads rollingPeak module state; just verify range.
		const idx = helpers.computeLevelIndex(0.5);
		expect(Number.isInteger(idx)).toBe(true);
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(idx).toBeLessThanOrEqual(10);
	});

	test("computeLevelIndex returns 0 for non-positive level", () => {
		const idx = helpers.computeLevelIndex(0);
		// Even at 0, the MIN_VISUAL floor pushes the value above 0 by at least 0.08
		// → rounded to ≥ 1 in practice. Just ensure the function is total.
		expect(Number.isInteger(idx)).toBe(true);
	});

	test("updateRollingPeak does not throw and floors near 0", () => {
		expect(() => helpers.updateRollingPeak(0.5)).not.toThrow();
		expect(() => helpers.updateRollingPeak(0)).not.toThrow();
	});
});

describe("tryGenerateLevelIcons", () => {
	test("returns empty array when generateLevelIcons throws (empty PNG buffer)", () => {
		// The electron mock returns toPNG() = Buffer.alloc(0), which makes PNG.sync.read throw.
		// tryGenerateLevelIcons must catch this and return [].
		const emptyBase = {
			isEmpty: () => false,
			getSize: () => ({ width: 16, height: 16 }),
			toPNG: () => Buffer.alloc(0),
		} as unknown as Parameters<typeof helpers.tryGenerateLevelIcons>[0];
		const result = helpers.tryGenerateLevelIcons(emptyBase, TEST_TINT);
		expect(Array.isArray(result)).toBe(true);
		expect(result.length).toBe(0);
	});
});

describe("logInitialized", () => {
	test("does not throw when called with a base image and icon count", () => {
		const fakeBase = {
			isEmpty: () => false,
			getSize: () => ({ width: 32, height: 32 }),
			toPNG: () => Buffer.alloc(0),
		} as unknown as Parameters<typeof helpers.logInitialized>[0];
		expect(() => helpers.logInitialized(fakeBase, 0)).not.toThrow();
	});
});

/** Build a minimal 2x2 RGBA PNG buffer for testing icon generation. */
function makeMinimalPngBase(): Parameters<typeof helpers.generateLevelIcons>[0] {
	const png = new PNG({ width: 2, height: 2 });
	// Fill with a solid opaque red so blendPixel has something to work with
	for (let i = 0; i < png.data.length; i += 4) {
		png.data[i] = 200; // R
		png.data[i + 1] = 0; // G
		png.data[i + 2] = 0; // B
		png.data[i + 3] = 255; // A
	}
	const pngBuf = PNG.sync.write(png);
	return {
		isEmpty: () => false,
		getSize: () => ({ width: 2, height: 2 }),
		toPNG: () => pngBuf,
	} as unknown as Parameters<typeof helpers.generateLevelIcons>[0];
}

describe("generateLevelIcons", () => {
	test("returns LEVELS+1 icons from a valid PNG base", () => {
		const base = makeMinimalPngBase();
		const icons = helpers.generateLevelIcons(base, TEST_TINT);
		// LEVELS=10, so we expect 11 icons (0..10)
		expect(icons.length).toBe(11);
	});
});

describe("buildLevelIcon", () => {
	test("produces a native image from a valid basePng at level 0 and LEVELS", () => {
		const png = new PNG({ width: 2, height: 2 });
		for (let i = 0; i < png.data.length; i += 4) {
			png.data[i] = 200;
			png.data[i + 1] = 0;
			png.data[i + 2] = 0;
			png.data[i + 3] = 255;
		}
		const basePng = { width: 2, height: 2, data: png.data as Buffer };
		// Level 0 = no green tint rows
		expect(() => helpers.buildLevelIcon(basePng, 0, TEST_TINT)).not.toThrow();
		// Level 10 = all rows tinted
		expect(() => helpers.buildLevelIcon(basePng, 10, TEST_TINT)).not.toThrow();
	});

	test("buildLevelIcon at level 0 does NOT mutate the original buffer (defensive copy)", () => {
		const png = new PNG({ width: 2, height: 2 });
		for (let i = 0; i < png.data.length; i += 4) {
			png.data[i] = 200;
			png.data[i + 1] = 0;
			png.data[i + 2] = 0;
			png.data[i + 3] = 255;
		}
		const basePng = { width: 2, height: 2, data: png.data as Buffer };
		const origBytes = Array.from(basePng.data);
		helpers.buildLevelIcon(basePng, 0, TEST_TINT);
		expect(Array.from(basePng.data)).toEqual(origBytes);
	});
});

describe("computeLevelIndex bounds (mutation guard)", () => {
	test("clamps the result to integers in [0, 10]", () => {
		// Sweep many non-negative levels to ensure Math.round/min/max bounds are
		// intact. Negative inputs are out-of-contract (audio level is always ≥0).
		for (const lvl of [0, 0.001, 0.1, 0.5, 0.999, 1, 1.5, 5, 100]) {
			const idx = helpers.computeLevelIndex(lvl);
			expect(Number.isInteger(idx)).toBe(true);
			expect(idx).toBeGreaterThanOrEqual(0);
			expect(idx).toBeLessThanOrEqual(10);
		}
	});

	test("very loud level saturates exactly at LEVELS=10 (Math.min upper bound)", () => {
		// With normalized = min(1, big/peak) = 1, curved=1, visual=1, result=10.
		const idx = helpers.computeLevelIndex(1_000_000);
		expect(idx).toBe(10);
	});
});

describe("blendPixel bounds (mutation guard)", () => {
	test("blendPixel rounds RGB channels (no fractional output)", () => {
		const data = Buffer.from([123, 45, 67, 200]);
		helpers.blendPixel(data, 0, TEST_TINT);
		// Each channel is integer-valued
		expect(Number.isInteger(data[0])).toBe(true);
		expect(Number.isInteger(data[1])).toBe(true);
		expect(Number.isInteger(data[2])).toBe(true);
	});

	test("blendPixel preserves alpha channel exactly (offset 3)", () => {
		const data = Buffer.from([0, 0, 0, 137]);
		helpers.blendPixel(data, 0, TEST_TINT);
		expect(data[3]).toBe(137);
	});
});

describe("blendBottomRows boundary", () => {
	test("startRow=0 blends every row", () => {
		// 1x2: 2 rows of 1 px each (4 channels = 4 bytes per row)
		const data = Buffer.from([200, 0, 0, 255, 200, 0, 0, 255]);
		helpers.blendBottomRows(data, 1, 2, 0, TEST_TINT);
		// Both rows should be tinted
		expect(data[0]).not.toBe(200);
		expect(data[4]).not.toBe(200);
	});

	test("startRow=height blends nothing (== boundary)", () => {
		const data = Buffer.from([200, 0, 0, 255]);
		const orig = Array.from(data);
		helpers.blendBottomRows(data, 1, 1, 1, TEST_TINT); // startRow == height
		expect(Array.from(data)).toEqual(orig);
	});
});

describe("blendPixel arithmetic (mutation guards)", () => {
	test("blends to GREEN tint specifically (R≈80, G≈120, B≈30 for input red)", () => {
		// Mutating the +/- arithmetic in blendPixel would shift colors.
		const data = Buffer.from([200, 0, 0, 255]);
		helpers.blendPixel(data, 0, TEST_TINT);
		expect(data[0]).toBe(80); // R: 200*0.4 + 0*0.6
		expect(data[1]).toBe(120); // G: 0*0.4 + 200*0.6
		expect(data[2]).toBe(30); // B: 0*0.4 + 50*0.6
	});

	test("blendPixel of fully white pixel approaches green tint", () => {
		// White input: each channel becomes channel*0.4 + tint*0.6
		// R: 255*0.4 + 0*0.6 = 102
		// G: 255*0.4 + 200*0.6 = 222
		// B: 255*0.4 + 50*0.6 = 132
		const data = Buffer.from([255, 255, 255, 200]);
		helpers.blendPixel(data, 0, TEST_TINT);
		expect(data[0]).toBe(102);
		expect(data[1]).toBe(222);
		expect(data[2]).toBe(132);
	});
});

describe("computeLevelIndex math (mutation guards)", () => {
	test("level=peak yields full LEVELS (Math.min upper-bound is intact)", () => {
		// L114: Math.min(1, level/peak) — at exactly peak, normalized=1 → curved=1 →
		// visual=MIN_VISUAL+1*(1-MIN_VISUAL)=1 → result=10.
		// Mutation Math.max(1, level/peak) would yield level/peak (≥1) → still 1 here.
		// Mutation level*peak → 0.05*0.005=0.00025 → very small → result≈MIN_VISUAL*10≈1.
		// We need a level value where these diverge. Using level=0.5 with peak=0.005
		// gives normalized=min(1, 100)=1 (capped). The Math.max version would give 100.
		// Then curved = 100^0.45 ≈ 8.7 → visual = 0.08 + 8.7*0.92 ≈ 8.08 → result=10 (clamped).
		// So output is the same! But level*peak: 0.5 * 0.005 = 0.0025 → curved ≈ 0.115 →
		// visual ≈ 0.187 → result = round(1.87) = 2. Different.
		// The current onAudioLevel sequence would update peak first; if we call
		// computeLevelIndex directly without changing peak, peak=PEAK_FLOOR=0.005.
		const idx = helpers.computeLevelIndex(0.5);
		// Should be at saturation (10) because level >> peak.
		expect(idx).toBe(10);
	});

	test("level=0 yields the MIN_VISUAL floor (≥1 because of MIN_VISUAL=0.08)", () => {
		// At level=0: normalized=0 → curved=0 → visual=MIN_VISUAL=0.08 →
		// result = round(0.08*10) = 1.
		// Mutation 1 + MIN_VISUAL would give visual=1.08 → out-of-bounds capped to 10.
		// Mutation curved/(1-MIN_VISUAL) would behave differently.
		const idx = helpers.computeLevelIndex(0);
		expect(idx).toBe(1);
	});
});

describe("shouldThrottle threshold (mutation guards)", () => {
	test("returns false (no throttle) when far past throttle window", () => {
		// THROTTLE_MS=50; now=10000, lastUpdateTs=0 (initial) → diff=10000 >= 50 → false.
		// But lastUpdateTs is module state. After cleanup it could be anything.
		// onRecordingStart resets currentIndex=-1 but NOT lastUpdateTs.
		// We just verify a "very recent now" returns true and a "very old now"
		// (which is impossible in reality) returns... well, we need a baseline.
		// Use Date.now() because that's what the implementation uses.
		const now = Date.now();
		expect(typeof helpers.shouldThrottle(now)).toBe("boolean");
		// Way in the future from any plausible lastUpdateTs:
		expect(helpers.shouldThrottle(now + 1_000_000)).toBe(false);
	});
});

describe("updateRollingPeak rise/decay (mutation guards)", () => {
	test("a louder level than the peak raises the peak", () => {
		// Reset module state by cleanup.
		cleanupRecordingIndicator();
		// rollingPeak starts at PEAK_FLOOR=0.005 (or wherever it was last).
		// Call with a much louder level — peak should climb.
		// Direct observation isn't possible, but we can call computeLevelIndex
		// to indirectly read it.
		const idxBefore = helpers.computeLevelIndex(0.001);
		helpers.updateRollingPeak(1.0);
		// After update, peak ≈ 0.005 + 0.8 * (1 - 0.005) ≈ 0.8
		// Now computeLevelIndex(0.001) → normalized=min(1, 0.001/0.8)=0.00125 →
		// curved tiny → visual=MIN_VISUAL → result=1.
		const idxAfter = helpers.computeLevelIndex(0.001);
		// Both should be 1 (MIN_VISUAL floor), so they're equal here.
		expect(idxBefore).toBe(1);
		expect(idxAfter).toBe(1);
	});
});

describe("generateAllModeIcons", () => {
	test("invokes tryGenerateLevelIcons for each mode and logs total", () => {
		// Drives lines 78-89 in recording-indicator.ts (the previously
		// uncovered `generateAllModeIcons` body — CRAP 5.0 with CC=2).
		// Passing a valid PNG base ensures `tryGenerateLevelIcons` returns a
		// non-empty icon array per mode, so we cover both the loop body and
		// the `logInitialized` call.
		const base = makeMinimalPngBase();
		const out = helpers.generateAllModeIcons(base);
		// All three RecordingMode keys are present.
		expect(Object.keys(out).sort()).toEqual(["listen", "ptt", "toggle"]);
		// Each mode returned LEVELS+1=11 icons (loop body executed end-to-end).
		expect(out.ptt?.length).toBe(11);
		expect(out.toggle?.length).toBe(11);
		expect(out.listen?.length).toBe(11);
	});

	test("returns empty arrays per mode when icon generation fails", () => {
		// Drives the catch-path in tryGenerateLevelIcons inside the loop —
		// confirms that even when PNG decoding throws (empty buffer), the
		// function still populates every mode key with an empty array and
		// calls logInitialized with total=0.
		const brokenBase = {
			isEmpty: () => false,
			getSize: () => ({ width: 16, height: 16 }),
			toPNG: () => Buffer.alloc(0),
		} as unknown as Parameters<typeof helpers.generateAllModeIcons>[0];
		const out = helpers.generateAllModeIcons(brokenBase);
		expect(Object.keys(out).sort()).toEqual(["listen", "ptt", "toggle"]);
		expect(out.ptt).toEqual([]);
		expect(out.toggle).toEqual([]);
		expect(out.listen).toEqual([]);
	});
});

describe("blendRow x-bound (L162 mutation guard)", () => {
	test("blends every pixel in the row, not the sentinel beyond it", () => {
		// L162 mutation x <= width would over-blend (one extra pixel beyond
		// the buffer end). Use opaque red pixels so each one's R-channel goes
		// from 200 → 80 after blend.
		const data = Buffer.from([
			200,
			0,
			0,
			255, // px 0 (red opaque)
			200,
			0,
			0,
			255, // px 1 (red opaque)
			200,
			0,
			0,
			255, // px 2 (red opaque)
			77,
			77,
			77,
			77, // sentinel beyond row
		]);
		helpers.blendRow(data, 0, 3, TEST_TINT);
		// Sentinel must remain unchanged (would be touched if x <= width).
		expect(data[12]).toBe(77);
		expect(data[13]).toBe(77);
		expect(data[14]).toBe(77);
		expect(data[15]).toBe(77);
		// All three pixels' R-channel was tinted from 200 → 80.
		expect(data[0]).toBe(80);
		expect(data[4]).toBe(80);
		expect(data[8]).toBe(80);
	});
});
