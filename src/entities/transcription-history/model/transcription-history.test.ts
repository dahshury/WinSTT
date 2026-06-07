import { describe, expect, test } from "bun:test";
import type {
  HistoryEntry,
  PaginatedHistory,
  RecordingRetention,
} from "./transcription-history";

// This module is type-only (no runtime code), so there is nothing to execute.
// These tests lock the *structural contract* the call sites depend on: a drift
// in field names or nullability here would silently desync the renderer cache
// from the main-process `HistoryEntryRow` / OpenAPI `HistoryEntry` shape. The
// assertions are about the SHAPE; the type-checker (tsgo) catches the rest at
// import/compile time. We build literal values typed as the interfaces so a
// renamed/removed field fails to compile and breaks this test file.

describe("HistoryEntry shape", () => {
  test("a fully-populated row conforms (all fields present, correct types)", () => {
    const entry: HistoryEntry = {
      fileName: "rec-001.wav",
      historyTag: "ai_prompt",
      id: 42,
      postProcessedText: "Cleaned up text.",
      postProcessPrompt: "Fix grammar",
      postProcessRequested: true,
      privacyMarkers: ["contact"],
      saved: true,
      timestamp: 1_716_900_000_000,
      title: "Meeting notes",
      transcriptionText: "raw transcription",
    };
    // Field names must match the OpenAPI HistoryEntry schema 1:1.
    expect(Object.keys(entry).sort()).toEqual(
      [
        "fileName",
        "historyTag",
        "id",
        "postProcessPrompt",
        "postProcessRequested",
        "postProcessedText",
        "privacyMarkers",
        "saved",
        "timestamp",
        "title",
        "transcriptionText",
      ].sort(),
    );
    expect(typeof entry.id).toBe("number");
    expect(typeof entry.timestamp).toBe("number");
    expect(typeof entry.fileName).toBe("string");
    expect(typeof entry.title).toBe("string");
    expect(typeof entry.transcriptionText).toBe("string");
    expect(typeof entry.postProcessRequested).toBe("boolean");
    expect(typeof entry.saved).toBe("boolean");
    expect(Array.isArray(entry.privacyMarkers)).toBe(true);
  });

  test("post-process fields are nullable (no post-processing requested yet)", () => {
    // `postProcessedText` and `postProcessPrompt` are `string | null`; a fresh
    // row that never went through the LLM cleanup pass carries null here.
    const entry: HistoryEntry = {
      fileName: "rec-002.wav",
      id: 7,
      postProcessedText: null,
      postProcessPrompt: null,
      postProcessRequested: false,
      saved: false,
      timestamp: 1_716_900_000_001,
      title: "Untitled",
      transcriptionText: "",
    };
    expect(entry.postProcessedText).toBeNull();
    expect(entry.postProcessPrompt).toBeNull();
    expect(entry.postProcessRequested).toBe(false);
  });
});

describe("PaginatedHistory shape", () => {
  test("wraps an entries array with a hasMore cursor flag", () => {
    const page: PaginatedHistory = {
      entries: [],
      hasMore: false,
    };
    expect(Array.isArray(page.entries)).toBe(true);
    expect(typeof page.hasMore).toBe("boolean");
    expect(Object.keys(page).sort()).toEqual(["entries", "hasMore"]);
  });

  test("entries are HistoryEntry rows; hasMore drives infinite scroll", () => {
    const page: PaginatedHistory = {
      entries: [
        {
          fileName: "a.wav",
          historyTag: "task",
          id: 1,
          postProcessedText: null,
          postProcessPrompt: null,
          postProcessRequested: false,
          privacyMarkers: [],
          saved: false,
          timestamp: 1,
          title: "t",
          transcriptionText: "x",
        },
      ],
      hasMore: true,
    };
    expect(page.entries[0]?.id).toBe(1);
    expect(page.hasMore).toBe(true);
  });
});

describe("RecordingRetention union", () => {
  test("admits exactly the five documented retention policies", () => {
    // Each literal must remain assignable; a removed/renamed member breaks
    // compilation here (the settings UI keys its dropdown off these values).
    const all: RecordingRetention[] = [
      "never",
      "cap",
      "days3",
      "weeks2",
      "months3",
    ];
    expect(all).toHaveLength(5);
    expect(new Set(all).size).toBe(5);
  });
});
