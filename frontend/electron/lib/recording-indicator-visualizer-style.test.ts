import { describe, expect, mock, test } from "bun:test";

// The indicator imports { nativeImage } from "electron" and `dbg` from
// ./debug-log. Stub both so the rasterizers run headless. createFromBuffer
// round-trips the buffer so we can assert the PNG is non-empty + 48×48.
const makeFakeNativeImage = (buf: Buffer) => ({
	__buf: buf,
	toPNG: () => buf,
	isEmpty: () => buf.length === 0,
	getSize: () => ({ width: 48, height: 48 }),
});

mock.module("electron", () => ({
	nativeImage: {
		createFromPath: () => makeFakeNativeImage(Buffer.from("path-icon")),
		createFromBuffer: (buf: Buffer) => makeFakeNativeImage(buf),
		createEmpty: () => makeFakeNativeImage(Buffer.alloc(0)),
	},
}));
mock.module("./debug-log", () => ({ dbg: () => undefined }));

const {
	setTrayVisualizerStyle,
	renderGridIcon,
	renderRadialIcon,
	renderWaveIcon,
	renderAuraIcon,
	isSpeakingCellHighlighted,
	__recording_indicator_test_helpers__: h,
} = await import("./recording-indicator");

const INK: readonly [number, number, number] = [255, 255, 255];

function bufOf(img: unknown): Buffer {
	return (img as { __buf: Buffer }).__buf;
}

describe("setTrayVisualizerStyle", () => {
	test("accepts each canonical style", () => {
		for (const style of ["bar", "grid", "radial", "wave", "aura"] as const) {
			setTrayVisualizerStyle({ visualizerType: style });
			expect(h.getVisualizerStyle()).toBe(style);
		}
	});

	test("falls back to 'bar' for unknown / missing / wrong-typed style", () => {
		setTrayVisualizerStyle({ visualizerType: "nonsense" });
		expect(h.getVisualizerStyle()).toBe("bar");
		setTrayVisualizerStyle({ visualizerType: 42 });
		expect(h.getVisualizerStyle()).toBe("bar");
		setTrayVisualizerStyle(null);
		expect(h.getVisualizerStyle()).toBe("bar");
		setTrayVisualizerStyle(undefined);
		expect(h.getVisualizerStyle()).toBe("bar");
	});

	test("clamps per-shape knobs into the legible tray range", () => {
		setTrayVisualizerStyle({
			visualizerType: "grid",
			visualizerGridRows: 99,
			visualizerGridColumns: 1,
			visualizerRadialDotCount: 1000,
			visualizerWaveLineWidth: 0,
			visualizerAuraShape: "line",
			visualizerAuraBlur: 250,
		});
		const cfg = h.getVisualizerConfig();
		expect(cfg.gridRows).toBe(8);
		expect(cfg.gridColumns).toBe(3);
		expect(cfg.radialDotCount).toBe(24);
		expect(cfg.waveLineWidth).toBe(1);
		expect(cfg.auraShape).toBe("line");
		expect(cfg.auraBlur).toBe(1);
	});

	test("uses defaults for missing knobs", () => {
		setTrayVisualizerStyle({ visualizerType: "grid" });
		const cfg = h.getVisualizerConfig();
		expect(cfg.gridRows).toBe(5);
		expect(cfg.gridColumns).toBe(5);
		expect(cfg.radialDotCount).toBe(24);
		expect(cfg.waveLineWidth).toBe(2);
		expect(cfg.auraShape).toBe("circle");
		expect(cfg.auraBlur).toBeCloseTo(0.2);
	});
});

describe("isSpeakingCellHighlighted", () => {
	test("middle row always lights up (zero threshold)", () => {
		// 5 cols × 5 rows → mid row = 2. index 10 = row 2 col 0.
		expect(isSpeakingCellHighlighted(10, 5, 5, [0, 0, 0, 0, 0])).toBe(true);
	});

	test("outer rows need a louder band", () => {
		// index 0 = row 0 col 0, the farthest row → highest threshold.
		expect(isSpeakingCellHighlighted(0, 5, 5, [0.1, 0, 0, 0, 0])).toBe(false);
		expect(isSpeakingCellHighlighted(0, 5, 5, [1, 0, 0, 0, 0])).toBe(true);
	});
});

describe("style rasterizers produce non-empty 48×48 icons", () => {
	test("grid", () => {
		setTrayVisualizerStyle({ visualizerType: "grid" });
		const img = renderGridIcon(0.8, 1.23, INK);
		expect(img.getSize()).toEqual({ width: 48, height: 48 });
		expect(bufOf(img).length).toBeGreaterThan(0);
	});

	test("radial", () => {
		setTrayVisualizerStyle({ visualizerType: "radial" });
		expect(bufOf(renderRadialIcon(0.8, 1.23, INK)).length).toBeGreaterThan(0);
	});

	test("wave", () => {
		setTrayVisualizerStyle({ visualizerType: "wave" });
		expect(bufOf(renderWaveIcon(0.5, 1.23, INK)).length).toBeGreaterThan(0);
		// silent frame still rasterizes a (flat) line
		expect(bufOf(renderWaveIcon(0, 0, INK)).length).toBeGreaterThan(0);
	});

	test("aura — circle and line", () => {
		setTrayVisualizerStyle({ visualizerType: "aura", visualizerAuraShape: "circle" });
		expect(bufOf(renderAuraIcon(0.7, 1.23, INK)).length).toBeGreaterThan(0);
		setTrayVisualizerStyle({ visualizerType: "aura", visualizerAuraShape: "line" });
		expect(bufOf(renderAuraIcon(0.7, 1.23, INK)).length).toBeGreaterThan(0);
	});
});

describe("renderVisualizerFrame dispatch", () => {
	test("routes to the active style and always returns an icon", () => {
		for (const style of ["bar", "grid", "radial", "wave", "aura"] as const) {
			setTrayVisualizerStyle({ visualizerType: style });
			const img = h.renderVisualizerFrame(0.6, 0.6, 2.0);
			expect(bufOf(img).length).toBeGreaterThan(0);
		}
	});
});
