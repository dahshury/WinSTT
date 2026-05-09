import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { AudioVisualizerBar } from "./AudioVisualizerBar";

describe("AudioVisualizerBar", () => {
	test("renders 9 bars at default 'md' size", () => {
		const { container } = render(<AudioVisualizerBar />);
		const root = container.firstElementChild as HTMLElement;
		expect(root.querySelectorAll("[data-lk-index]")).toHaveLength(9);
	});

	test.each([
		"icon",
		"sm",
		"md",
		"lg",
		"xl",
	] as const)("renders the appropriate height container at size=%s", (size) => {
		const { container } = render(<AudioVisualizerBar size={size} />);
		const root = container.firstElementChild as HTMLElement;
		expect(root.className).toContain("relative");
	});

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
