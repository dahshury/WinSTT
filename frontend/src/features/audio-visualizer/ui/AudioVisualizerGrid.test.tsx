import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { AudioVisualizerGrid } from "./AudioVisualizerGrid";

describe("AudioVisualizerGrid", () => {
	test("renders a grid container at default 'md' size", () => {
		const { container } = render(<AudioVisualizerGrid />);
		expect(container.firstElementChild?.className).toContain("grid");
	});

	test.each([
		"icon",
		"sm",
		"md",
		"lg",
		"xl",
	] as const)("renders without throwing at size=%s", (size) => {
		const { container, unmount } = render(<AudioVisualizerGrid size={size} />);
		expect(container.firstElementChild).not.toBeNull();
		unmount();
	});

	test("forwards color via inline style", () => {
		const { container } = render(<AudioVisualizerGrid color="#00ff00" />);
		const root = container.firstElementChild as HTMLElement;
		expect(root.style.color.toLowerCase()).toBe("#00ff00");
	});
});
