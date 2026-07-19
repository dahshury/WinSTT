import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { commands } from "@/bindings";
import type { HistoryTableItem } from "../model/history-table-types";
import { useHistorySearch } from "./use-history-search";

interface SearchResult {
	ftsActive: boolean;
	hasMore: boolean;
	transcriptions: Array<{
		entry: HistoryTableItem["entry"];
		tier: number;
	}>;
	transforms: never[];
	tts: never[];
}

type SearchCommand = (
	query: string,
	limit: number,
	offset: number,
	kinds: string[],
	dateFrom: number | null,
	dateTo: number | null,
) => Promise<
	{ data: SearchResult; status: "ok" } | { error: string; status: "error" }
>;

const mutableCommands = commands as unknown as {
	historySearch: SearchCommand;
};
const originalWorker = globalThis.Worker;
const originalSearch = mutableCommands.historySearch;

const memoryItem: HistoryTableItem = {
	entry: {
		durationMs: 0,
		id: "memory",
		text: "alpha memory",
		timestamp: 2000,
		wordCount: 2,
	},
	kind: "transcription",
};
const memoryItems = [memoryItem];

function result(
	entries: SearchResult["transcriptions"] = [],
	hasMore = false,
): { data: SearchResult; status: "ok" } {
	return {
		data: {
			ftsActive: true,
			hasMore,
			transcriptions: entries,
			transforms: [],
			tts: [],
		},
		status: "ok",
	};
}

beforeEach(() => {
	// Exercise the hook's documented synchronous fallback. Worker construction is
	// integration-tested by the worker's tiny message protocol and shared ranker.
	Object.defineProperty(globalThis, "Worker", {
		configurable: true,
		value: undefined,
		writable: true,
	});
	mutableCommands.historySearch = mock(
		async (
			_query: string,
			_limit: number,
			_offset: number,
			_kinds: string[],
			_dateFrom: number | null,
			_dateTo: number | null,
		) => result(),
	);
});

afterAll(() => {
	mutableCommands.historySearch = originalSearch;
	Object.defineProperty(globalThis, "Worker", {
		configurable: true,
		value: originalWorker,
		writable: true,
	});
});

describe("useHistorySearch", () => {
	test("passes through entries synchronously without invoking the backend for an empty query", () => {
		const { result: hook } = renderHook(() =>
			useHistorySearch("  ", memoryItems, null),
		);

		expect(hook.current.loading).toBe(false);
		expect(hook.current.items).toEqual([memoryItem]);
		expect(mutableCommands.historySearch).not.toHaveBeenCalled();
	});

	test("keeps one-character searches in memory", async () => {
		const { result: hook } = renderHook(() =>
			useHistorySearch("a", memoryItems, null),
		);

		await waitFor(() => expect(hook.current.loading).toBe(false));
		expect(hook.current.items.map((item) => item.entry.id)).toEqual(["memory"]);
		expect(mutableCommands.historySearch).not.toHaveBeenCalled();
	});

	test("materializes backend rows that are outside the in-memory cap", async () => {
		mutableCommands.historySearch = mock(async () =>
			result(
				[
					{
						entry: {
							durationMs: 0,
							id: "remote",
							text: "remote archive",
							timestamp: 1000,
							wordCount: 2,
						},
						tier: 1,
					},
				],
				true,
			),
		);
		const { result: hook, rerender } = renderHook(
			({ query }: { query: string }) =>
				useHistorySearch(query, memoryItems, null),
			{ initialProps: { query: "remote" } },
		);

		expect(hook.current.loading).toBe(true);
		await waitFor(() => expect(hook.current.loading).toBe(false));
		expect(hook.current.items.map((item) => item.entry.id)).toEqual(["remote"]);
		expect(hook.current.hasMore).toBe(true);
		expect(hook.current.highlights.get("transcription:remote")).toEqual([
			{ end: 6, start: 0 },
		]);

		rerender({ query: "" });
		expect(hook.current).toEqual({
			hasMore: false,
			highlights: new Map(),
			items: memoryItems,
			loading: false,
			totalLabelCount: 1,
		});
	});

	test("drops a late response from an older query", async () => {
		let resolveOld: ((value: ReturnType<typeof result>) => void) | undefined;
		mutableCommands.historySearch = mock((query: string) => {
			if (query === "alpha") {
				return new Promise<ReturnType<typeof result>>((resolve) => {
					resolveOld = resolve;
				});
			}
			return Promise.resolve(result());
		});
		const { result: hook, rerender } = renderHook(
			({ query }: { query: string }) =>
				useHistorySearch(query, memoryItems, null),
			{ initialProps: { query: "alpha" } },
		);

		expect(hook.current.loading).toBe(true);
		rerender({ query: "memory" });
		expect(hook.current.loading).toBe(true);
		await waitFor(() => expect(hook.current.loading).toBe(false));
		expect(hook.current.items.map((item) => item.entry.id)).toEqual(["memory"]);

		await act(async () => {
			resolveOld?.(result());
			await Promise.resolve();
		});
		expect(hook.current.items.map((item) => item.entry.id)).toEqual(["memory"]);
	});

	test("sends inclusive local-day bounds to the backend", async () => {
		const search = mock(
			async (
				_query: string,
				_limit: number,
				_offset: number,
				_kinds: string[],
				_dateFrom: number | null,
				_dateTo: number | null,
			) => result(),
		);
		mutableCommands.historySearch = search;
		const from = new Date(2026, 6, 10, 12, 30);
		const to = new Date(2026, 6, 11, 8, 15);
		const range = { from, to };
		renderHook(() => useHistorySearch("memory", memoryItems, range));

		await waitFor(() => expect(search).toHaveBeenCalled());
		expect(search.mock.calls[0]?.[4]).toBe(new Date(2026, 6, 10).getTime());
		expect(search.mock.calls[0]?.[5]).toBe(
			new Date(2026, 6, 11, 23, 59, 59, 999).getTime(),
		);
	});
});
