import { beforeEach, describe, expect, test } from "bun:test";
import {
	countWords,
	createTranscriptionHistoryStore,
	type HistoryPersistence,
} from "./transcription-history";

function makeStore(initial?: unknown): HistoryPersistence & {
	state: Record<string, unknown>;
} {
	const state: Record<string, unknown> = initial === undefined ? {} : { history: initial };
	return {
		state,
		get(key: string) {
			return state[key];
		},
		set(key: string, value: unknown) {
			state[key] = value;
		},
	};
}

let idCounter = 0;
function makeId(): string {
	idCounter += 1;
	return `id-${idCounter}`;
}

beforeEach(() => {
	idCounter = 0;
});

describe("countWords", () => {
	test("counts whitespace-separated tokens", () => {
		expect(countWords("hello world")).toBe(2);
		expect(countWords("  one   two   three  ")).toBe(3);
	});

	test("returns 0 for empty or whitespace-only input", () => {
		expect(countWords("")).toBe(0);
		expect(countWords("   \n\t   ")).toBe(0);
	});

	test("treats punctuation-only tokens as words (matches dictation reality)", () => {
		// "..." is a single non-whitespace token; if the recogniser produced
		// an ellipsis we still count it. The user can clear history if undesired.
		expect(countWords("hello ... world")).toBe(3);
	});
});

describe("createTranscriptionHistoryStore.record", () => {
	test("ignores empty / whitespace-only text", () => {
		const store = makeStore();
		const history = createTranscriptionHistoryStore({
			maxEntries: 10,
			now: () => 1000,
			makeId,
			store,
			storeKey: "history",
		});
		expect(history.record("", 1000)).toBeNull();
		expect(history.record("   \t  ", 1000)).toBeNull();
		expect(history.getHistory()).toEqual([]);
		// Persistence side-effect must NOT fire for ignored records — guards
		// against the mutant that returns the empty entry instead of null.
		expect(store.state.history).toBeUndefined();
	});

	test("records non-empty text with trimmed value + computed wordCount + timestamp", () => {
		const store = makeStore();
		const history = createTranscriptionHistoryStore({
			maxEntries: 10,
			now: () => 5000,
			makeId,
			store,
			storeKey: "history",
		});
		const entry = history.record("  hello there friend  ", 2400);
		expect(entry).toEqual({
			id: "id-1",
			timestamp: 5000,
			text: "hello there friend",
			wordCount: 3,
			durationMs: 2400,
		});
	});

	test("clamps negative durations to zero and floors fractional ones", () => {
		const store = makeStore();
		const history = createTranscriptionHistoryStore({
			maxEntries: 10,
			now: () => 1,
			makeId,
			store,
			storeKey: "history",
		});
		expect(history.record("a", -500)?.durationMs).toBe(0);
		expect(history.record("b", 1234.9)?.durationMs).toBe(1234);
	});

	test("persists each record under the configured storeKey", () => {
		const store = makeStore();
		const history = createTranscriptionHistoryStore({
			maxEntries: 10,
			now: () => 1,
			makeId,
			store,
			storeKey: "tHistory",
		});
		history.record("a b c", 1000);
		expect(Array.isArray(store.state.tHistory)).toBe(true);
		expect((store.state.tHistory as { text: string }[])[0]?.text).toBe("a b c");
	});

	test("evicts oldest entries when maxEntries is exceeded", () => {
		const store = makeStore();
		const history = createTranscriptionHistoryStore({
			maxEntries: 2,
			now: () => 1,
			makeId,
			store,
			storeKey: "history",
		});
		history.record("one", 1);
		history.record("two", 1);
		history.record("three", 1);
		const stored = history.getHistory();
		expect(stored.map((e) => e.text)).toEqual(["two", "three"]);
	});

	test("keeps exactly maxEntries at the boundary (no off-by-one eviction)", () => {
		// Kills `>` → `>=` mutant. At length === maxEntries the splice must NOT run.
		const store = makeStore();
		const history = createTranscriptionHistoryStore({
			maxEntries: 3,
			now: () => 1,
			makeId,
			store,
			storeKey: "history",
		});
		history.record("a", 1);
		history.record("b", 1);
		history.record("c", 1);
		expect(history.getHistory().map((e) => e.text)).toEqual(["a", "b", "c"]);
	});

	test("captures originalText when it differs from the final text", () => {
		const store = makeStore();
		const history = createTranscriptionHistoryStore({
			maxEntries: 5,
			now: () => 1,
			makeId,
			store,
			storeKey: "history",
		});
		const entry = history.record("Hello, world.", 1000, "hello world");
		expect(entry?.text).toBe("Hello, world.");
		expect(entry?.originalText).toBe("hello world");
	});

	test("omits originalText when it matches the final text (no LLM rewrite)", () => {
		const store = makeStore();
		const history = createTranscriptionHistoryStore({
			maxEntries: 5,
			now: () => 1,
			makeId,
			store,
			storeKey: "history",
		});
		const entry = history.record("same text", 1000, "same text");
		expect(entry?.text).toBe("same text");
		expect(entry?.originalText).toBeUndefined();
	});

	test("omits originalText when only whitespace differences exist (trim equality)", () => {
		const store = makeStore();
		const history = createTranscriptionHistoryStore({
			maxEntries: 5,
			now: () => 1,
			makeId,
			store,
			storeKey: "history",
		});
		const entry = history.record("hello", 1000, "  hello  ");
		expect(entry?.originalText).toBeUndefined();
	});

	test("ignores empty originalText", () => {
		const store = makeStore();
		const history = createTranscriptionHistoryStore({
			maxEntries: 5,
			now: () => 1,
			makeId,
			store,
			storeKey: "history",
		});
		const entry = history.record("hello", 1000, "");
		expect(entry?.originalText).toBeUndefined();
	});

	test("preserves originalText when LLM ran even if it matches the final text", () => {
		// Reasoning model can return the input unchanged (e.g. it exhausted
		// its budget on thinking tokens, or the cleanup preset was a no-op
		// for this input). The user still expects "Copy Original" to be
		// available because the LLM was actually invoked.
		const store = makeStore();
		const history = createTranscriptionHistoryStore({
			maxEntries: 5,
			now: () => 1,
			makeId,
			store,
			storeKey: "history",
		});
		const entry = history.record("hello world", 1000, "hello world", true);
		expect(entry?.originalText).toBe("hello world");
	});

	test("omits originalText when LLM did NOT run, even if originalText was passed", () => {
		// Dictionary-only path: relay passes the post-dictionary text as
		// originalText for consistency with the LLM path, but since the LLM
		// gate is closed there's no semantic value in surfacing it.
		const store = makeStore();
		const history = createTranscriptionHistoryStore({
			maxEntries: 5,
			now: () => 1,
			makeId,
			store,
			storeKey: "history",
		});
		const entry = history.record("hello world", 1000, "hello world", false);
		expect(entry?.originalText).toBeUndefined();
	});

	test("records (trimmed) llmModel when the LLM ran", () => {
		const store = makeStore();
		const history = createTranscriptionHistoryStore({
			maxEntries: 5,
			now: () => 1,
			makeId,
			store,
			storeKey: "history",
		});
		const entry = history.record("hello world", 1000, "hello", true, "  qwen2.5:7b  ");
		expect(entry?.llmModel).toBe("qwen2.5:7b");
	});

	test("omits llmModel when the LLM did NOT run, even if a model was passed", () => {
		const store = makeStore();
		const history = createTranscriptionHistoryStore({
			maxEntries: 5,
			now: () => 1,
			makeId,
			store,
			storeKey: "history",
		});
		const entry = history.record("hello world", 1000, "hello world", false, "qwen2.5:7b");
		expect(entry?.llmModel).toBeUndefined();
	});

	test("omits llmModel when the model is empty/whitespace or absent", () => {
		const store = makeStore();
		const history = createTranscriptionHistoryStore({
			maxEntries: 5,
			now: () => 1,
			makeId,
			store,
			storeKey: "history",
		});
		expect(history.record("a", 1, undefined, true, "   ")?.llmModel).toBeUndefined();
		expect(history.record("b", 1, undefined, true)?.llmModel).toBeUndefined();
	});
});

describe("createTranscriptionHistoryStore.getHistory", () => {
	test("returns a defensive copy (caller mutations don't leak back)", () => {
		const store = makeStore();
		const history = createTranscriptionHistoryStore({
			maxEntries: 5,
			now: () => 1,
			makeId,
			store,
			storeKey: "history",
		});
		history.record("a", 1);
		const snapshot = history.getHistory();
		snapshot.pop();
		expect(history.getHistory()).toHaveLength(1);
	});
});

describe("createTranscriptionHistoryStore.clear", () => {
	test("empties the in-memory entries and persists the empty array", () => {
		const store = makeStore();
		const history = createTranscriptionHistoryStore({
			maxEntries: 5,
			now: () => 1,
			makeId,
			store,
			storeKey: "history",
		});
		history.record("a", 1);
		history.record("b", 1);
		history.clear();
		expect(history.getHistory()).toEqual([]);
		expect(store.state.history).toEqual([]);
	});
});

describe("createTranscriptionHistoryStore hydration", () => {
	test("loads existing valid entries from the store on construction", () => {
		const store = makeStore([
			{
				id: "x",
				timestamp: 100,
				text: "hi",
				wordCount: 1,
				durationMs: 500,
			},
		]);
		const history = createTranscriptionHistoryStore({
			maxEntries: 5,
			now: () => 1,
			makeId,
			store,
			storeKey: "history",
		});
		expect(history.getHistory()).toEqual([
			{ id: "x", timestamp: 100, text: "hi", wordCount: 1, durationMs: 500 },
		]);
	});

	test("filters out malformed entries on hydration", () => {
		const store = makeStore([
			{ id: "ok", timestamp: 1, text: "hi", wordCount: 1, durationMs: 1 },
			{ id: "bad-no-text", timestamp: 1, wordCount: 1, durationMs: 1 },
			"not-an-object",
			null,
		]);
		const history = createTranscriptionHistoryStore({
			maxEntries: 5,
			now: () => 1,
			makeId,
			store,
			storeKey: "history",
		});
		expect(history.getHistory().map((e) => e.id)).toEqual(["ok"]);
	});

	test("starts empty when the stored value isn't an array", () => {
		const store = makeStore("garbage");
		const history = createTranscriptionHistoryStore({
			maxEntries: 5,
			now: () => 1,
			makeId,
			store,
			storeKey: "history",
		});
		expect(history.getHistory()).toEqual([]);
	});

	// Each test below targets exactly one field predicate inside isEntry.
	// They kill mutants that would weaken a single `typeof v.X === "Y"` check
	// to `true`, ensuring CRAP can drop and stay there after the split.
	const validEntry = {
		id: "ok",
		timestamp: 1,
		text: "hi",
		wordCount: 1,
		durationMs: 1,
	};

	function hydrateWith(raw: unknown[]): unknown[] {
		const store = makeStore(raw);
		const history = createTranscriptionHistoryStore({
			maxEntries: 5,
			now: () => 1,
			makeId,
			store,
			storeKey: "history",
		});
		return history.getHistory();
	}

	test("rejects entries with a non-string id", () => {
		expect(hydrateWith([{ ...validEntry, id: 42 }])).toEqual([]);
	});

	test("rejects entries with a non-number timestamp", () => {
		expect(hydrateWith([{ ...validEntry, timestamp: "now" }])).toEqual([]);
	});

	test("rejects entries with a non-string text", () => {
		expect(hydrateWith([{ ...validEntry, text: 7 }])).toEqual([]);
	});

	test("rejects entries with a non-number wordCount", () => {
		expect(hydrateWith([{ ...validEntry, wordCount: "many" }])).toEqual([]);
	});

	test("rejects entries with a non-number durationMs", () => {
		expect(hydrateWith([{ ...validEntry, durationMs: null }])).toEqual([]);
	});

	test("rejects non-object array elements (e.g. arrays, numbers)", () => {
		// `typeof [] === "object"` is true; null was already covered by the
		// existing malformed-entries test. Verify other non-record primitives.
		expect(hydrateWith([42, "string", true])).toEqual([]);
	});
});
