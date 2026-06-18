import { buildTranscriptDiff } from "@/shared/lib/transcript-diff";
import type { TranscriptDiffResult } from "@/shared/lib/transcript-diff";
import type { TranscriptionHistoryEntry } from "../model/history-store";

interface CachedEntryDiff {
	diff: TranscriptDiffResult | null;
	originalText: string | undefined;
	text: string;
}

const entryDiffCache = new WeakMap<TranscriptionHistoryEntry, CachedEntryDiff>();

export function getEntryTranscriptDiff(
	entry: TranscriptionHistoryEntry,
): TranscriptDiffResult | null {
	const originalText = entry.originalText;
	if (typeof originalText !== "string") {
		return null;
	}

	const cached = entryDiffCache.get(entry);
	if (
		cached &&
		cached.originalText === originalText &&
		cached.text === entry.text
	) {
		return cached.diff;
	}

	const diff = buildTranscriptDiff(originalText, entry.text);
	entryDiffCache.set(entry, { diff, originalText, text: entry.text });
	return diff;
}
