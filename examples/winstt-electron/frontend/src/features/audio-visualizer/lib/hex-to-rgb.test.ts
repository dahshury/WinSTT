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

	test("DEFAULT_VISUALIZER_COLOR has the exact value '#1FD5F9' (string literal mutation guard)", () => {
		// Mutates the DEFAULT_COLOR literal at L1 — replacing it with "" or
		// any non-hex string would either break exact equality OR (if cast through
		// hexToRgb) yield the fallback rather than the parsed value.
		expect(DEFAULT_VISUALIZER_COLOR).toBe("#1FD5F9");
	});

	test("fallback RGB components are in the [0,1] range, not [0, 255*255] (ArithmeticOperator mutation guard)", () => {
		// Mutating `0xd5 / 255` to `0xd5 * 255` (or `0xf9 / 255` to `0xf9 * 255`)
		// would yield values in the tens of thousands.
		const [r, g, b] = hexToRgb("not a hex");
		expect(r).toBeGreaterThanOrEqual(0);
		expect(r).toBeLessThanOrEqual(1);
		expect(g).toBeGreaterThanOrEqual(0);
		expect(g).toBeLessThanOrEqual(1);
		expect(b).toBeGreaterThanOrEqual(0);
		expect(b).toBeLessThanOrEqual(1);
		// Tighter bound: each component must equal the canonical default with
		// high precision, not just be in [0,1].
		expect(r).toBeCloseTo(0x1f / 255, 8);
		expect(g).toBeCloseTo(0xd5 / 255, 8);
		expect(b).toBeCloseTo(0xf9 / 255, 8);
	});

	test("regex requires '^' anchor (rejects '#' embedded inside a longer string)", () => {
		// Mutating /^#.../ to /#.../ removes the start-anchor, so the regex
		// finds and matches the embedded "#FFFFFF" inside "X#FFFFFF". The valid
		// match would parse to white (1,1,1) — distinct from the fallback cyan.
		const result = hexToRgb("X#FFFFFF");
		// Must be fallback cyan (0x1f, 0xd5, 0xf9) — NOT white.
		expect(result[0]).toBeCloseTo(0x1f / 255, 8);
		expect(result[1]).toBeCloseTo(0xd5 / 255, 8);
		expect(result[2]).toBeCloseTo(0xf9 / 255, 8);
		expect(result[0]).not.toBeCloseTo(1, 5);
	});

	test("regex requires end anchor (rejects trailing chars)", () => {
		// Mutating /...$/ to /.../ would let "#1FD5F9XX" match the prefix.
		// Without the $ anchor and given the original 7-char input, the parsed
		// values would be 0x1f, 0xd5, 0xf9 — same as fallback! So we use a
		// DIFFERENT prefix to distinguish: "#FFFFFFXX" parsed without $ would
		// give r=g=b=1.0, but the fallback gives the cyan color.
		const result = hexToRgb("#FFFFFFXX");
		// Must be the cyan fallback, NOT all-ones (which would happen if $
		// anchor were dropped and the regex matched the FFFFFF prefix).
		expect(result[0]).toBeCloseTo(0x1f / 255, 8);
		expect(result[0]).not.toBeCloseTo(1, 5);
	});
});
