import {
	rankHistorySearchItems,
	type HistorySearchWorkerItem,
	type HistorySearchWorkerMatch,
} from "./history-search-ranking";

export interface HistorySearchWorkerRequest {
	items: HistorySearchWorkerItem[];
	query: string;
	seq: number;
}

export interface HistorySearchWorkerResponse {
	matches: HistorySearchWorkerMatch[];
	seq: number;
}

interface WorkerScope {
	onmessage: ((event: MessageEvent<HistorySearchWorkerRequest>) => void) | null;
	postMessage: (message: HistorySearchWorkerResponse) => void;
}

const ctx = self as unknown as WorkerScope;

ctx.onmessage = (event) => {
	const { items, query, seq } = event.data;
	ctx.postMessage({ matches: rankHistorySearchItems(query, items), seq });
};
