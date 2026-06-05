/**
 * Renderer-side adapter for the `history:*` IPC channels. Transport lives in
 * `shared/api/ipc-client`; this entity adapter owns only the history-facing
 * fallback shapes.
 */

import {
  historyDeleteRow,
  historyListPage,
  historyLoadAudioByRow,
  historyToggleRow,
} from "@/shared/api/ipc-client";
import type { PaginatedHistory } from "../model/transcription-history";

export async function listHistoryPage(options: {
  offset: number;
  limit: number;
}): Promise<PaginatedHistory> {
  const result =
    await historyListPage<PaginatedHistory["entries"][number]>(options);
  return result ?? { entries: [], hasMore: false };
}

export async function deleteHistoryRow(id: number): Promise<boolean> {
  const result = await historyDeleteRow(id);
  return result?.deleted === true;
}

export async function toggleHistoryRow(id: number): Promise<boolean | null> {
  const result = await historyToggleRow(id);
  return result?.saved ?? null;
}

export async function loadHistoryAudio(id: number): Promise<string | null> {
  return historyLoadAudioByRow(id);
}
