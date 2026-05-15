import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { AudioVisualizerAura, resolveAuraTheme, themeModeToUniform } from "./AudioVisualizerAura";

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
