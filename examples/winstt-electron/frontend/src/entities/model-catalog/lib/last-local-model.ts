import type { ModelStateEntry } from "@/shared/api/ipc-client";
import type { ModelInfo } from "../model/catalog-store";
import { pickDefaultSttModel } from "./model-options";

/**
 * Persistence for "the last local STT model the user had selected", so flipping
 * the source switch Cloud→Local restores that choice instead of resetting to the
 * smallest catalog model. Mirrors the localStorage pattern the favourites use.
 *
 * Only LOCAL ids belong here — the caller records whenever a local model is the
 * active selection (see ModelSettingsPanel), and {@link resolveLocalDefault}
 * reads it back when the user returns to Local. Cloud ids must never be stored,
 * or the restore would put a cloud id where a local one is expected.
 */
const STORAGE_KEY = "winstt:last-local-stt-model";

/** Remember a locally-selected model id. Callers pass only local (non-cloud)
 *  ids; empty ids are ignored. Swallows storage errors (private mode / quota) —
 *  the catalog-default fallback keeps the toggle working regardless. */
export function recordLastLocalSttModel(modelId: string): void {
	if (!modelId) {
		return;
	}
	try {
		localStorage.setItem(STORAGE_KEY, modelId);
	} catch {
		// no-op: persistence is best-effort
	}
}

/** The last remembered local model id, or null when none was stored. */
export function readLastLocalSttModel(): string | null {
	try {
		return localStorage.getItem(STORAGE_KEY);
	} catch {
		return null;
	}
}

/**
 * Which local model to land on when flipping the source switch to Local: the
 * user's remembered last choice if it's still a real catalog entry, otherwise
 * the smallest cached catalog model. Returns null only when the catalog is empty.
 */
export function resolveLocalDefault(
	models: readonly ModelInfo[],
	statesById: Record<string, ModelStateEntry>
): string | null {
	const last = readLastLocalSttModel();
	if (last && models.some((m) => m.id === last)) {
		return last;
	}
	return pickDefaultSttModel(models, statesById);
}
