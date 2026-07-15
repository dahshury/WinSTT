import { describe, expect, test } from "bun:test";
import { rankHistorySearchItems } from "./history-search-ranking";

describe("rankHistorySearchItems", () => {
	test("orders substring, literal-token, fuzzy, then timestamp", () => {
		const matches = rankHistorySearchItems("history search", [
			{
				backendTier: null,
				key: "fuzzy",
				text: "histroy search",
				timestamp: 4,
			},
			{
				backendTier: null,
				key: "literal-older",
				text: "history fast searching",
				timestamp: 2,
			},
			{
				backendTier: null,
				key: "substring",
				text: "open history search now",
				timestamp: 1,
			},
			{
				backendTier: null,
				key: "literal-newer",
				text: "history fast searchable",
				timestamp: 3,
			},
		]);

		expect(matches.map((match) => match.key)).toEqual([
			"substring",
			"literal-newer",
			"literal-older",
			"fuzzy",
		]);
	});

	test("keeps backend candidates while dropping unrelated memory rows", () => {
		const matches = rankHistorySearchItems("archive", [
			{
				backendTier: 2,
				key: "backend-original-text-hit",
				text: "processed text no longer contains it",
				timestamp: 1,
			},
			{
				backendTier: null,
				key: "unrelated-memory-row",
				text: "nothing to see",
				timestamp: 2,
			},
		]);

		expect(matches.map((match) => match.key)).toEqual([
			"backend-original-text-hit",
		]);
	});
});
