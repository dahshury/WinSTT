import type { ModelStateEntry } from "@/shared/api/ipc-client";
import {
	isStringArray,
	readPersistedSelectorState,
	writePersistedSelectorState,
} from "@/shared/lib/persisted-selector-state";
import type { ModelInfo } from "../model/catalog-store";
import { pickCachedSttModel } from "./model-options";

/**
 * Persistence for local STT selections. Only local ids belong here; cloud ids
 * would restore into a local-model slot.
 */
const HISTORY_STORAGE_KEY = "winstt:last-local-stt-model-history";
const MAX_HISTORY = 8;

function readHistory(): string[] {
	return readPersistedSelectorState(
		HISTORY_STORAGE_KEY,
		isStringArray,
		[],
	).filter((item) => item.length > 0);
}

function writeHistory(ids: readonly string[]): void {
	writePersistedSelectorState(HISTORY_STORAGE_KEY, ids.slice(0, MAX_HISTORY));
}

/** Remember a locally-selected model id. Callers pass only local (non-cloud)
 *  ids; empty ids are ignored. Swallows storage errors (private mode / quota) —
 *  the catalog-default fallback keeps the toggle working regardless. */
export function recordLastLocalSttModel(modelId: string): void {
	if (!modelId) {
		return;
	}
	const next = [modelId, ...readHistory().filter((id) => id !== modelId)];
	writeHistory(next);
}

/** Most-recent-first local model history. The first entry mirrors
 *  `readLastLocalSttModel`; later entries are the user's previous local
 *  choices and let deletion fallback avoid sticking to a removed current id. */
export function readLastLocalSttModelHistory(): string[] {
	return readHistory();
}

/**
 * Which local model to land on when flipping the source switch to Local: the
 * user's remembered last choice if it's still cached, otherwise the smallest
 * cached catalog model. Returns null when no local model is usable offline.
 */
export function resolveLocalDefault(
	models: readonly ModelInfo[],
	statesById: Record<string, ModelStateEntry>,
): string | null {
	const last = readHistory()[0] ?? null;
	if (
		last &&
		statesById[last]?.cache.state === "cached" &&
		models.some((m) => m.id === last)
	) {
		return last;
	}
	return pickCachedSttModel(models, statesById);
}
