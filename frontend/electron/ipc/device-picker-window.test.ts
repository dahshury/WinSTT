import { describe, expect, mock, test } from "bun:test";
import { electronMock } from "@test/mocks/electron";
import { uiohookMock } from "@test/mocks/uiohook-napi";

mock.module("electron", () => ({ ...electronMock() }));
mock.module("uiohook-napi", () => ({ ...uiohookMock() }));

const { __device_picker_window_test_helpers__: H } = await import("./device-picker-window");

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1040 };

describe("computePickerPosition", () => {
	test("bottom glued above the row, right-aligned to the row's right edge", () => {
		// Row right at x=900, top at y=1000; 320×360 picker + 6px gap →
		// y = 1000-360-6 = 634, x = 900-320 = 580.
		const pos = H.computePickerPosition(
			{ screenLeft: 700, screenRight: 900, screenTopY: 1000 },
			{ width: 320, height: 360 },
			WORK_AREA
		);
		expect(pos).toEqual({ x: 580, y: 634, width: 320, height: 360 });
	});

	test("shrinks height instead of crossing the screen top, bottom stays put", () => {
		// Only 200px above the row → height capped to 200-6=194, top pinned
		// to the work-area top, bottom still ANCHOR_GAP above the row.
		const pos = H.computePickerPosition(
			{ screenLeft: 300, screenRight: 620, screenTopY: 200 },
			{ width: 320, height: 360 },
			WORK_AREA
		);
		expect(pos.height).toBe(194);
		expect(pos.y).toBe(0);
		expect(pos.y + pos.height).toBe(200 - 6);
	});

	test("clamps x into the work area", () => {
		const pos = H.computePickerPosition(
			{ screenLeft: 1900, screenRight: 1960, screenTopY: 1000 },
			{ width: 320, height: 360 },
			WORK_AREA
		);
		expect(pos.x).toBe(1600); // 1920 - 320
	});
});

describe("fade easing", () => {
	test("easeOutCubic: fast then gentle, clamped endpoints", () => {
		expect(H.easeOutCubic(0)).toBe(0);
		expect(H.easeOutCubic(1)).toBe(1);
		expect(H.easeOutCubic(0.5)).toBeGreaterThan(0.5);
	});

	test("easeInCubic: gentle then fast, clamped endpoints", () => {
		expect(H.easeInCubic(0)).toBe(0);
		expect(H.easeInCubic(1)).toBe(1);
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
		expect(H.normalizeResizePayload({ width: 319.2, height: 359.9 })).toEqual({
			width: 320,
			height: 360,
		});
		expect(H.normalizeResizePayload({ width: 0, height: -5 })).toEqual({ width: 1, height: 1 });
	});
});

describe("sizeUnchanged", () => {
	test("compares width and height exactly", () => {
		expect(H.sizeUnchanged({ width: 320, height: 360 }, { width: 320, height: 360 })).toBe(true);
		expect(H.sizeUnchanged({ width: 320, height: 360 }, { width: 320, height: 361 })).toBe(false);
	});
});

describe("url guards", () => {
	test("isHttpUrl matches http/https only", () => {
		expect(H.isHttpUrl("https://example.com")).toBe(true);
		expect(H.isHttpUrl("http://example.com")).toBe(true);
		expect(H.isHttpUrl("file:///c:/x")).toBe(false);
	});

	test("isSameOrigin compares origins and tolerates garbage", () => {
		expect(H.isSameOrigin("http://localhost:3000/device-picker", "http://localhost:3000/")).toBe(
			true
		);
		expect(H.isSameOrigin("http://evil.test/", "http://localhost:3000/")).toBe(false);
		expect(H.isSameOrigin("not-a-url", "http://localhost:3000/")).toBe(false);
	});
});
