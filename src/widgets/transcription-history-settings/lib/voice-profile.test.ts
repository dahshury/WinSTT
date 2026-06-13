import { describe, expect, test } from "bun:test";
import type { TranscriptionHistoryEntry } from "../model/history-store";
import { computeVoiceProfile, tokenizeWords } from "./voice-profile";

function makeEntry(
	partial: Partial<TranscriptionHistoryEntry>,
): TranscriptionHistoryEntry {
	return {
		id: partial.id ?? "id",
		timestamp: partial.timestamp ?? 0,
		text: partial.text ?? "",
		wordCount: partial.wordCount ?? 0,
		durationMs: partial.durationMs ?? 0,
		...(partial.originalText === undefined
			? {}
			: { originalText: partial.originalText }),
	};
}

describe("tokenizeWords", () => {
	test("lowercases and strips surrounding punctuation, keeps internal apostrophes", () => {
		expect(tokenizeWords("Hello, world! Don't stop.")).toEqual([
			"hello",
			"world",
			"don't",
			"stop",
		]);
	});

	test("handles non-Latin scripts", () => {
		expect(tokenizeWords("مرحبا بالعالم")).toEqual(["مرحبا", "بالعالم"]);
	});

	test("empty / whitespace yields no tokens", () => {
		expect(tokenizeWords("   ")).toEqual([]);
	});
});

describe("computeVoiceProfile", () => {
	test("all fields are null for empty history", () => {
		expect(computeVoiceProfile([])).toEqual({
			catchphrase: null,
			mostCorrectedWord: null,
			mostUsedWord: null,
			peakTime: null,
		});
	});

	test("most used word and catchphrase both skip stopwords (the top two distinctive words)", () => {
		const entries = [
			makeEntry({ text: "the the the code should ship" }),
			makeEntry({ text: "the code should should work" }),
		];
		const profile = computeVoiceProfile(entries);
		// "the" appears 4× but is a stopword, so it's dropped. "should" 3×,
		// "code" 2× — most-used is "should", the catchphrase runner-up is "code".
		expect(profile.mostUsedWord).toEqual({ count: 3, word: "should" });
		expect(profile.catchphrase).toEqual({ count: 2, word: "code" });
	});

	test("catchphrase is null when only one distinctive word exists", () => {
		const entries = [makeEntry({ text: "the and you should should" })];
		const profile = computeVoiceProfile(entries);
		expect(profile.mostUsedWord).toEqual({ count: 2, word: "should" });
		expect(profile.catchphrase).toBeNull();
	});

	test("most corrected word skips stopwords and counts the raw side of AI rewrites", () => {
		const entries = [
			makeEntry({ originalText: "open cursor now", text: "open Cursor now" }),
			makeEntry({
				originalText: "launch cursor please",
				text: "launch Cursor please",
			}),
			// No originalText → ignored by the corrected-word tally.
			makeEntry({ text: "cursor cursor cursor" }),
		];
		const profile = computeVoiceProfile(entries);
		// "cursor" (lowercased) is the corrected `before` word in both AI entries.
		expect(profile.mostCorrectedWord).toEqual({ count: 2, word: "cursor" });
	});

	test("peak time is the busiest weekday/hour bucket (local time)", () => {
		// Three sessions Friday 22:00, one Monday 09:00 (local).
		const fri = (h: number) => new Date(2026, 0, 9, h, 0, 0).getTime(); // 2026-01-09 is a Friday
		const mon = (h: number) => new Date(2026, 0, 12, h, 0, 0).getTime(); // Monday
		const profile = computeVoiceProfile([
			makeEntry({ timestamp: fri(22) }),
			makeEntry({ timestamp: fri(22) }),
			makeEntry({ timestamp: fri(22) }),
			makeEntry({ timestamp: mon(9) }),
		]);
		expect(profile.peakTime).toEqual({ count: 3, dayOfWeek: 5, hour: 22 });
	});
});
