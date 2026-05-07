import { describe, expect, test } from "bun:test";
import {
	appendBounded,
	DEFAULT_APP_MENU_TEMPLATE,
	formatTimestamp,
	parseAppMenuTemplateJson,
} from "./desktop-tools";

describe("parseAppMenuTemplateJson", () => {
	test("parses valid menu template JSON array", () => {
		const source = JSON.stringify(DEFAULT_APP_MENU_TEMPLATE);
		const result = parseAppMenuTemplateJson(source);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			throw new Error(result.error);
		}
		expect(Array.isArray(result.template)).toBe(true);
		expect(result.template.length).toBeGreaterThan(0);
	});

	test("returns typed error when input is invalid JSON", () => {
		const result = parseAppMenuTemplateJson("{not-json");
		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error("expected parse failure");
		}
		expect(result.error).toContain("Invalid JSON");
	});

	test("returns typed error when root value is not an array", () => {
		const result = parseAppMenuTemplateJson('{"label":"File"}');
		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error("expected array validation failure");
		}
		expect(result.error).toContain("JSON root must be an array");
	});
});

describe("appendBounded", () => {
	test("keeps only the latest entries up to max size", () => {
		let values: number[] = [];
		values = appendBounded(values, 1, 3);
		values = appendBounded(values, 2, 3);
		values = appendBounded(values, 3, 3);
		values = appendBounded(values, 4, 3);

		expect(values).toEqual([2, 3, 4]);
	});
});

describe("formatTimestamp", () => {
	test("formats epoch millis to local HH:MM:SS-ish string", () => {
		const value = formatTimestamp(1_700_000_000_000);
		expect(typeof value).toBe("string");
		expect(value.length).toBeGreaterThan(0);
	});
});
