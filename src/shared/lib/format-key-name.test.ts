import { describe, expect, test } from "bun:test";
import { formatKeyName } from "./format-key-name";

describe("formatKeyName", () => {
	test.each([
		["LCtrl", "L Ctrl"],
		["RCtrl", "R Ctrl"],
		["LAlt", "L Alt"],
		["RAlt", "R Alt"],
		["LShift", "L Shift"],
		["RShift", "R Shift"],
		["LMeta", "L Win"],
		["RMeta", "R Win"],
	])("formats modifier key %s -> %s", (input, expected) => {
		expect(formatKeyName(input)).toBe(expected);
	});

	test("returns the original key for unmapped names", () => {
		expect(formatKeyName("F1")).toBe("F1");
		expect(formatKeyName("a")).toBe("a");
		expect(formatKeyName("Space")).toBe("Space");
	});

	test("returns empty string unchanged", () => {
		expect(formatKeyName("")).toBe("");
	});

	test("is case-sensitive (lowercase variants are unmapped)", () => {
		expect(formatKeyName("lctrl")).toBe("lctrl");
	});
});
