import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { __waveform_test_helpers__, WaveformBars } from "./WaveformBars";

const {
	computeTargetAmp,
	computeRenderParams,
	computeActivityTarget,
	hasAudioInput,
	isAudioActive,
	getDpr,
	ensureCanvasSize,
	getCanvasMetrics,
	drawBaseline,
	tracePath,
} = __waveform_test_helpers__;

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
	function makeCtx(): { ctx: CanvasRenderingContext2D; calls: [string, number, number][] } {
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
