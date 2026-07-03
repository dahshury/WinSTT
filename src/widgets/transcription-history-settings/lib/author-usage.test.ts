import { describe, expect, test } from "bun:test";
import type { TranscriptionHistoryEntry } from "../model/history-store";
import { type ResolvedAuthor, computeAuthorUsage } from "./author-usage";

function makeEntry(sttModel?: string): TranscriptionHistoryEntry {
	return {
		id: Math.random().toString(36),
		timestamp: 0,
		text: "hi",
		wordCount: 1,
		durationMs: 1000,
		...(sttModel === undefined ? {} : { sttModel }),
	};
}

// A tiny fake catalog: model id/name → maker + logo.
const CATALOG: Record<string, ResolvedAuthor> = {
	"whisper-tiny": { author: "OpenAI", logoSrc: "/openai.svg" },
	"whisper-base": { author: "OpenAI", logoSrc: "/openai.svg" },
	"parakeet-tdt": { author: "NVIDIA", logoSrc: "/nvidia.svg" },
	"qwen3-asr": { author: "Alibaba Qwen", logoSrc: "/qwen.svg" },
};

const resolve = (m: string): ResolvedAuthor | null => CATALOG[m] ?? null;

describe("computeAuthorUsage", () => {
	test("empty history yields no slices", () => {
		expect(computeAuthorUsage([], resolve, "Other")).toEqual([]);
	});

	test("entries without a model are skipped", () => {
		expect(computeAuthorUsage([makeEntry()], resolve, "Other")).toEqual([]);
	});

	test("groups by maker, sorted by count, with whole-percent shares", () => {
		const entries = [
			makeEntry("whisper-tiny"),
			makeEntry("whisper-base"),
			makeEntry("parakeet-tdt"),
		];
		expect(computeAuthorUsage(entries, resolve, "Other")).toEqual([
			{
				key: "OpenAI",
				label: "OpenAI",
				logoSrc: "/openai.svg",
				count: 2,
				pct: 67,
			},
			{
				key: "NVIDIA",
				label: "NVIDIA",
				logoSrc: "/nvidia.svg",
				count: 1,
				pct: 33,
			},
		]);
	});

	test("unresolved models collapse into a logo-less Other slice", () => {
		const entries = [
			makeEntry("whisper-tiny"),
			makeEntry("mystery-model"),
			makeEntry("another-unknown"),
		];
		const slices = computeAuthorUsage(entries, resolve, "Other");
		expect(slices).toEqual([
			{
				key: "OpenAI",
				label: "OpenAI",
				logoSrc: "/openai.svg",
				count: 1,
				pct: 33,
			},
			{ key: "__other__", label: "Other", logoSrc: null, count: 2, pct: 67 },
		]);
	});

	test("the long tail of makers rolls into a single Other slice", () => {
		const resolveMany = (m: string): ResolvedAuthor | null => ({
			author: m,
			logoSrc: `/${m}.svg`,
		});
		const counts = [7, 6, 5, 4, 3, 2, 1];
		const entries = counts.flatMap((n, i) =>
			Array.from({ length: n }, () => makeEntry(`maker-${i}`)),
		);
		const slices = computeAuthorUsage(entries, resolveMany, "Other");
		expect(slices).toHaveLength(6);
		const other = slices.at(-1);
		expect(other?.key).toBe("__other__");
		expect(other?.logoSrc).toBeNull();
		// The two smallest makers (2 + 1) roll up together.
		expect(other?.count).toBe(3);
	});
});
