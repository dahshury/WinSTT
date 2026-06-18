import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import {
	auraShapeToUniform,
	resolveAuraTheme,
	themeModeToUniform,
} from "./AudioVisualizerAura.helpers";
import { AudioVisualizerAura } from "./AudioVisualizerAura";

describe("AudioVisualizerAura", () => {
	test("renders without throwing at default size", () => {
		const { container } = render(<AudioVisualizerAura />);
		expect(container.firstElementChild).not.toBeNull();
	});

	test("renders without throwing with explicit themeMode", () => {
		const { container } = render(<AudioVisualizerAura themeMode="light" />);
		expect(container.firstElementChild).not.toBeNull();
	});

	test("renders without throwing with custom color", () => {
		const { container } = render(<AudioVisualizerAura color="#ff8800" />);
		expect(container.firstElementChild).not.toBeNull();
	});

	test("renders without throwing with the full set of customization props", () => {
		const { container } = render(
			<AudioVisualizerAura
				bloom={0.4}
				blur={0.6}
				colorShift={0.2}
				shape="line"
			/>,
		);
		expect(container.firstElementChild).not.toBeNull();
	});
});

describe("auraShapeToUniform", () => {
	test("circle → 1.0", () => {
		expect(auraShapeToUniform("circle")).toBe(1.0);
	});

	test("line → 2.0", () => {
		expect(auraShapeToUniform("line")).toBe(2.0);
	});

	test("defaults to circle (1.0) when undefined", () => {
		expect(auraShapeToUniform(undefined)).toBe(1.0);
	});
});

describe("resolveAuraTheme", () => {
	test("returns the explicit themeMode when provided", () => {
		expect(resolveAuraTheme("light")).toBe("light");
		expect(resolveAuraTheme("dark")).toBe("dark");
	});

	test("defaults to 'dark' when themeMode is undefined", () => {
		expect(resolveAuraTheme(undefined)).toBe("dark");
	});
});

describe("themeModeToUniform", () => {
	test("light theme → 1.0", () => {
		expect(themeModeToUniform("light")).toBe(1.0);
	});

	test("dark theme → 0.0", () => {
		expect(themeModeToUniform("dark")).toBe(0.0);
	});
});
