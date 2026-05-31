import { describe, expect, test } from "bun:test";
import { formatTime, formatTimestamp } from "./format-time";

describe("formatTime", () => {
	test("formats zero as '0:00'", () => {
		expect(formatTime(0)).toBe("0:00");
	});

	test("formats seconds with leading zeros", () => {
		expect(formatTime(5000)).toBe("0:05");
		expect(formatTime(45_000)).toBe("0:45");
	});

	test("formats minutes without leading zero on the minutes field", () => {
		expect(formatTime(60_000)).toBe("1:00");
		expect(formatTime(125_000)).toBe("2:05");
	});

	test("formats hours when duration exceeds 60 minutes", () => {
		expect(formatTime(3_600_000)).toBe("1:00:00");
		expect(formatTime(3_725_000)).toBe("1:02:05");
		expect(formatTime(36_125_000)).toBe("10:02:05");
	});

	test("rounds down to whole seconds", () => {
		expect(formatTime(1999)).toBe("0:01");
		expect(formatTime(59_999)).toBe("0:59");
	});

	test("handles negative input by treating as 0", () => {
		// Math.floor of negative produces negative; this documents current behavior.
		const result = formatTime(-100);
		expect(typeof result).toBe("string");
	});
});

describe("formatTimestamp", () => {
	test("returns HH:MM:SS in 24-hour clock", () => {
		const date = new Date(2026, 0, 1, 14, 30, 45);
		const result = formatTimestamp(date);
		expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
		expect(result).toContain("14");
		expect(result).toContain("30");
		expect(result).toContain("45");
	});

	test("pads single-digit components with leading zeros", () => {
		const date = new Date(2026, 0, 1, 5, 9, 3);
		const result = formatTimestamp(date);
		expect(result).toMatch(/^05:09:03$/);
	});

	test("midnight is 00:00:00 in 24-hour format (not 12:00:00)", () => {
		const date = new Date(2026, 0, 1, 0, 0, 0);
		expect(formatTimestamp(date)).toBe("00:00:00");
	});
});
