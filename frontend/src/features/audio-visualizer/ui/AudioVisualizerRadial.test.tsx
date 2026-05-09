import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { AudioVisualizerRadial } from "./AudioVisualizerRadial";

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
