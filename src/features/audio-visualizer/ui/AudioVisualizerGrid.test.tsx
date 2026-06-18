import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import {
	isCoordinateHighlighted,
	isSpeakingCellHighlighted,
	resolveTransitionDuration,
} from "./AudioVisualizerGrid.helpers";
import {
	AudioVisualizerGrid,
} from "./AudioVisualizerGrid";

describe("AudioVisualizerGrid", () => {
	test("renders a grid container at default 'md' size", () => {
		const { container } = render(<AudioVisualizerGrid />);
		expect(container.firstElementChild?.className).toContain("grid");
	});

	test.each(["icon", "sm", "md", "lg", "xl"] as const)(
		"renders without throwing at size=%s",
		(size) => {
			const { container, unmount } = render(
				<AudioVisualizerGrid size={size} />,
			);
			expect(container.firstElementChild).not.toBeNull();
			unmount();
		},
	);

	test("forwards color via inline style", () => {
		const { container } = render(<AudioVisualizerGrid color="#00ff00" />);
		const root = container.firstElementChild as HTMLElement;
		expect(root.style.color.toLowerCase()).toBe("#00ff00");
	});
});

describe("isSpeakingCellHighlighted", () => {
	const bands = [0.8, 0.3, 0.6, 0.1, 0.9];

	test("center row (row 2 in 5-row grid) has threshold=0 → always highlighted", () => {
		// 5 rows: midpoint=2. index=12 in columnCount=5 → y=floor(12/5)=2 (center row)
		// distanceToMid=0 → threshold=0. band[12%5]=band[2]=0.6 >= 0 → true
		expect(isSpeakingCellHighlighted(12, 5, 5, bands)).toBe(true);
	});

	test("center row with zero band still highlighted (threshold=0 means >= is true)", () => {
		// index=10 → y=floor(10/5)=2 (center row), threshold=0, band[0]=0 >= 0 → true
		expect(isSpeakingCellHighlighted(10, 5, 5, [0])).toBe(true);
	});

	test("outer row with high-volume band exceeds threshold → highlighted", () => {
		// Row 0 (index=0): y=0. midPoint=2. distance=2. volumeChunks=1/3≈0.333. threshold≈0.667
		// band[0]=0.8 >= 0.667 → true
		expect(isSpeakingCellHighlighted(0, 5, 5, bands)).toBe(true);
	});

	test("outer row with low-volume band does not meet threshold → not highlighted", () => {
		// Row 0 (index=3): y=0. midPoint=2. distance=2. threshold≈0.667
		// band[3]=0.1 < 0.667 → false
		expect(isSpeakingCellHighlighted(3, 5, 5, bands)).toBe(false);
	});

	test("row 1 (distance=1): lower threshold → highlighted with moderate band", () => {
		// index=5 → y=1. distance=1. volumeChunks=1/3. threshold=0.333
		// band[0]=0.8 >= 0.333 → true
		expect(isSpeakingCellHighlighted(5, 5, 5, bands)).toBe(true);
	});
});

describe("isCoordinateHighlighted", () => {
	const coord = { x: 2, y: 3 };

	test("returns true when cell matches highlighted coordinate", () => {
		// index=17, columnCount=5: x=17%5=2, y=floor(17/5)=3 → matches {x:2,y:3}
		expect(isCoordinateHighlighted(17, 5, coord)).toBe(true);
	});

	test("returns false when x does not match", () => {
		// index=16, columnCount=5: x=1 ≠ 2
		expect(isCoordinateHighlighted(16, 5, coord)).toBe(false);
	});

	test("returns false when y does not match", () => {
		// index=7, columnCount=5: x=2, y=1 ≠ 3
		expect(isCoordinateHighlighted(7, 5, coord)).toBe(false);
	});
});

describe("resolveTransitionDuration", () => {
	test("highlighted cell uses longer interval divisor (1000)", () => {
		expect(resolveTransitionDuration(1000, true)).toBe(1);
	});

	test("non-highlighted cell uses shorter interval divisor (100)", () => {
		expect(resolveTransitionDuration(1000, false)).toBe(10);
	});
});
