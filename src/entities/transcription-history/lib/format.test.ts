import { describe, expect, test } from "bun:test";
import type {
	HistoryEntry,
	PaginatedHistory,
	RecordingRetention,
} from "../model/transcription-history";
import { effectiveText, entryWordCount, formatEntryTimestamp } from "./format";

// Touch the unused exported types so knip + tsc recognise them as part of the
// entity's documented public surface (consumed by the renderer-side adapter +
// the planned tray submenu). Without these, knip flags them as dead exports
// even though they're documented as part of the OpenAPI-mirrored contract.
const _typeProbe = (
	entry: HistoryEntry,
	page: PaginatedHistory,
	period: RecordingRetention,
): [HistoryEntry, PaginatedHistory, RecordingRetention] => [
	entry,
	page,
	period,
];
void _typeProbe;

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
	return {
		id: 1,
		fileName: "winstt-1.wav",
		timestamp: 1_700_000_000,
		saved: false,
		title: "Recording 1",
		transcriptionText: "hello world",
		postProcessedText: null,
		postProcessPrompt: null,
		postProcessRequested: false,
		...overrides,
	};
}

describe("effectiveText", () => {
	test("returns raw transcript when no post-LLM cleanup ran", () => {
		const entry = makeEntry({ transcriptionText: "raw" });
		expect(effectiveText(entry)).toBe("raw");
	});

	test("prefers postProcessedText when LLM produced cleaned output", () => {
		const entry = makeEntry({
			transcriptionText: "raw",
			postProcessedText: "cleaned",
		});
		expect(effectiveText(entry)).toBe("cleaned");
	});

	test("falls back to raw when postProcessedText is whitespace-only", () => {
		const entry = makeEntry({
			transcriptionText: "raw",
			postProcessedText: "   ",
		});
		expect(effectiveText(entry)).toBe("raw");
	});
});

describe("entryWordCount", () => {
	test("counts whitespace-delimited tokens", () => {
		expect(
			entryWordCount(makeEntry({ transcriptionText: "one two three" })),
		).toBe(3);
	});

	test("returns 0 for empty/whitespace-only text", () => {
		expect(entryWordCount(makeEntry({ transcriptionText: "   " }))).toBe(0);
	});

	test("uses post-processed text when present", () => {
		expect(
			entryWordCount(
				makeEntry({
					transcriptionText: "one",
					postProcessedText: "one two three four",
				}),
			),
		).toBe(4);
	});
});

describe("formatEntryTimestamp", () => {
	test("returns the locale-formatted date+time string for a valid epoch", () => {
		// Just assert it's a non-empty distinct string from the fallback title.
		const out = formatEntryTimestamp(makeEntry());
		expect(typeof out).toBe("string");
		expect(out.length).toBeGreaterThan(0);
		expect(out).not.toBe("Recording 1");
	});

	test("falls back to the entry title on invalid epoch", () => {
		const out = formatEntryTimestamp(makeEntry({ timestamp: Number.NaN }));
		expect(out).toBe("Recording 1");
	});
});
