import { describe, expect, test } from "bun:test";
import { buildTranscriptDiff } from "./transcript-diff";

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
