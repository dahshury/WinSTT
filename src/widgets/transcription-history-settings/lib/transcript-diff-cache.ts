import { buildTranscriptDiff } from "@/shared/lib/transcript-diff";
import type { TranscriptDiffResult } from "@/shared/lib/transcript-diff";
import type { TranscriptionHistoryEntry } from "../model/history-store";

interface CachedEntryDiff {
	diff: TranscriptDiffResult | null;
	originalText: string | undefined;
	text: string;
}

// Keyed by the entry's STABLE `id` (with a text/originalText guard), not the
// entry object. The word-level diff is the single most expensive per-entry
// computation in the History stats (an O(m×n) LCS), and a fresh
// `history:get-all` fetch — or a recompute in the stats worker — hands us brand
// new entry OBJECTS for the same logical rows. An object-keyed WeakMap missed
// every time that happened and rebuilt every diff; keying by id lets the result
// survive re-fetches and cross the worker boundary intact, so each row is
// diffed once per session rather than once per render pass.
const MAX_CACHE_ENTRIES = 20_000;
const entryDiffCache = new Map<string, CachedEntryDiff>();

export function getEntryTranscriptDiff(
	entry: TranscriptionHistoryEntry,
): TranscriptDiffResult | null {
	const originalText = entry.originalText;
	if (typeof originalText !== "string") {
		return null;
	}

	const cached = entryDiffCache.get(entry.id);
	if (
		cached &&
		cached.originalText === originalText &&
		cached.text === entry.text
	) {
		return cached.diff;
	}

	const diff = buildTranscriptDiff(originalText, entry.text);
	// History is capped, but ids churn as rows are deleted/re-added over a long
	// session — a hard ceiling keeps this from growing without bound. A full
	// clear (rather than LRU bookkeeping) is fine: the working set re-warms on
	// the next stats pass.
	if (entryDiffCache.size >= MAX_CACHE_ENTRIES) {
		entryDiffCache.clear();
	}
	entryDiffCache.set(entry.id, { diff, originalText, text: entry.text });
	return diff;
}
