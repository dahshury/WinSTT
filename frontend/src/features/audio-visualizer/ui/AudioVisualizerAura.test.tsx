import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { AudioVisualizerAura } from "./AudioVisualizerAura";

describe("AudioVisualizerAura", () => {
	test("renders without throwing at default size", () => {
		const { container } = render(<AudioVisualizerAura />);
		expect(container.firstElementChild).not.toBeNull();
	});
});
