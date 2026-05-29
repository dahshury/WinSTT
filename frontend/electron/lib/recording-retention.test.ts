import { describe, expect, test } from "bun:test";
import { resolveHistoryLimit, resolveRetentionPeriod } from "./recording-retention";

describe("resolveRetentionPeriod", () => {
	for (const period of ["never", "preserveLimit", "cap", "days3", "weeks2", "months3"] as const) {
		test(`accepts valid new-key value '${period}'`, () => {
			expect(resolveRetentionPeriod(period, undefined)).toBe(period);
		});
	}

	test("falls back to the legacy key when the new key is not a string", () => {
		expect(resolveRetentionPeriod(undefined, "days3")).toBe("days3");
		expect(resolveRetentionPeriod(42, "weeks2")).toBe("weeks2");
	});

	test("an unrecognized new-key string falls through to the default (does NOT use legacy)", () => {
		// Original semantics: a string new-key is used verbatim then validated;
		// "garbage" is a string so the legacy key is never consulted, and it
		// fails the whitelist → default.
		expect(resolveRetentionPeriod("garbage", "days3")).toBe("preserveLimit");
	});

	test("defaults to preserveLimit when neither key is valid", () => {
		expect(resolveRetentionPeriod(undefined, undefined)).toBe("preserveLimit");
		expect(resolveRetentionPeriod(null, "nope")).toBe("preserveLimit");
	});
});

describe("resolveHistoryLimit", () => {
	test("uses the new key when positive (floored)", () => {
		expect(resolveHistoryLimit(10, 99)).toBe(10);
		expect(resolveHistoryLimit(7.9, 99)).toBe(7);
		expect(resolveHistoryLimit("12", 99)).toBe(12);
	});

	test("falls back to the legacy key when the new key is non-positive / NaN", () => {
		expect(resolveHistoryLimit(0, 8)).toBe(8);
		expect(resolveHistoryLimit(-3, 8)).toBe(8);
		expect(resolveHistoryLimit("abc", 8)).toBe(8);
	});

	test("defaults to 5 when neither key is a positive number", () => {
		expect(resolveHistoryLimit(undefined, undefined)).toBe(5);
		expect(resolveHistoryLimit(0, -1)).toBe(5);
	});
});
