import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import {
	resolveBarCount,
	resolveBarSequencerInterval,
} from "./AudioVisualizerBar.helpers";
import { AudioVisualizerBar } from "./AudioVisualizerBar";

describe("AudioVisualizerBar", () => {
	test("renders 9 bars at default 'md' size", () => {
		const { container } = render(<AudioVisualizerBar />);
		const root = container.firstElementChild as HTMLElement;
		expect(root.querySelectorAll("[data-lk-index]")).toHaveLength(9);
	});

	test.each(["icon", "sm", "md", "lg", "xl"] as const)(
		"renders the appropriate height container at size=%s",
		(size) => {
			const { container } = render(<AudioVisualizerBar size={size} />);
			const root = container.firstElementChild as HTMLElement;
			expect(root.className).toContain("relative");
		},
	);

	test("renders 5 bars at size=icon", () => {
		const { container } = render(<AudioVisualizerBar size="icon" />);
		expect(container.querySelectorAll("[data-lk-index]")).toHaveLength(5);
	});

	test("renders 7 bars at size=sm", () => {
		const { container } = render(<AudioVisualizerBar size="sm" />);
		expect(container.querySelectorAll("[data-lk-index]")).toHaveLength(7);
	});

	test("respects explicit barCount prop", () => {
		const { container } = render(<AudioVisualizerBar barCount={11} />);
		expect(container.querySelectorAll("[data-lk-index]")).toHaveLength(11);
	});

	test("forwards a data-lk-state attribute reflecting the agent state", () => {
		const { container } = render(<AudioVisualizerBar />);
		const root = container.firstElementChild as HTMLElement;
		expect(root.getAttribute("data-lk-state")).toBeTruthy();
	});

	test("merges the color CSS var via style prop", () => {
		const { container } = render(<AudioVisualizerBar color="#ff00ff" />);
		const root = container.firstElementChild as HTMLElement;
		// happy-dom does not normalize CSS colors to rgb(...) — keeps the hex literal
		expect(root.style.color.toLowerCase()).toBe("#ff00ff");
	});
});

describe("resolveBarCount", () => {
	test("returns explicit barCount when provided", () => {
		expect(resolveBarCount(11, "md")).toBe(11);
	});

	test("returns 5 for icon size", () => {
		expect(resolveBarCount(undefined, "icon")).toBe(5);
	});

	test("returns 7 for sm size", () => {
		expect(resolveBarCount(undefined, "sm")).toBe(7);
	});

	test("returns 9 for other sizes", () => {
		expect(resolveBarCount(undefined, "md")).toBe(9);
		expect(resolveBarCount(undefined, "lg")).toBe(9);
		expect(resolveBarCount(undefined, "xl")).toBe(9);
	});
});

describe("resolveBarSequencerInterval", () => {
	test("connecting: 2000/barCount", () => {
		expect(resolveBarSequencerInterval("connecting", 5)).toBe(400);
	});

	test("initializing: 2000", () => {
		expect(resolveBarSequencerInterval("initializing", 5)).toBe(2000);
	});

	test("listening: 500", () => {
		expect(resolveBarSequencerInterval("listening", 5)).toBe(500);
	});

	test("thinking: 150", () => {
		expect(resolveBarSequencerInterval("thinking", 5)).toBe(150);
	});

	test("speaking/disconnected: 1000 (default)", () => {
		expect(resolveBarSequencerInterval("speaking", 5)).toBe(1000);
		expect(resolveBarSequencerInterval("disconnected", 5)).toBe(1000);
	});
});
