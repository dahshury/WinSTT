import type { HistoryRow } from "@/bindings";

export type RecordingRetention =
	| "never"
	| "cap"
	| "days3"
	| "weeks2"
	| "months3";

/**
 * The backend row shape, straight from the generated tauri-specta bindings.
 * This used to be a hand-maintained mirror; every field had to be kept in sync
 * by hand, and the drift it allowed (`privacyMarkers` was non-nullable here but
 * nullable in Rust) was being papered over by a cast at the search call site.
 */
export type HistoryEntry = HistoryRow;

export interface PaginatedHistory {
	entries: HistoryEntry[];
	hasMore: boolean;
}
