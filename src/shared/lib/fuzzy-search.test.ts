import { describe, expect, test } from "bun:test";
import { matchesFuzzySearch } from "./fuzzy-search";

describe("matchesFuzzySearch", () => {
	test("matches exact substrings case-insensitively", () => {
		expect(matchesFuzzySearch("Whisper Tiny", "tiny")).toBe(true);
		expect(matchesFuzzySearch("Whisper Tiny", "TINY")).toBe(true);
	});

	test("matches common one-edit typos", () => {
		expect(matchesFuzzySearch("Display settings", "dispaly")).toBe(true);
		expect(matchesFuzzySearch("Parakeet", "Parkeet")).toBe(true);
	});

	test("matches compact version queries against spelled-out versions", () => {
		expect(matchesFuzzySearch("Parakeet version 3", "Parkeet v3")).toBe(true);
		expect(matchesFuzzySearch("Parakeet v3", "parakeet version 3")).toBe(true);
	});

	test("matches split queries against compact names", () => {
		expect(matchesFuzzySearch("OpenRouter", "open router")).toBe(true);
		expect(matchesFuzzySearch("GPT4o Mini", "gpt 4o")).toBe(true);
	});

	test("requires every query token to match", () => {
		expect(matchesFuzzySearch("Parakeet version 3", "parakeet v4")).toBe(false);
		expect(matchesFuzzySearch("Audio settings", "audio zzz")).toBe(false);
	});

	test("keeps short unrelated tokens from fuzzy matching", () => {
		expect(matchesFuzzySearch("model device options", "ai")).toBe(false);
		expect(matchesFuzzySearch("Main Model", "ai")).toBe(true);
	});
});
