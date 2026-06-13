import { describe, expect, test } from "bun:test";
import type { TranscriptionHistoryEntry } from "../model/history-store";
import { computeUsage } from "./usage-breakdown";

function makeEntry(
	partial: Partial<TranscriptionHistoryEntry>,
): TranscriptionHistoryEntry {
	return {
		id: partial.id ?? Math.random().toString(36),
		timestamp: partial.timestamp ?? 0,
		text: partial.text ?? "hi",
		wordCount: partial.wordCount ?? 1,
		durationMs: partial.durationMs ?? 1000,
		...(partial.sttModel === undefined ? {} : { sttModel: partial.sttModel }),
		...(partial.historyTag === undefined
			? {}
			: { historyTag: partial.historyTag }),
	};
}

describe("computeUsage", () => {
	test("empty history yields empty breakdowns", () => {
		expect(computeUsage([], "Other")).toEqual({ models: [], categories: [] });
	});

	test("models are grouped, sorted by count, with whole-percent shares", () => {
		const entries = [
			makeEntry({ sttModel: "Whisper Tiny" }),
			makeEntry({ sttModel: "Whisper Tiny" }),
			makeEntry({ sttModel: "Whisper Tiny" }),
			makeEntry({ sttModel: "Parakeet TDT" }),
			// No model → not counted.
			makeEntry({}),
		];
		const { models } = computeUsage(entries, "Other");
		expect(models).toEqual([
			{ key: "Whisper Tiny", label: "Whisper Tiny", count: 3, pct: 75 },
			{ key: "Parakeet TDT", label: "Parakeet TDT", count: 1, pct: 25 },
		]);
	});

	test("the long tail of models collapses into a single Other row", () => {
		const counts = [7, 6, 5, 4, 3, 2, 1];
		const entries = counts.flatMap((n, i) =>
			Array.from({ length: n }, () => makeEntry({ sttModel: `model-${i}` })),
		);
		const { models } = computeUsage(entries, "Other");
		expect(models).toHaveLength(6);
		const other = models.at(-1);
		expect(other?.key).toBe("__other__");
		expect(other?.label).toBe("Other");
		// The two smallest models (2 + 1) roll up together.
		expect(other?.count).toBe(3);
	});

	test("categories use human labels and skip entries without a known tag", () => {
		const entries = [
			makeEntry({ historyTag: "code" }),
			makeEntry({ historyTag: "code" }),
			makeEntry({ historyTag: "email" }),
			// Unknown tag → not counted.
			makeEntry({ historyTag: "totally_unknown" }),
			// No tag → not counted.
			makeEntry({}),
		];
		const { categories } = computeUsage(entries, "Other");
		expect(categories).toEqual([
			{ key: "code", label: "Code", count: 2, pct: 67 },
			{ key: "email", label: "Email", count: 1, pct: 33 },
		]);
	});
});
