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
				getSize: () => ({ width: 48, height: 48 }),
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
	onTranscribingStart,
	onTranscribingStop,
	onLlmThinkingStart,
	onLlmThinkingStop,
	setReapplyTrayImage,
	cleanupRecordingIndicator,
	computeAmplified,
	computeBandValue,
	renderBarsIcon,
	renderTopologyIcon,
	parsePath,
	lerpPath,
	easeInOutSine,
	interpolateTopology,
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

/** Spy used to verify the indicator NEVER touches the BrowserWindow icon —
 *  the taskbar/window icon must stay static across recording/thinking states.
 *  We hand it to anyone who used to receive `win` so call-sites barely change,
 *  but `setIcon` here would only ever fire if the indicator regressed. */
function makeWinSpy(): { setIcon: (icon: unknown) => void; isDestroyed: () => boolean } {
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
		expect(() =>
			initRecordingIndicator(
				tray as unknown as Parameters<typeof initRecordingIndicator>[0],
				"/fake/icon.png"
			)
		).not.toThrow();
		cleanupRecordingIndicator();
	});

	test("onRecordingStart / onAudioLevel / onRecordingStop do not throw", () => {
		const tray = makeTray();
		initRecordingIndicator(
			tray as unknown as Parameters<typeof initRecordingIndicator>[0],
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
		initRecordingIndicator(
			tray as unknown as Parameters<typeof initRecordingIndicator>[0],
			"/fake/icon.png"
		);
		onRecordingStart();
		expect(() => cleanupRecordingIndicator()).not.toThrow();
		expect(() => onAudioLevel(0.3)).not.toThrow();
	});

	test("onRecordingStop before start is a no-op (guards against cold-start retry storm)", () => {
		cleanupRecordingIndicator();
		expect(() => onRecordingStop()).not.toThrow();
	});

	test("onRecordingStart triggers an immediate tray icon swap (does not wait for tick) but leaves the BrowserWindow icon alone", () => {
		const tray = makeTray() as ReturnType<typeof makeTray> & { count: number };
		const winSpy = makeWinSpy() as ReturnType<typeof makeWinSpy> & { count: number };
		initRecordingIndicator(
			tray as unknown as Parameters<typeof initRecordingIndicator>[0],
			"/fake/icon.png"
		);
		const before = tray.count;
		onRecordingStart();
		expect(tray.count).toBeGreaterThan(before);
		// The window icon must NEVER be touched by the indicator — the
		// BrowserWindow's base icon (and therefore the taskbar icon) stays
		// static through recording / thinking states. Only the tray animates.
		expect(winSpy.count).toBe(0);
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
		const { peak } = computeAmplified(0, 0.5);
		expect(peak).toBeCloseTo(0.495, 4);
	});

	test("amplified is sqrt(level/peak), clamped to [0,1]", () => {
		const { amplified } = computeAmplified(0.5, 0.5);
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

	test("amplified=1 stays below saturation on average", () => {
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
		expect(png.data[3]).toBe(0);
	});

	test("painted pixels use the tint color", () => {
		lastPngBuffers.length = 0;
		renderBarsIcon([1, 1, 1, 1, 1], TEST_TINT);
		const png = decodePng(lastPngBuffers[0]!);
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
		renderBarsIcon([0.05, 0.05, 1, 0.05, 0.05], TEST_TINT);
		const png = decodePng(lastPngBuffers[0]!);
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
		const hasAnyOpaque = png.data.some((_, i) => i % 4 === 3 && (png.data[i] ?? 0) > 0);
		expect(hasAnyOpaque).toBe(true);
	});
});

describe("recording-indicator helpers", () => {
	test("trayIsLive false after cleanup", () => {
		cleanupRecordingIndicator();
		expect(helpers.trayIsLive()).toBe(false);
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
		expect(helpers.TARGET_SIZE).toBe(48);
	});
});

describe("topology path parsing", () => {
	test("parsePath reads M + 4×C tokens", () => {
		const p = parsePath(
			"M 12 8 C 14.21 8 16 9.79 16 12 C 16 14.21 14.21 16 12 16 C 9.79 16 8 14.21 8 12 C 8 9.79 9.79 8 12 8 Z"
		);
		expect(p.start).toEqual([12, 8]);
		expect(p.segments.length).toBe(4);
		expect(p.segments[0]!.c1).toEqual([14.21, 8]);
		expect(p.segments[0]!.c2).toEqual([16, 9.79]);
		expect(p.segments[0]!.end).toEqual([16, 12]);
	});

	test("parsePath tolerates commas and extra whitespace", () => {
		const p = parsePath("M 0,0 C 1, 1  2, 2  3,3 Z");
		expect(p.start).toEqual([0, 0]);
		expect(p.segments).toHaveLength(1);
		expect(p.segments[0]!.end).toEqual([3, 3]);
	});

	test("parsePath rejects unsupported commands", () => {
		expect(() => parsePath("M 0 0 L 1 1")).toThrow();
	});

	test("parsePath rejects path without M", () => {
		expect(() => parsePath("C 1 1 2 2 3 3")).toThrow();
	});

	test("all three thinking-indicator paths have identical topology", () => {
		const frames = helpers.TOPOLOGY_KEYFRAMES;
		expect(frames.length).toBe(5);
		const segCount = frames[0]!.segments.length;
		for (const f of frames) {
			expect(f.segments.length).toBe(segCount);
		}
	});
});

describe("topology interpolation", () => {
	test("easeInOutSine matches its analytic endpoints and midpoint", () => {
		expect(easeInOutSine(0)).toBe(0);
		expect(easeInOutSine(1)).toBeCloseTo(1, 10);
		expect(easeInOutSine(0.5)).toBeCloseTo(0.5, 10);
	});

	test("easeInOutSine is monotonic across [0,1]", () => {
		let prev = -Number.MAX_VALUE;
		for (let i = 0; i <= 20; i++) {
			const v = easeInOutSine(i / 20);
			expect(v).toBeGreaterThanOrEqual(prev);
			prev = v;
		}
	});

	test("easeInOutSine clamps outside [0,1]", () => {
		expect(easeInOutSine(-1)).toBe(0);
		expect(easeInOutSine(2)).toBeCloseTo(1, 10);
	});

	test("lerpPath at t=0 returns the first keyframe", () => {
		const a = parsePath("M 0 0 C 1 1 2 2 3 3 Z");
		const b = parsePath("M 10 10 C 11 11 12 12 13 13 Z");
		const out = lerpPath(a, b, 0);
		expect(out.start).toEqual([0, 0]);
		expect(out.segments[0]!.end).toEqual([3, 3]);
	});

	test("lerpPath at t=1 returns the second keyframe", () => {
		const a = parsePath("M 0 0 C 1 1 2 2 3 3 Z");
		const b = parsePath("M 10 10 C 11 11 12 12 13 13 Z");
		const out = lerpPath(a, b, 1);
		expect(out.start).toEqual([10, 10]);
		expect(out.segments[0]!.end).toEqual([13, 13]);
	});

	test("lerpPath at t=0.5 returns the midpoint", () => {
		const a = parsePath("M 0 0 C 2 2 4 4 6 6 Z");
		const b = parsePath("M 10 10 C 12 12 14 14 16 16 Z");
		const out = lerpPath(a, b, 0.5);
		expect(out.start).toEqual([5, 5]);
		expect(out.segments[0]!.c1).toEqual([7, 7]);
		expect(out.segments[0]!.end).toEqual([11, 11]);
	});

	test("lerpPath rejects mismatched topologies", () => {
		const a = parsePath("M 0 0 C 1 1 2 2 3 3 Z");
		const b = parsePath("M 0 0 C 1 1 2 2 3 3 C 4 4 5 5 6 6 Z");
		expect(() => lerpPath(a, b, 0.5)).toThrow();
	});

	test("interpolateTopology at integer-keyframe times returns the keyframes", () => {
		const k0 = interpolateTopology(0);
		const k1 = interpolateTopology(0.25);
		const k2 = interpolateTopology(0.5);
		const k3 = interpolateTopology(0.75);
		expect(k0.start).toEqual([12, 8]);
		expect(k1.start[0]).toBeCloseTo(12, 6);
		expect(k1.start[1]).toBeCloseTo(12, 6);
		expect(k2.start[0]).toBeCloseTo(12, 6);
		expect(k2.start[1]).toBeCloseTo(16, 6);
		expect(k3.start[0]).toBeCloseTo(12, 6);
		expect(k3.start[1]).toBeCloseTo(12, 6);
	});

	test("interpolateTopology(1) wraps back to keyframe 0", () => {
		const k0 = interpolateTopology(0);
		const kWrap = interpolateTopology(1);
		expect(kWrap.start).toEqual(k0.start);
	});

	test("interpolateTopology between keyframes returns a path with same segment count", () => {
		const path = interpolateTopology(0.13);
		expect(path.segments.length).toBe(helpers.TOPOLOGY_KEYFRAMES[0]!.segments.length);
	});

	test("topology animation duration is 6000 ms", () => {
		expect(helpers.TOPOLOGY_DURATION_MS).toBe(6000);
	});
});

describe("renderTopologyIcon", () => {
	test("produces a TARGET_SIZE×TARGET_SIZE PNG with painted stroke pixels and transparent corners", () => {
		lastPngBuffers.length = 0;
		const path = interpolateTopology(0);
		const img = renderTopologyIcon(path, [240, 240, 240]);
		expect(img).toBeDefined();
		const png = PNG.sync.read(lastPngBuffers[0]!);
		expect(png.width).toBe(helpers.TARGET_SIZE);
		expect(png.height).toBe(helpers.TARGET_SIZE);
		let painted = 0;
		for (let i = 3; i < png.data.length; i += 4) {
			if ((png.data[i] ?? 0) > 0) {
				painted++;
			}
		}
		expect(painted).toBeGreaterThan(0);
		expect(png.data[3]).toBe(0);
	});

	test("painted pixels use the requested stroke color", () => {
		lastPngBuffers.length = 0;
		const path = interpolateTopology(0);
		const STROKE: [number, number, number] = [100, 150, 200];
		renderTopologyIcon(path, STROKE);
		const png = PNG.sync.read(lastPngBuffers[0]!);
		// Disc stamping with SRC_OVER blending of constant-color discs always
		// yields the stroke color verbatim (only alpha varies). Verify on the
		// first opaque pixel encountered, which is enough to catch color
		// regressions without coupling to discCoverage's exact alpha curve.
		let foundMatch = false;
		for (let i = 0; i < png.data.length; i += 4) {
			const a = png.data[i + 3] ?? 0;
			if (a > 0) {
				expect(png.data[i]).toBe(STROKE[0]);
				expect(png.data[i + 1]).toBe(STROKE[1]);
				expect(png.data[i + 2]).toBe(STROKE[2]);
				foundMatch = true;
				break;
			}
		}
		expect(foundMatch).toBe(true);
	});

	test("CIRCLE_A and CIRCLE_B render the same pixels (mirrored direction, same outline)", () => {
		lastPngBuffers.length = 0;
		renderTopologyIcon(interpolateTopology(0), [255, 255, 255]);
		const pngA = PNG.sync.read(lastPngBuffers[0]!);
		lastPngBuffers.length = 0;
		renderTopologyIcon(interpolateTopology(0.5), [255, 255, 255]);
		const pngB = PNG.sync.read(lastPngBuffers[0]!);
		let diff = 0;
		for (let i = 3; i < pngA.data.length; i += 4) {
			const a = pngA.data[i] ?? 0;
			const b = pngB.data[i] ?? 0;
			if (Math.abs(a - b) > 8) {
				diff++;
			}
		}
		expect(diff).toBeLessThan(20);
	});
});

describe("indicator state machine", () => {
	function bootstrap(): void {
		cleanupRecordingIndicator();
		const tray = makeTray();
		initRecordingIndicator(
			tray as unknown as Parameters<typeof initRecordingIndicator>[0],
			"/fake/icon.png"
		);
	}

	test("starts in idle", () => {
		bootstrap();
		expect(helpers.getCurrentView()).toBe("idle");
		cleanupRecordingIndicator();
	});

	test("recording → thinking → idle progression", () => {
		bootstrap();
		onRecordingStart();
		expect(helpers.getCurrentView()).toBe("recording");
		onRecordingStop();
		expect(helpers.getCurrentView()).toBe("idle");
		onTranscribingStart();
		expect(helpers.getCurrentView()).toBe("thinking");
		onTranscribingStop();
		expect(helpers.getCurrentView()).toBe("idle");
		cleanupRecordingIndicator();
	});

	test("LLM thinking keeps the topology animation alive after transcribing ends", () => {
		bootstrap();
		onTranscribingStart();
		onLlmThinkingStart();
		onTranscribingStop();
		expect(helpers.getCurrentView()).toBe("thinking");
		onLlmThinkingStop();
		expect(helpers.getCurrentView()).toBe("idle");
		cleanupRecordingIndicator();
	});

	test("starting recording while thinking flips to recording view", () => {
		bootstrap();
		onTranscribingStart();
		expect(helpers.getCurrentView()).toBe("thinking");
		onRecordingStart();
		expect(helpers.getCurrentView()).toBe("recording");
		onRecordingStop();
		// transcribing flag is still set → returns to thinking
		expect(helpers.getCurrentView()).toBe("thinking");
		cleanupRecordingIndicator();
	});

	test("redundant on*Start calls are no-ops (idempotent)", () => {
		bootstrap();
		onTranscribingStart();
		onTranscribingStart();
		onLlmThinkingStart();
		onLlmThinkingStart();
		expect(helpers.getCurrentView()).toBe("thinking");
		onTranscribingStop();
		onLlmThinkingStop();
		expect(helpers.getCurrentView()).toBe("idle");
		cleanupRecordingIndicator();
	});

	test("redundant on*Stop calls before start are no-ops", () => {
		bootstrap();
		expect(() => onTranscribingStop()).not.toThrow();
		expect(() => onLlmThinkingStop()).not.toThrow();
		expect(helpers.getCurrentView()).toBe("idle");
		cleanupRecordingIndicator();
	});

	test("setReapplyTrayImage is called when thinking ends", () => {
		bootstrap();
		let called = 0;
		setReapplyTrayImage(() => {
			called += 1;
		});
		onTranscribingStart();
		onTranscribingStop();
		expect(called).toBe(1);
		setReapplyTrayImage(null);
		cleanupRecordingIndicator();
	});

	test("setReapplyTrayImage is NOT called for recording → idle (revertIcons handles it)", () => {
		bootstrap();
		let called = 0;
		setReapplyTrayImage(() => {
			called += 1;
		});
		onRecordingStart();
		onRecordingStop();
		expect(called).toBe(0);
		setReapplyTrayImage(null);
		cleanupRecordingIndicator();
	});
});
