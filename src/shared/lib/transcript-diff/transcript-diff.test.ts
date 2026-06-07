import { describe, expect, test } from "bun:test";
import { buildTranscriptDiff, reconstructFromDiff } from "./transcript-diff";

describe("buildTranscriptDiff", () => {
	test("returns null for whitespace-only no-op edits", () => {
		expect(
			buildTranscriptDiff("same transcript", " same   transcript\n"),
		).toBeNull();
	});

	test("captures a word replacement", () => {
		const diff = buildTranscriptDiff(
			"send the massage today",
			"send the message today",
		);

		expect(diff?.coarse).toBe(false);
		expect(diff?.changes).toEqual([
			{ after: "message", before: "massage", kind: "replace" },
		]);
		expect(diff?.hunks).toEqual([
			{ after: "send the", before: "send the", kind: "equal" },
			{ after: "message", before: "massage", kind: "change" },
			{ after: "today", before: "today", kind: "equal" },
		]);
	});

	test("captures inserted words", () => {
		const diff = buildTranscriptDiff("send report", "send the report");

		expect(diff?.changes).toEqual([
			{ after: "the", before: "", kind: "insert" },
		]);
	});

	test("summarizes large rewrites with a bounded diff", () => {
		const before = Array.from(
			{ length: 710 },
			(_, index) => `raw-${index}`,
		).join(" ");
		const after = Array.from(
			{ length: 710 },
			(_, index) => `clean-${index}`,
		).join(" ");
		const diff = buildTranscriptDiff(before, after);

		expect(diff?.coarse).toBe(true);
		expect(diff?.changes).toHaveLength(1);
		expect(diff?.changes[0]?.kind).toBe("replace");
	});
});

describe("reconstructFromDiff", () => {
	test("keeps every change when nothing is rejected", () => {
		expect(
			reconstructFromDiff(
				"send the massage today",
				"send the message today",
				[],
			),
		).toBe("send the message today");
	});

	test("reverts a rejected replacement to the original wording", () => {
		expect(
			reconstructFromDiff("send the massage today", "send the message today", [
				0,
			]),
		).toBe("send the massage today");
	});

	test("cherry-picks across multiple changes by change ordinal", () => {
		// changes: 0 = quick→swift, 1 = "" → ", please". Reject only the first.
		const before = "the quick fox the dog";
		const after = "the swift fox the dog , please";
		expect(reconstructFromDiff(before, after, [0])).toBe(
			"the quick fox the dog , please",
		);
		expect(reconstructFromDiff(before, after, [1])).toBe(
			"the swift fox the dog",
		);
	});

	test("drops a rejected insertion (keeps original)", () => {
		expect(reconstructFromDiff("send report", "send the report", [0])).toBe(
			"send report",
		);
	});

	test("returns the candidate verbatim when there is no real diff", () => {
		expect(reconstructFromDiff("same text", " same   text ", [])).toBe(
			" same   text ",
		);
	});
});
