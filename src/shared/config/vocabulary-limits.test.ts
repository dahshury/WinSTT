import { describe, expect, test } from "bun:test";
import {
	fitsRustShortText,
	fitsRustText,
	utf8ByteLength,
	VOCABULARY_LIMITS,
} from "./vocabulary-limits";

describe("vocabulary limits mirror Rust validation", () => {
	test("counts UTF-8 bytes instead of JavaScript code units", () => {
		expect(utf8ByteLength("é")).toBe(2);
		expect(
			fitsRustShortText(
				"é".repeat(VOCABULARY_LIMITS.termOrTriggerBytes / 2),
				VOCABULARY_LIMITS.termOrTriggerBytes,
			),
		).toBe(true);
		expect(
			fitsRustShortText(
				"é".repeat(VOCABULARY_LIMITS.termOrTriggerBytes / 2 + 1),
				VOCABULARY_LIMITS.termOrTriggerBytes,
			),
		).toBe(false);
	});

	test("short text rejects controls while expansions preserve newlines", () => {
		expect(fitsRustShortText("line one\nline two", 256)).toBe(false);
		expect(fitsRustText("line one\nline two", 256)).toBe(true);
		expect(fitsRustText("bad\0value", 256)).toBe(false);
	});
});
