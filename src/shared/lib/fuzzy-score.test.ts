import { describe, expect, test } from "bun:test";
import { computeHighlightRanges, scoreFuzzyMatch } from "./fuzzy-score";

describe("scoreFuzzyMatch", () => {
	test("classifies substring, token-prefix, and typo matches", () => {
		expect(scoreFuzzyMatch("The quick brown fox", "quick brown")).toEqual({
			cost: 0,
			tier: 0,
		});
		expect(scoreFuzzyMatch("quickly browned", "quick brown")).toEqual({
			cost: 0,
			tier: 1,
		});
		expect(scoreFuzzyMatch("history search", "histroy searhc")).toEqual({
			cost: 2,
			tier: 2,
		});
	});

	test("rejects short-token typos and unrelated text", () => {
		expect(scoreFuzzyMatch("cat", "cta")).toBeNull();
		expect(scoreFuzzyMatch("history", "banana")).toBeNull();
	});
});

describe("computeHighlightRanges", () => {
	test("returns original offsets case-insensitively and merges overlaps", () => {
		expect(computeHighlightRanges("Hello HELLO", "hello")).toEqual([
			{ start: 0, end: 5 },
			{ start: 6, end: 11 },
		]);
	});

	test("highlights the matched original token for fuzzy-only matches", () => {
		expect(computeHighlightRanges("A history record", "histroy")).toEqual([
			{ start: 2, end: 9 },
		]);
	});
});
