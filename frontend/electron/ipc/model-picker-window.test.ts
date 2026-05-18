import { describe, expect, mock, test } from "bun:test";
import { electronMock } from "@test/mocks/electron";

mock.module("electron", () => ({ ...electronMock() }));

const { __model_picker_window_test_helpers__: H } = await import("./model-picker-window");

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1040 };

describe("computePickerPosition", () => {
	test("bottom glued above the chip, right-aligned to the chip's right edge", () => {
		// Chip right at x=900, top at y=1000; 600×560 picker + 6px gap →
		// y = 1000-560-6 = 434, x = 900-600 = 300.
		const pos = H.computePickerPosition(
			{ screenLeft: 800, screenRight: 900, screenTopY: 1000 },
			{ width: 600, height: 560 },
			WORK_AREA
		);
		expect(pos).toEqual({ x: 300, y: 434, width: 600, height: 560 });
	});

	test("shrinks height instead of crossing the screen top, bottom stays put", () => {
		// Only 300px above the chip → height capped to 300-6=294, top pinned
		// to the work-area top, bottom still ANCHOR_GAP above the chip.
		const pos = H.computePickerPosition(
			{ screenLeft: 300, screenRight: 900, screenTopY: 300 },
			{ width: 600, height: 560 },
			WORK_AREA
		);
		expect(pos.height).toBe(294);
		expect(pos.y).toBe(0);
		expect(pos.y + pos.height).toBe(300 - 6);
	});

	test("clamps x into the work area", () => {
		const pos = H.computePickerPosition(
			{ screenLeft: 1900, screenRight: 1960, screenTopY: 1000 },
			{ width: 600, height: 560 },
			WORK_AREA
		);
		expect(pos.x).toBe(1320); // 1920 - 600
	});
});

describe("fade easing", () => {
	test("easeOutCubic: fast then gentle, clamped endpoints", () => {
		expect(H.easeOutCubic(0)).toBe(0);
		expect(H.easeOutCubic(1)).toBe(1);
		// Ease-out is past the midpoint by t=0.5 (decelerating).
		expect(H.easeOutCubic(0.5)).toBeGreaterThan(0.5);
	});

	test("easeInCubic: gentle then fast, clamped endpoints", () => {
		expect(H.easeInCubic(0)).toBe(0);
		expect(H.easeInCubic(1)).toBe(1);
		// Ease-in lags behind the midpoint at t=0.5 (accelerating).
		expect(H.easeInCubic(0.5)).toBeLessThan(0.5);
	});
});

describe("isOpenPayload", () => {
	test("accepts a full numeric rect and rejects anything else", () => {
		expect(H.isOpenPayload({ x: 12, y: 34, width: 56, height: 78 })).toBe(true);
		expect(H.isOpenPayload({ x: 12, y: 34 })).toBe(false);
		expect(H.isOpenPayload({ x: "12", y: 34, width: 1, height: 1 })).toBe(false);
		expect(H.isOpenPayload(null)).toBe(false);
		expect(H.isOpenPayload(undefined)).toBe(false);
		expect(H.isOpenPayload("nope")).toBe(false);
	});
});

describe("normalizeResizePayload", () => {
	test("ceils and floors to at least 1px", () => {
		expect(H.normalizeResizePayload({ width: 599.2, height: 559.9 })).toEqual({
			width: 600,
			height: 560,
		});
		expect(H.normalizeResizePayload({ width: 0, height: -5 })).toEqual({ width: 1, height: 1 });
	});
});

describe("sizeUnchanged", () => {
	test("compares width and height exactly", () => {
		expect(H.sizeUnchanged({ width: 600, height: 560 }, { width: 600, height: 560 })).toBe(true);
		expect(H.sizeUnchanged({ width: 600, height: 560 }, { width: 600, height: 561 })).toBe(false);
	});
});

describe("url guards", () => {
	test("isHttpUrl matches http/https only", () => {
		expect(H.isHttpUrl("https://example.com")).toBe(true);
		expect(H.isHttpUrl("http://example.com")).toBe(true);
		expect(H.isHttpUrl("file:///c:/x")).toBe(false);
	});

	test("isSameOrigin compares origins and tolerates garbage", () => {
		expect(H.isSameOrigin("http://localhost:3000/model-picker", "http://localhost:3000/")).toBe(
			true
		);
		expect(H.isSameOrigin("http://evil.test/", "http://localhost:3000/")).toBe(false);
		expect(H.isSameOrigin("not-a-url", "http://localhost:3000/")).toBe(false);
	});
});
