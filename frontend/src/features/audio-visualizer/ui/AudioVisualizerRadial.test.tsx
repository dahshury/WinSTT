import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import {
	AudioVisualizerRadial,
	resolveRadialBarCount,
	resolveRadialDistance,
	resolveRadialSequencerInterval,
} from "./AudioVisualizerRadial";

describe("AudioVisualizerRadial", () => {
	test("renders without throwing at default size", () => {
		const { container } = render(<AudioVisualizerRadial />);
		expect(container.firstElementChild).not.toBeNull();
	});

	test.each([
		"icon",
		"sm",
		"md",
		"lg",
		"xl",
	] as const)("renders without throwing at size=%s", (size) => {
		const { container, unmount } = render(<AudioVisualizerRadial size={size} />);
		expect(container.firstElementChild).not.toBeNull();
		unmount();
	});
});

describe("resolveRadialBarCount", () => {
	test("returns explicit barCount when provided", () => {
		expect(resolveRadialBarCount(16, "md")).toBe(16);
	});

	test("returns 12 for icon size", () => {
		expect(resolveRadialBarCount(undefined, "icon")).toBe(12);
	});

	test("returns 12 for sm size", () => {
		expect(resolveRadialBarCount(undefined, "sm")).toBe(12);
	});

	test("returns 24 for larger sizes", () => {
		expect(resolveRadialBarCount(undefined, "md")).toBe(24);
		expect(resolveRadialBarCount(undefined, "lg")).toBe(24);
		expect(resolveRadialBarCount(undefined, "xl")).toBe(24);
	});
});

describe("resolveRadialSequencerInterval", () => {
	test("connecting → 500", () => {
		expect(resolveRadialSequencerInterval("connecting")).toBe(500);
	});

	test("listening → 500", () => {
		expect(resolveRadialSequencerInterval("listening")).toBe(500);
	});

	test("initializing → 250", () => {
		expect(resolveRadialSequencerInterval("initializing")).toBe(250);
	});

	test("thinking → Infinity", () => {
		expect(resolveRadialSequencerInterval("thinking")).toBe(Number.POSITIVE_INFINITY);
	});

	test("speaking/disconnected → 1000 (default)", () => {
		expect(resolveRadialSequencerInterval("speaking")).toBe(1000);
		expect(resolveRadialSequencerInterval("disconnected")).toBe(1000);
	});
});

describe("resolveRadialDistance", () => {
	test("returns explicit radius when provided", () => {
		expect(resolveRadialDistance(50, "md")).toBe(50);
	});

	test("icon → 6", () => {
		expect(resolveRadialDistance(undefined, "icon")).toBe(6);
	});

	test("xl → 128", () => {
		expect(resolveRadialDistance(undefined, "xl")).toBe(128);
	});

	test("lg → 64", () => {
		expect(resolveRadialDistance(undefined, "lg")).toBe(64);
	});

	test("sm → 16", () => {
		expect(resolveRadialDistance(undefined, "sm")).toBe(16);
	});

	test("md → 32 (default)", () => {
		expect(resolveRadialDistance(undefined, "md")).toBe(32);
	});
});
