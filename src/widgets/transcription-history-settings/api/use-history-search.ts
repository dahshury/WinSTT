import { useEffect, useRef, useState } from "react";
import {
	commands,
	type HistorySearchResult as BackendSearchResult,
} from "@/bindings";
import type { DateRange } from "@/shared/ui/calendar-heatmap";
import { dayRangeBounds } from "../lib/word-stats";
import type {
	TransformHistoryEntry,
	TranscriptionHistoryEntry,
	TtsHistoryEntry,
} from "../model/history-store";
import type { HistoryTableItem } from "../model/history-table-types";
import {
	rankHistorySearchItems,
	type HistorySearchWorkerItem,
	type HistorySearchWorkerMatch,
} from "../lib/history-search-ranking";
import type {
	HistorySearchWorkerRequest,
	HistorySearchWorkerResponse,
} from "../lib/history-search.worker";

function historyItemKey(item: HistoryTableItem): string {
	return `${item.kind}:${item.entry.id}`;
}

function withoutNullOptionals<T extends object>(entry: object): T {
	return Object.fromEntries(
		Object.entries(entry).filter(([, value]) => value !== null),
	) as T;
}

function toTtsItem(entry: TtsHistoryEntry): HistoryTableItem {
	return {
		entry: {
			durationMs: 0,
			id: entry.id,
			text: entry.text,
			timestamp: entry.timestamp,
			wordCount: entry.wordCount,
		},
		kind: "tts",
		tts: entry,
	};
}

interface CandidateSet {
	byKey: Map<string, HistoryTableItem>;
	workerItems: HistorySearchWorkerItem[];
}

function buildCandidates(
	entries: HistoryTableItem[],
	backend: BackendSearchResult | null,
): CandidateSet {
	const byKey = new Map<string, HistoryTableItem>();
	const tiers = new Map<string, 1 | 2>();
	for (const item of entries) {
		byKey.set(historyItemKey(item), item);
	}
	if (backend) {
		for (const hit of backend.transcriptions) {
			const item: HistoryTableItem = {
				entry: withoutNullOptionals<TranscriptionHistoryEntry>(hit.entry),
				kind: "transcription",
			};
			const key = historyItemKey(item);
			byKey.set(key, item);
			tiers.set(key, hit.tier === 1 ? 1 : 2);
		}
		for (const hit of backend.transforms) {
			const item: HistoryTableItem = {
				entry: withoutNullOptionals<TransformHistoryEntry>(hit.entry),
				kind: "transform",
			};
			const key = historyItemKey(item);
			byKey.set(key, item);
			tiers.set(key, hit.tier === 1 ? 1 : 2);
		}
		for (const hit of backend.tts) {
			const item = toTtsItem(withoutNullOptionals<TtsHistoryEntry>(hit.entry));
			const key = historyItemKey(item);
			byKey.set(key, item);
			tiers.set(key, hit.tier === 1 ? 1 : 2);
		}
	}
	return {
		byKey,
		workerItems: [...byKey].map(([key, item]) => ({
			backendTier: tiers.get(key) ?? null,
			key,
			text: item.entry.text,
			timestamp: item.entry.timestamp,
		})),
	};
}

let worker: Worker | null | undefined;
let nextWorkerSeq = 1;
const inflight = new Map<
	number,
	{
		items: HistorySearchWorkerItem[];
		query: string;
		resolve: (matches: HistorySearchWorkerMatch[]) => void;
	}
>();

function settleWorkerWithFallback(): void {
	worker = null;
	for (const request of inflight.values()) {
		request.resolve(rankHistorySearchItems(request.query, request.items));
	}
	inflight.clear();
}

function getWorker(): Worker | null {
	if (worker !== undefined) {
		return worker;
	}
	try {
		worker = new Worker(
			new URL("../lib/history-search.worker.ts", import.meta.url),
			{ type: "module" },
		);
		worker.onmessage = (event: MessageEvent<HistorySearchWorkerResponse>) => {
			const request = inflight.get(event.data.seq);
			if (request) {
				inflight.delete(event.data.seq);
				request.resolve(event.data.matches);
			}
		};
		worker.onerror = settleWorkerWithFallback;
	} catch {
		worker = null;
	}
	return worker;
}

function rankCandidates(
	query: string,
	items: HistorySearchWorkerItem[],
): Promise<HistorySearchWorkerMatch[]> {
	const activeWorker = getWorker();
	if (!activeWorker) {
		return Promise.resolve(rankHistorySearchItems(query, items));
	}
	const seq = nextWorkerSeq++;
	return new Promise((resolve) => {
		inflight.set(seq, { items, query, resolve });
		try {
			const request: HistorySearchWorkerRequest = { items, query, seq };
			activeWorker.postMessage(request);
		} catch {
			inflight.delete(seq);
			resolve(rankHistorySearchItems(query, items));
		}
	});
}

async function searchBackend(
	query: string,
	range: DateRange | null,
): Promise<BackendSearchResult | null> {
	if (query.trim().length < 2) {
		return null;
	}
	const bounds = dayRangeBounds(range?.from ?? null, range?.to ?? null);
	const response = await commands.historySearch(
		query,
		200,
		0,
		["transcription", "transform", "tts"],
		bounds?.fromTs ?? null,
		bounds?.toTs ?? null,
	);
	if (response.status === "error") {
		throw new Error(response.error);
	}
	return response.data;
}

export interface UseHistorySearchResult {
	hasMore: boolean;
	highlights: Map<string, HistorySearchWorkerMatch["ranges"]>;
	items: HistoryTableItem[];
	loading: boolean;
	totalLabelCount: number;
}

export function useHistorySearch(
	query: string,
	combinedEntries: HistoryTableItem[],
	range: DateRange | null,
): UseHistorySearchResult {
	const [result, setResult] = useState<UseHistorySearchResult>({
		hasMore: false,
		highlights: new Map(),
		items: combinedEntries,
		loading: false,
		totalLabelCount: combinedEntries.length,
	});
	const requestSeq = useRef(0);

	useEffect(() => {
		const normalizedQuery = query.trim();
		const seq = ++requestSeq.current;
		if (!normalizedQuery) {
			setResult({
				hasMore: false,
				highlights: new Map(),
				items: combinedEntries,
				loading: false,
				totalLabelCount: combinedEntries.length,
			});
			return;
		}
		setResult((current) => ({ ...current, loading: true }));
		searchBackend(normalizedQuery, range)
			.catch(() => null)
			.then((backend) => {
				const candidates = buildCandidates(combinedEntries, backend);
				return rankCandidates(normalizedQuery, candidates.workerItems).then(
					(matches) => ({ backend, candidates, matches }),
				);
			})
			.then(({ backend, candidates, matches }) => {
				if (requestSeq.current !== seq) {
					return;
				}
				setResult({
					hasMore: backend?.hasMore ?? false,
					highlights: new Map(
						matches.map((match) => [match.key, match.ranges]),
					),
					items: matches.flatMap((match) => {
						const item = candidates.byKey.get(match.key);
						return item ? [item] : [];
					}),
					loading: false,
					totalLabelCount: matches.length,
				});
			});
	}, [combinedEntries, query, range]);

	return result;
}
