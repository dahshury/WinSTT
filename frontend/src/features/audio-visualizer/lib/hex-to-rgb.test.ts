import { describe, expect, test } from "bun:test";
import { DEFAULT_VISUALIZER_COLOR, hexToRgb } from "./hex-to-rgb";

describe("hexToRgb", () => {
	test("parses a 6-digit lowercase hex into normalized [r,g,b]", () => {
		const [r, g, b] = hexToRgb("#1fd5f9");
		expect(r).toBeCloseTo(0x1f / 255, 5);
		expect(g).toBeCloseTo(0xd5 / 255, 5);
		expect(b).toBeCloseTo(0xf9 / 255, 5);
	});

	test("parses a 6-digit uppercase hex equally", () => {
		const [r, g, b] = hexToRgb("#1FD5F9");
		expect(r).toBeCloseTo(0x1f / 255, 5);
		expect(g).toBeCloseTo(0xd5 / 255, 5);
		expect(b).toBeCloseTo(0xf9 / 255, 5);
	});

	test("returns black components in the [0,1] range", () => {
		expect(hexToRgb("#000000")).toEqual([0, 0, 0]);
	});

	test("returns white as [1,1,1]", () => {
		expect(hexToRgb("#ffffff")).toEqual([1, 1, 1]);
	});

	test("falls back to default for malformed input", () => {
		const fallback = hexToRgb("not a hex");
		expect(fallback).toHaveLength(3);
		expect(fallback[0]).toBeCloseTo(0x1f / 255, 5);
	});

	test("falls back to default for short hex (#fff)", () => {
		// The regex requires exactly 6 hex chars
		const fallback = hexToRgb("#fff");
		expect(fallback).toHaveLength(3);
	});

	test("does not share the underlying default array between calls (return is fresh)", () => {
		const a = hexToRgb("invalid");
		const b = hexToRgb("invalid");
		expect(a).not.toBe(b);
		expect(a).toEqual(b);
	});

	test("DEFAULT_VISUALIZER_COLOR matches the hex used as fallback baseline", () => {
		const [r, g, b] = hexToRgb(DEFAULT_VISUALIZER_COLOR);
		expect(r).toBeCloseTo(0x1f / 255, 5);
		expect(g).toBeCloseTo(0xd5 / 255, 5);
		expect(b).toBeCloseTo(0xf9 / 255, 5);
	});
});
