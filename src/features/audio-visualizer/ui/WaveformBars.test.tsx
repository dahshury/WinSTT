import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import * as helpers from "../lib/waveform-bars-test-helpers";
import { WaveformBars } from "./WaveformBars";

const {
	activeWaveAmp,
	buildWavePoints,
	computeActivityTarget,
	computeRenderParams,
	computeTargetAmp,
	computeWaveY,
	drawBaseline,
	drawFilledRegion,
	drawWavePath,
	ensureCanvasSize,
	getCanvasMetrics,
	getDpr,
	hasAudioInput,
	isAudioActive,
	lerpColor,
	tracePath,
	vadAmpBoost,
} = helpers;

describe("WaveformBars", () => {
	test("renders an aria-hidden canvas wrapper", () => {
		const { container } = render(<WaveformBars />);
		const wrapper = container.firstElementChild as HTMLElement;
		expect(wrapper.getAttribute("aria-hidden")).toBe("true");
		expect(wrapper.querySelector("canvas")).not.toBeNull();
	});

	test("memo-wrapped: identical re-render does not change the rendered tree", () => {
		const { container, rerender } = render(<WaveformBars />);
		const before = container.innerHTML;
		rerender(<WaveformBars />);
		expect(container.innerHTML).toBe(before);
	});
});

describe("hasAudioInput", () => {
	test.each([
		[false, 0, false],
		[true, 0, true],
		[false, 0.1, true],
		[true, 0.5, true],
	])("(%p, %p) → %p", (rec, lvl, expected) => {
		expect(hasAudioInput(rec, lvl)).toBe(expected);
	});
});

describe("isAudioActive", () => {
	test("speaking flag forces active regardless of level", () => {
		expect(isAudioActive(true, 0)).toBe(true);
	});
	test("level above threshold counts as active", () => {
		expect(isAudioActive(false, 0.5)).toBe(true);
	});
	test("level at zero with no speaking is inactive", () => {
		expect(isAudioActive(false, 0)).toBe(false);
	});
});

describe("computeActivityTarget", () => {
	test("returns 1 when input present and speaking", () => {
		expect(computeActivityTarget(true, true, 0)).toBe(1);
	});
	test("returns 0 when no input present", () => {
		expect(computeActivityTarget(false, true, 0)).toBe(0);
	});
	test("returns 0 when input present but not active (level below threshold)", () => {
		expect(computeActivityTarget(true, false, 0.001)).toBe(0);
	});
});

describe("computeTargetAmp", () => {
	test("returns 0 when no recording and no audio level", () => {
		expect(computeTargetAmp(false, false, 0, 0)).toBe(0);
	});
	test("recording without audio still produces idle amp + components", () => {
		const amp = computeTargetAmp(true, false, 0, 0);
		expect(amp).toBeGreaterThan(0);
	});
	test("speaking adds a vad boost", () => {
		const ampNoVad = computeTargetAmp(true, false, 0.1, 0);
		const ampWithVad = computeTargetAmp(true, true, 0.1, 0);
		expect(ampWithVad).toBeGreaterThan(ampNoVad);
	});
	test("sentence pulse contributes to amp", () => {
		const ampNoPulse = computeTargetAmp(true, false, 0.1, 0);
		const ampWithPulse = computeTargetAmp(true, false, 0.1, 0.5);
		expect(ampWithPulse).toBeGreaterThan(ampNoPulse);
	});
});

describe("vadAmpBoost", () => {
	test("returns 0.04 when speaking", () => {
		expect(vadAmpBoost(true)).toBe(0.04);
	});
	test("returns 0 when not speaking", () => {
		expect(vadAmpBoost(false)).toBe(0);
	});
});

describe("activeWaveAmp", () => {
	test("is monotonic in audioLevel", () => {
		expect(activeWaveAmp(0.5, false, 0)).toBeGreaterThan(
			activeWaveAmp(0.1, false, 0),
		);
	});
	test("is monotonic in sentencePulse", () => {
		expect(activeWaveAmp(0.1, false, 0.5)).toBeGreaterThan(
			activeWaveAmp(0.1, false, 0),
		);
	});
	test("speaking shifts the amp by the VAD boost", () => {
		const diff = activeWaveAmp(0.1, true, 0) - activeWaveAmp(0.1, false, 0);
		expect(diff).toBeCloseTo(0.04, 5);
	});
});

describe("computeRenderParams", () => {
	test("returns RenderParams with all expected keys", () => {
		const p = computeRenderParams(true, false, 0.5, 0, 0.5);
		expect(typeof p.color).toBe("string");
		expect(p.fillAlpha).toBeGreaterThan(0);
		expect(p.targetAmp).toBeGreaterThan(0);
		expect(p.lineWidthMain).toBeGreaterThan(p.lineWidthMirror);
	});
});

describe("getDpr", () => {
	test("returns a number ≥ 1", () => {
		expect(getDpr()).toBeGreaterThanOrEqual(1);
	});
});

describe("ensureCanvasSize", () => {
	test("updates width/height when they don't match dpr-scaled values", () => {
		const canvas = document.createElement("canvas");
		canvas.width = 100;
		canvas.height = 100;
		ensureCanvasSize(canvas, 200, 100, 2);
		expect(canvas.width).toBe(400);
		expect(canvas.height).toBe(200);
	});
	test("leaves canvas unchanged when sizes already match", () => {
		const canvas = document.createElement("canvas");
		canvas.width = 200;
		canvas.height = 200;
		ensureCanvasSize(canvas, 100, 100, 2);
		expect(canvas.width).toBe(200);
		expect(canvas.height).toBe(200);
	});
});

describe("getCanvasMetrics", () => {
	test("returns null when getContext returns null", () => {
		const canvas = document.createElement("canvas");
		const container = document.createElement("div");
		// Override getContext to return null (simulating unavailable 2d ctx)
		canvas.getContext = (() => null) as never;
		const m = getCanvasMetrics(canvas, container);
		expect(m).toBeNull();
	});
	test("returns a metrics object with non-negative dimensions when getContext succeeds", () => {
		const canvas = document.createElement("canvas");
		const container = document.createElement("div");
		// Force getContext to return a minimal mock so happy-dom variability
		// doesn't make the test branch on environment.
		canvas.getContext = (() => ({}) as unknown) as typeof canvas.getContext;
		const m = getCanvasMetrics(canvas, container);
		expect(m).not.toBeNull();
		expect(m?.w).toBeGreaterThanOrEqual(0);
		expect(m?.h).toBeGreaterThanOrEqual(0);
		expect(m?.dpr).toBeGreaterThanOrEqual(1);
	});
});

describe("drawBaseline", () => {
	test("invokes ctx.beginPath/moveTo/lineTo/stroke without throwing", () => {
		const calls: string[] = [];
		const ctx = {
			beginPath: () => calls.push("beginPath"),
			moveTo: () => calls.push("moveTo"),
			lineTo: () => calls.push("lineTo"),
			createLinearGradient: () => ({ addColorStop: () => undefined }),
			stroke: () => calls.push("stroke"),
			strokeStyle: "",
			lineWidth: 0,
		} as unknown as CanvasRenderingContext2D;
		drawBaseline(ctx, 100, 100);
		expect(calls).toContain("beginPath");
		expect(calls).toContain("moveTo");
		expect(calls).toContain("lineTo");
		expect(calls).toContain("stroke");
	});
});

describe("tracePath", () => {
	function makeCtx(): {
		ctx: CanvasRenderingContext2D;
		calls: [string, number, number][];
	} {
		const calls: [string, number, number][] = [];
		const ctx = {
			moveTo: (x: number, y: number) => calls.push(["moveTo", x, y]),
			lineTo: (x: number, y: number) => calls.push(["lineTo", x, y]),
		} as unknown as CanvasRenderingContext2D;
		return { ctx, calls };
	}

	test("first point is moveTo, subsequent points are lineTo", () => {
		const { ctx, calls } = makeCtx();
		tracePath(ctx, [
			[0, 0],
			[1, 1],
			[2, 4],
		]);
		expect(calls).toEqual([
			["moveTo", 0, 0],
			["lineTo", 1, 1],
			["lineTo", 2, 4],
		]);
	});

	test("a single point produces only a moveTo", () => {
		const { ctx, calls } = makeCtx();
		tracePath(ctx, [[5, 7]]);
		expect(calls).toEqual([["moveTo", 5, 7]]);
	});

	test("an empty path issues no calls", () => {
		const { ctx, calls } = makeCtx();
		tracePath(ctx, []);
		expect(calls).toEqual([]);
	});
});

describe("computeWaveY", () => {
	test("returns midY when amplitude is 0", () => {
		const midY = 100;
		// With amplitude 0, the wave term vanishes so y should be midY
		const y = computeWaveY(0.5, 0, 0, midY);
		expect(y).toBe(midY);
	});

	test("returns midY at t=0 (edge fade = sin(0) = 0)", () => {
		// edgeFade = sin(t * PI). At t=0, edgeFade=0, so the contribution is 0.
		const y = computeWaveY(0, 1, 0.5, 80);
		expect(y).toBe(80);
	});

	test("returns midY at t=1 (edge fade = sin(PI) ≈ 0)", () => {
		const y = computeWaveY(1, 1, 0.5, 80);
		expect(Math.abs(y - 80)).toBeLessThan(1e-10);
	});

	test("returns a number for t=0.5 with non-zero amplitude", () => {
		const y = computeWaveY(0.5, 0, 0.2, 100);
		expect(typeof y).toBe("number");
		expect(Number.isFinite(y)).toBe(true);
	});
});

describe("buildWavePoints", () => {
	test("returns RESOLUTION+1 points (121)", () => {
		const pts = buildWavePoints(100, 50, 0, 0.1);
		expect(pts).toHaveLength(121);
	});

	test("first point x is 0 and last point x equals w", () => {
		const pts = buildWavePoints(200, 100, 0, 0.1);
		expect(pts[0]![0]).toBe(0);
		expect(pts[120]![0]).toBe(200);
	});

	test("all y values are finite numbers", () => {
		const pts = buildWavePoints(100, 60, 1, 0.1);
		for (const [, y] of pts) {
			expect(Number.isFinite(y)).toBe(true);
		}
	});

	test("zero amplitude produces all y = midY", () => {
		const h = 80;
		const midY = h / 2;
		const pts = buildWavePoints(100, h, 0, 0);
		for (const [, y] of pts) {
			expect(Math.abs(y - midY)).toBeLessThan(1e-10);
		}
	});
});

function makeCanvasCtx() {
	const calls: string[] = [];
	const ctx = {
		beginPath: () => calls.push("beginPath"),
		moveTo: () => calls.push("moveTo"),
		lineTo: () => calls.push("lineTo"),
		closePath: () => calls.push("closePath"),
		fill: () => calls.push("fill"),
		stroke: () => calls.push("stroke"),
		createLinearGradient: () => ({ addColorStop: () => undefined }),
		strokeStyle: "" as unknown,
		lineWidth: 0,
		lineJoin: "" as unknown,
		lineCap: "" as unknown,
		fillStyle: "" as unknown,
	} as unknown as CanvasRenderingContext2D;
	return { ctx, calls };
}

describe("drawWavePath", () => {
	test("calls beginPath and traces points without throwing (non-mirror)", () => {
		const { ctx, calls } = makeCanvasCtx();
		drawWavePath(ctx, 100, 60, 0, 0.1, false);
		expect(calls).toContain("beginPath");
		expect(calls).toContain("moveTo");
	});

	test("calls beginPath and traces points without throwing (mirror)", () => {
		const { ctx, calls } = makeCanvasCtx();
		drawWavePath(ctx, 100, 60, 0, 0.1, true);
		expect(calls).toContain("beginPath");
		expect(calls).toContain("moveTo");
	});
});

describe("drawFilledRegion", () => {
	test("calls beginPath, closePath, and fill", () => {
		const { ctx, calls } = makeCanvasCtx();
		drawFilledRegion(ctx, 100, 60, 0, 0.1, 0.05, "88, 166, 255");
		expect(calls).toContain("beginPath");
		expect(calls).toContain("closePath");
		expect(calls).toContain("fill");
	});

	test("does not throw with zero amplitude", () => {
		const { ctx } = makeCanvasCtx();
		expect(() =>
			drawFilledRegion(ctx, 100, 60, 0, 0, 0, "0, 0, 0"),
		).not.toThrow();
	});
});

describe("lerpColor", () => {
	test("returns the start color when t=0", () => {
		expect(lerpColor("0, 0, 0", "255, 255, 255", 0)).toBe("0, 0, 0");
	});

	test("returns the end color when t=1", () => {
		expect(lerpColor("0, 0, 0", "255, 255, 255", 1)).toBe("255, 255, 255");
	});

	test("returns midpoint when t=0.5", () => {
		expect(lerpColor("0, 0, 0", "100, 200, 50", 0.5)).toBe("50, 100, 25");
	});

	test("returns a string with two commas (r, g, b format)", () => {
		const result = lerpColor("10, 20, 30", "90, 80, 70", 0.5);
		expect(result.split(",")).toHaveLength(3);
	});
});
