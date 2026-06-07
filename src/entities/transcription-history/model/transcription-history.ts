/**
 * Renderer-side mirror of the main-process `HistoryEntryRow` shape (see
 * `electron/ipc/history-store.ts`). Field names match the OpenAPI
 * `HistoryEntry` schema 1:1 so a future spec-driven refactor can swap this
 * for a generated type without touching call sites.
 */

export type RecordingRetention =
  | "never"
  | "cap"
  | "days3"
  | "weeks2"
  | "months3";

export interface HistoryEntry {
  fileName: string;
  historyTag?: string | null;
  id: number;
  postProcessedText: string | null;
  postProcessPrompt: string | null;
  postProcessRequested: boolean;
  privacyMarkers?: string[];
  saved: boolean;
  timestamp: number;
  title: string;
  transcriptionText: string;
}

export interface PaginatedHistory {
  entries: HistoryEntry[];
  hasMore: boolean;
}
