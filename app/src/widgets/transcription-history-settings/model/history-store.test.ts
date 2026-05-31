import { beforeEach, describe, expect, test } from "bun:test";
import { type TranscriptionHistoryEntry, useTranscriptionHistoryStore } from "./history-store";

const INITIAL_STATE = useTranscriptionHistoryStore.getInitialState();

function makeEntry(id: string): TranscriptionHistoryEntry {
	return {
		id,
		timestamp: 1000,
		text: `text-${id}`,
		wordCount: 1,
		durationMs: 1000,
	};
}

beforeEach(() => {
	useTranscriptionHistoryStore.setState({ entries: [], isLoaded: false });
});

describe("useTranscriptionHistoryStore", () => {
	test("initial state has no entries and isLoaded=false (mutation guard)", () => {
		expect(INITIAL_STATE.entries).toEqual([]);
		expect(INITIAL_STATE.isLoaded).toBe(false);
	});

	test("setAll replaces entries and flips isLoaded to true", () => {
		useTranscriptionHistoryStore.getState().setAll([makeEntry("a"), makeEntry("b")]);
		const state = useTranscriptionHistoryStore.getState();
		expect(state.entries.map((e) => e.id)).toEqual(["a", "b"]);
		expect(state.isLoaded).toBe(true);
	});

	test("addEntry appends to the existing list in insertion order", () => {
		useTranscriptionHistoryStore.getState().addEntry(makeEntry("a"));
		useTranscriptionHistoryStore.getState().addEntry(makeEntry("b"));
		expect(useTranscriptionHistoryStore.getState().entries.map((e) => e.id)).toEqual(["a", "b"]);
	});

	test("addEntry deduplicates by id (idempotent on repeat IPC delivery)", () => {
		const entry = makeEntry("dup");
		useTranscriptionHistoryStore.getState().addEntry(entry);
		useTranscriptionHistoryStore.getState().addEntry(entry);
		expect(useTranscriptionHistoryStore.getState().entries).toHaveLength(1);
	});

	test("clear empties the entries", () => {
		useTranscriptionHistoryStore.getState().setAll([makeEntry("a"), makeEntry("b")]);
		useTranscriptionHistoryStore.getState().clear();
		expect(useTranscriptionHistoryStore.getState().entries).toEqual([]);
	});
});
