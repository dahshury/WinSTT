/**
 * Pure formatters for history rows. Kept in the entity layer so the view
 * + future widget consumers share one source of truth for "what does a
 * history timestamp render as" and "which text do we surface".
 */

import type { HistoryEntry } from "../model/transcription-history";

// Hoisted to module scope: locale (system default) and options are constant, so
// the formatter's locale-data tables load once instead of per call.
const entryTimestampFormatter = new Intl.DateTimeFormat(undefined, {
	dateStyle: "medium",
	timeStyle: "short",
});

/**
 * Pick the user-facing transcription text for a row. Prefers the post-LLM
 * cleaned version when LLM ran and produced different output; otherwise the
 * raw transcript. Matches the renderer-side widget's
 * `shouldKeepOriginalText` policy from `transcription-history.ts`.
 */
export function effectiveText(entry: HistoryEntry): string {
	const cleaned = entry.postProcessedText?.trim();
	if (cleaned && cleaned.length > 0) {
		return cleaned;
	}
	return entry.transcriptionText;
}

/**
 * Format the entry's `timestamp` (epoch seconds) in the user's locale. We
 * use a format string compatible with Intl.DateTimeFormat so platform-local
 * conventions win — we honour the system locale rather than hardcoding US-English.
 */
export function formatEntryTimestamp(entry: HistoryEntry): string {
	const date = new Date(entry.timestamp * 1000);
	if (Number.isNaN(date.getTime())) {
		return entry.title;
	}
	return entryTimestampFormatter.format(date);
}

/**
 * Approximate "word count" for the row's effective text. Whitespace-delimited
 * tokens, matching the legacy persisted store history's policy in
 * `transcription-history.ts`'s `countWords`.
 */
export function entryWordCount(entry: HistoryEntry): number {
	const text = effectiveText(entry);
	const matches = text.match(/\S+/g);
	return matches ? matches.length : 0;
}
