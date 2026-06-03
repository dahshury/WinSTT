/**
 * Renderer-side adapter for the `history:*` IPC channels owned by
 * `electron/ipc/history.ts`. All calls go through `window.nativeBridge.invoke`
 * so the entity layer never touches the reference's globals directly (FSD: only
 * `shared` may hold IPC helpers — this file is a thin adapter, not a
 * generic client, so it's allowed in the entity).
 */

import { IPC } from "@/shared/api/ipc-channels";
import type { PaginatedHistory } from "../model/transcription-history";

function getApi(): Window["nativeBridge"] | null {
	// `window.nativeBridge` is injected by the preload bridge and typed globally
	// in src/shared/lib/native-bridge.d.ts. It's absent in non-bridge contexts (tests / plain
	// browser), so guard for that even though the ambient type marks it present.
	return window.nativeBridge ?? null;
}

export async function listHistoryPage(options: {
	offset: number;
	limit: number;
}): Promise<PaginatedHistory> {
	const api = getApi();
	if (!api) {
		return { entries: [], hasMore: false };
	}
	const result = (await api.invoke(IPC.HISTORY_LIST, options)) as PaginatedHistory | null;
	return result ?? { entries: [], hasMore: false };
}

export async function deleteHistoryRow(id: number): Promise<boolean> {
	const api = getApi();
	if (!api) {
		return false;
	}
	const result = (await api.invoke(IPC.HISTORY_DELETE_ROW, id)) as { deleted: boolean } | null;
	return result?.deleted === true;
}

export async function toggleHistoryRow(id: number): Promise<boolean | null> {
	const api = getApi();
	if (!api) {
		return null;
	}
	const result = (await api.invoke(IPC.HISTORY_TOGGLE, id)) as { saved: boolean | null } | null;
	return result?.saved ?? null;
}

export async function loadHistoryAudio(id: number): Promise<string | null> {
	const api = getApi();
	if (!api) {
		return null;
	}
	const result = (await api.invoke(IPC.HISTORY_LOAD_AUDIO_BY_ROW, id)) as string | null;
	return result;
}
