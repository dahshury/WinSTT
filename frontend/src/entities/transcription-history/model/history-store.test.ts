import { beforeEach, describe, expect, test } from "bun:test";
// Capture the factory's initial state at module-load time, BEFORE any test
// runs setState(), so the snapshot reflects the source literals.
import { useHistoryViewStore } from "./history-store";
import type { HistoryEntry } from "./transcription-history";

const INITIAL_STATE = useHistoryViewStore.getInitialState();

function entry(id: number, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
	return {
		fileName: `rec-${id}.wav`,
		id,
		postProcessedText: null,
		postProcessPrompt: null,
		postProcessRequested: false,
		saved: false,
		timestamp: 1000 + id,
		title: `Entry ${id}`,
		transcriptionText: `text ${id}`,
		...overrides,
	};
}

beforeEach(() => {
	useHistoryViewStore.setState({
		entries: [],
		hasMore: false,
		loading: false,
		error: null,
	});
});

describe("useHistoryViewStore", () => {
	test("initial state defaults", () => {
		const s = useHistoryViewStore.getState();
		expect(s.entries).toEqual([]);
		expect(s.hasMore).toBe(false);
		expect(s.loading).toBe(false);
		expect(s.error).toBeNull();
	});

	test("factory initial-state literals (mutation guard)", () => {
		expect(INITIAL_STATE.entries).toEqual([]);
		expect(INITIAL_STATE.hasMore).toBe(false);
		expect(INITIAL_STATE.loading).toBe(false);
		expect(INITIAL_STATE.error).toBeNull();
	});

	describe("appendPage", () => {
		test("appends fresh entries to the end and sets hasMore", () => {
			useHistoryViewStore.setState({ entries: [entry(1)] });
			useHistoryViewStore.getState().appendPage({ entries: [entry(2), entry(3)], hasMore: true });
			const s = useHistoryViewStore.getState();
			expect(s.entries.map((e) => e.id)).toEqual([1, 2, 3]);
			expect(s.hasMore).toBe(true);
		});

		test("dedups by id against existing entries (no duplicate ids)", () => {
			useHistoryViewStore.setState({ entries: [entry(1), entry(2)] });
			useHistoryViewStore.getState().appendPage({ entries: [entry(2), entry(3)], hasMore: false });
			const s = useHistoryViewStore.getState();
			// id 2 was already present and must NOT be appended again.
			expect(s.entries.map((e) => e.id)).toEqual([1, 2, 3]);
			expect(s.hasMore).toBe(false);
		});

		test("appending an all-duplicate page still updates hasMore", () => {
			useHistoryViewStore.setState({ entries: [entry(1)], hasMore: true });
			useHistoryViewStore.getState().appendPage({ entries: [entry(1)], hasMore: false });
			const s = useHistoryViewStore.getState();
			expect(s.entries.map((e) => e.id)).toEqual([1]);
			expect(s.hasMore).toBe(false);
		});

		test("appending an empty page leaves entries untouched", () => {
			useHistoryViewStore.setState({ entries: [entry(1)] });
			useHistoryViewStore.getState().appendPage({ entries: [], hasMore: true });
			expect(useHistoryViewStore.getState().entries.map((e) => e.id)).toEqual([1]);
		});
	});

	describe("replaceFirstPage", () => {
		test("replaces entries wholesale and clears loading/error", () => {
			useHistoryViewStore.setState({
				entries: [entry(99)],
				loading: true,
				error: "stale",
				hasMore: true,
			});
			useHistoryViewStore
				.getState()
				.replaceFirstPage({ entries: [entry(1), entry(2)], hasMore: false });
			const s = useHistoryViewStore.getState();
			expect(s.entries.map((e) => e.id)).toEqual([1, 2]);
			expect(s.hasMore).toBe(false);
			expect(s.loading).toBe(false);
			expect(s.error).toBeNull();
		});
	});

	describe("insertRow", () => {
		test("prepends a new row newest-first", () => {
			useHistoryViewStore.setState({ entries: [entry(1)] });
			useHistoryViewStore.getState().insertRow(entry(2));
			expect(useHistoryViewStore.getState().entries.map((e) => e.id)).toEqual([2, 1]);
		});

		test("is a no-op (returns same state) when the id already exists", () => {
			useHistoryViewStore.setState({ entries: [entry(1), entry(2)] });
			const before = useHistoryViewStore.getState().entries;
			useHistoryViewStore.getState().insertRow(entry(2, { title: "should be ignored" }));
			const after = useHistoryViewStore.getState().entries;
			// Same reference back → React bails out of a re-render.
			expect(after).toBe(before);
			expect(after.find((e) => e.id === 2)?.title).toBe("Entry 2");
		});
	});

	describe("removeRow", () => {
		test("removes the matching id", () => {
			useHistoryViewStore.setState({ entries: [entry(1), entry(2), entry(3)] });
			useHistoryViewStore.getState().removeRow(2);
			expect(useHistoryViewStore.getState().entries.map((e) => e.id)).toEqual([1, 3]);
		});

		test("is a no-op (returns same state) when the id is absent", () => {
			useHistoryViewStore.setState({ entries: [entry(1)] });
			const before = useHistoryViewStore.getState().entries;
			useHistoryViewStore.getState().removeRow(999);
			expect(useHistoryViewStore.getState().entries).toBe(before);
		});
	});

	describe("toggleRow", () => {
		test("flips saved on the matching id only", () => {
			useHistoryViewStore.setState({ entries: [entry(1), entry(2, { saved: false })] });
			useHistoryViewStore.getState().toggleRow(2, true);
			const s = useHistoryViewStore.getState();
			expect(s.entries.find((e) => e.id === 2)?.saved).toBe(true);
			expect(s.entries.find((e) => e.id === 1)?.saved).toBe(false);
		});

		test("toggling an absent id maps over entries without changing any saved flag", () => {
			useHistoryViewStore.setState({ entries: [entry(1, { saved: true })] });
			useHistoryViewStore.getState().toggleRow(999, false);
			expect(useHistoryViewStore.getState().entries.find((e) => e.id === 1)?.saved).toBe(true);
		});
	});

	describe("clear / setLoading / setError", () => {
		test("clear resets entries, hasMore, loading AND error to a clean slate", () => {
			useHistoryViewStore.setState({
				entries: [entry(1)],
				hasMore: true,
				loading: true,
				error: "x",
			});
			useHistoryViewStore.getState().clear();
			const s = useHistoryViewStore.getState();
			expect(s.entries).toEqual([]);
			expect(s.hasMore).toBe(false);
			// Regression guard: clear() now also drops stale loading/error so a
			// clear during an in-flight load can't leave a phantom spinner/banner.
			expect(s.loading).toBe(false);
			expect(s.error).toBeNull();
		});

		test("setLoading toggles only the loading field", () => {
			useHistoryViewStore.getState().setLoading(true);
			const s = useHistoryViewStore.getState();
			expect(s.loading).toBe(true);
			expect(s.error).toBeNull();
		});

		test("setError sets a message and accepts null to clear it", () => {
			useHistoryViewStore.getState().setError("oops");
			expect(useHistoryViewStore.getState().error).toBe("oops");
			useHistoryViewStore.getState().setError(null);
			expect(useHistoryViewStore.getState().error).toBeNull();
		});
	});
});
