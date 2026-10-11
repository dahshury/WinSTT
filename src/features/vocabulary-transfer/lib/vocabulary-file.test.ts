import { describe, expect, test } from "bun:test";
import { parseVocabularyFile, planVocabularyMerge } from "./vocabulary-file";

describe("vocabulary migration", () => {
	test("reads BOM and Windows CSV with quoted commas, escaped quotes and multiline text", () => {
		expect(
			parseVocabularyFile(
				'\uFEFFtrigger,expansion\r\n"greeting","Hello, ""friend""!\r\nBye"\r\n',
				"snippets",
			),
		).toEqual([{ key: "greeting", value: 'Hello, "friend"!\r\nBye' }]);
	});
	test("supports a plain word list and headerless replacement pairs", () => {
		expect(
			parseVocabularyFile("Kubernetes\r\nWinSTT\r\n", "dictionary"),
		).toHaveLength(2);
		expect(parseVocabularyFile("cube,Kubernetes", "dictionary")).toEqual([
			{ key: "cube", value: "Kubernetes" },
		]);
	});
	test("preserves expansion whitespace and regenerates IDs at the caller", () => {
		expect(
			parseVocabularyFile("trigger,expansion\na,  text  ", "snippets")[0]
				?.value,
		).toBe("  text  ");
		const file = JSON.stringify({
			format: "winstt-vocabulary",
			version: 1,
			kind: "dictionary",
			entries: [{ id: "old", term: "WinSTT", autoAdded: true }],
		});
		expect(parseVocabularyFile(file, "dictionary")).toEqual([
			{ key: "WinSTT", value: undefined, autoAdded: true },
		]);
	});
	test("imports VoiceInk version 1 vocabulary and replacement sources", () => {
		const file = JSON.stringify({
			format: "voiceink.dictionary",
			schemaVersion: 1,
			vocabulary: [{ term: "kube" }, { term: "WinSTT" }],
			replacements: [{ sources: ["kube", "cube"], replacement: "Kubernetes" }],
		});
		expect(parseVocabularyFile(file, "dictionary")).toEqual([
			{ key: "WinSTT" },
			{ key: "kube", value: "Kubernetes" },
			{ key: "cube", value: "Kubernetes" },
		]);
	});
	test("merge keeps existing rules and deduplicates the import case-insensitively", () => {
		expect(
			planVocabularyMerge(
				[" WinSTT "],
				[{ key: "winstt", value: "other" }, { key: "Rust" }, { key: "rust" }],
				"dictionary",
			),
		).toEqual({ added: [{ key: "Rust" }], skipped: 2 });
	});
	test("rejects wrong kinds, unsupported versions, malformed CSV and invalid rows atomically", () => {
		for (const text of [
			'term,replacement\n"unclosed,x',
			'"closed"garbage,x',
			"term,unknown\na,x",
			'[{"term":5}]',
			'[{"term":"valid"},{"term":"bad\\u0000"}]',
			'{"format":"winstt-vocabulary","version":2,"kind":"dictionary","entries":[]}',
		]) {
			expect(() => parseVocabularyFile(text, "dictionary")).toThrow();
		}
		expect(() =>
			parseVocabularyFile('trigger,expansion\na,""', "snippets"),
		).toThrow();
		expect(() =>
			parseVocabularyFile(
				'{"format":"winstt-vocabulary","version":1,"kind":"snippets","entries":[]}',
				"dictionary",
			),
		).toThrow();
	});
	test("enforces UTF-8 and collection caps before applying any rows", () => {
		expect(() =>
			parseVocabularyFile(
				JSON.stringify([{ term: "界".repeat(86) }]),
				"dictionary",
			),
		).toThrow();
		expect(() =>
			parseVocabularyFile(
				JSON.stringify([{ term: "a", replacement: " ".repeat(2049) }]),
				"dictionary",
			),
		).toThrow();
		expect(() =>
			planVocabularyMerge(
				Array.from({ length: 2000 }, (_, i) => `old-${i}`),
				[{ key: "new" }],
				"dictionary",
			),
		).toThrow("limit");
	});
});
