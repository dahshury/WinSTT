import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { AudioVisualizerWave } from "./AudioVisualizerWave";

describe("AudioVisualizerWave", () => {
	test("renders without throwing at default size", () => {
		const { container } = render(<AudioVisualizerWave />);
		expect(container.firstElementChild).not.toBeNull();
	});
});
