import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
	DRAG_MS,
	DRAG_TRANSITION,
	LIFT_TRANSITION,
	rubberBand,
	rubberBandWithinParent,
} from "./sortable-motion";

const rect = (top: number, height: number, left = 0, width = 100) => ({
	top,
	left,
	width,
	height,
	bottom: top + height,
	right: left + width,
});

describe("rubberBand", () => {
	test("inside the bounds the drag is untouched — 1:1 with the pointer", () => {
		expect(rubberBand(0, -40, 40)).toBe(0);
		expect(rubberBand(39.5, -40, 40)).toBe(39.5);
		expect(rubberBand(-40, -40, 40)).toBe(-40);
	});

	test("past an end the overshoot is damped 4:1", () => {
		// 8px of pointer travel past the end moves the card 2px.
		expect(rubberBand(8, -40, 0)).toBe(2);
		expect(rubberBand(-8, 0, 40)).toBe(-2);
		expect(rubberBand(52, -40, 40)).toBe(43);
	});

	test("the damped overshoot is capped, however hard you pull", () => {
		// Uncapped, dragging 400px past the end would push the card 100px out of
		// its popup and grow the scroll area; it stops at 6px.
		expect(rubberBand(400, -40, 0)).toBe(6);
		expect(rubberBand(4000, -40, 0)).toBe(6);
		expect(rubberBand(-400, 0, 40)).toBe(-6);
	});

	test("degenerate bounds (item taller than its container) pass through", () => {
		expect(rubberBand(120, 10, -10)).toBe(120);
	});

	test("property: the card never leaves its bounds by more than the cap", () => {
		fc.assert(
			fc.property(
				fc.double({ min: -5000, max: 5000, noNaN: true }),
				fc.double({ min: -500, max: 0, noNaN: true }),
				fc.double({ min: 0, max: 500, noNaN: true }),
				(value, min, max) => {
					const out = rubberBand(value, min, max);
					return out >= min - 6 && out <= max + 6;
				},
			),
			{ numRuns: 500 },
		);
	});

	test("property: monotone — pulling further never moves the card back", () => {
		fc.assert(
			fc.property(
				fc.double({ min: -5000, max: 5000, noNaN: true }),
				fc.double({ min: 0, max: 5000, noNaN: true }),
				(value, extra) =>
					rubberBand(value + extra, -40, 40) >= rubberBand(value, -40, 40),
			),
			{ numRuns: 500 },
		);
	});
});

describe("rubberBandWithinParent", () => {
	const transform = (x: number, y: number) => ({ x, y, scaleX: 1, scaleY: 1 });
	// A 40px row sitting at the bottom of a 200px list.
	const args = (x: number, y: number) => ({
		transform: transform(x, y),
		containerNodeRect: rect(0, 200),
		draggingNodeRect: rect(160, 40),
	});

	test("bounds the drag against the parent, elastically", () => {
		// Straight down out of the list: clamped at 0 travel, plus damped overshoot.
		expect(rubberBandWithinParent(args(0, 80) as never).y).toBe(6);
		// Up to the top of the list is free travel; beyond it, damped.
		expect(rubberBandWithinParent(args(0, -160) as never).y).toBe(-160);
		expect(rubberBandWithinParent(args(0, -168) as never).y).toBe(-162);
	});

	test("passes the transform through until dnd-kit has measured", () => {
		const raw = transform(0, 999);
		expect(
			rubberBandWithinParent({
				transform: raw,
				containerNodeRect: null,
				draggingNodeRect: null,
			} as never),
		).toBe(raw);
	});
});

describe("motion tokens", () => {
	test("the glide/FLIP duration mirrors the --drag-dur CSS token", () => {
		// globals.css: --drag-dur: 160ms (the `springs.moderate` tier). dnd-kit
		// needs it as a number, so the two have to be kept in step by hand.
		expect(DRAG_MS).toBe(160);
		expect(DRAG_TRANSITION).toEqual({
			duration: 160,
			easing: "var(--drag-ease)",
		});
	});

	test("the lift animates only its own properties, never the drag offset", () => {
		// `transform` must NOT appear: easing the offset would put the card behind
		// the pointer. The scale rides --drag-lift inside the transform instead.
		expect(LIFT_TRANSITION).not.toContain("transform");
		expect(LIFT_TRANSITION).toContain("--drag-lift");
		expect(LIFT_TRANSITION).toContain("box-shadow");
	});
});
