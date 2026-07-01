import { useEffect, useState } from "react";
import type { TranscriptionHistoryEntry } from "../model/history-store";
import type {
	HistoryStatsRequest,
	HistoryStatsResponse,
} from "../lib/history-stats.worker";
import type { AggregateStats } from "../lib/word-stats";
import { aggregate } from "../lib/word-stats";
import type { VoiceProfileStats } from "../lib/voice-profile";
import { computeVoiceProfile } from "../lib/voice-profile";

export interface HistoryStatsBundle {
	stats: AggregateStats;
	voiceProfile: VoiceProfileStats;
}

const EMPTY_STATS: AggregateStats = {
	aiFixes: 0,
	count: 0,
	dictionaryFixes: 0,
	totalDurationMs: 0,
	totalWords: 0,
	wordsCorrected: 0,
	wpm: 0,
};

const EMPTY_VOICE_PROFILE: VoiceProfileStats = {
	catchphrase: null,
	mostCorrectedWord: null,
	mostUsedWord: null,
	peakTime: null,
};

function computeOnMainThread(
	entries: TranscriptionHistoryEntry[],
): HistoryStatsBundle {
	return {
		stats: aggregate(entries),
		voiceProfile: computeVoiceProfile(entries),
	};
}

// One worker per window, created lazily on first use. `undefined` = not yet
// tried, `null` = construction failed / unsupported (fall back to the main
// thread). Building the first-ever worker into a packaged Tauri webview is the
// one piece we can't fully verify ahead of time, so every path degrades to a
// synchronous compute rather than leaving the panel stuck loading.
let worker: Worker | null | undefined;
let nextSeq = 1;
const inflight = new Map<
	number,
	{
		entries: TranscriptionHistoryEntry[];
		resolve: (b: HistoryStatsBundle) => void;
	}
>();

function settleWithFallback(): void {
	worker = null;
	for (const [, req] of inflight) {
		req.resolve(computeOnMainThread(req.entries));
	}
	inflight.clear();
}

function getWorker(): Worker | null {
	if (worker !== undefined) {
		return worker;
	}
	try {
		worker = new Worker(
			new URL("../lib/history-stats.worker.ts", import.meta.url),
			{ type: "module" },
		);
		worker.onmessage = (event: MessageEvent<HistoryStatsResponse>) => {
			const req = inflight.get(event.data.seq);
			if (req) {
				inflight.delete(event.data.seq);
				req.resolve({
					stats: event.data.stats,
					voiceProfile: event.data.voiceProfile,
				});
			}
		};
		// A worker crash must not leave the panel spinning — resolve everything
		// in flight on the main thread and stop using the worker.
		worker.onerror = settleWithFallback;
	} catch {
		worker = null;
	}
	return worker;
}

function computeBundle(
	entries: TranscriptionHistoryEntry[],
): Promise<HistoryStatsBundle> {
	const w = getWorker();
	if (!w) {
		return Promise.resolve(computeOnMainThread(entries));
	}
	const seq = nextSeq++;
	return new Promise<HistoryStatsBundle>((resolve) => {
		inflight.set(seq, { entries, resolve });
		try {
			const message: HistoryStatsRequest = { entries, seq };
			w.postMessage(message);
		} catch {
			inflight.delete(seq);
			resolve(computeOnMainThread(entries));
		}
	});
}

// Computed bundles keyed by the (reference-stable) filtered-entries array. A
// revisit with unchanged data reuses the result synchronously — no worker
// round-trip, no skeleton flash — which is what makes returning to the History
// tab instant once A keeps the array identity stable.
const bundleCache = new WeakMap<
	TranscriptionHistoryEntry[],
	HistoryStatsBundle
>();

export interface UseHistoryStatsResult extends HistoryStatsBundle {
	/** True only on the first compute for a given input (no cached bundle yet). */
	loading: boolean;
}

/**
 * The diff/tokenize-heavy History stats, computed off the main thread. Returns
 * the last known bundle while a recompute is in flight (no flicker on data
 * changes) and `loading: true` only when there's nothing to show yet, so the
 * caller can render a skeleton for the very first compute.
 */
export function useHistoryStats(
	filteredEntries: TranscriptionHistoryEntry[],
): UseHistoryStatsResult {
	const cached = bundleCache.get(filteredEntries) ?? null;
	const [computed, setComputed] = useState<HistoryStatsBundle | null>(
		() => cached,
	);

	useEffect(() => {
		if (bundleCache.has(filteredEntries)) {
			return;
		}
		let active = true;
		computeBundle(filteredEntries).then((result) => {
			bundleCache.set(filteredEntries, result);
			if (active) {
				setComputed(result);
			}
		});
		return () => {
			active = false;
		};
	}, [filteredEntries]);

	const current = cached ?? computed;
	return {
		loading: current === null,
		stats: current?.stats ?? EMPTY_STATS,
		voiceProfile: current?.voiceProfile ?? EMPTY_VOICE_PROFILE,
	};
}
