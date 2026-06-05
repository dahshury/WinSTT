import type { ModelStateEntry } from "@/shared/api/ipc-client";
import type { ModelInfo } from "../model/catalog-store";
import { pickCachedSttModel } from "./model-options";

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
const HISTORY_STORAGE_KEY = "winstt:last-local-stt-model-history";
const MAX_HISTORY = 8;

function readHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) {
      const last = localStorage.getItem(STORAGE_KEY);
      return last ? [last] : [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is string => typeof item === "string" && item.length > 0,
        )
      : [];
  } catch {
    return [];
  }
}

function writeHistory(ids: readonly string[]): void {
  try {
    localStorage.setItem(
      HISTORY_STORAGE_KEY,
      JSON.stringify(ids.slice(0, MAX_HISTORY)),
    );
  } catch {
    // no-op: persistence is best-effort
  }
}

/** Remember a locally-selected model id. Callers pass only local (non-cloud)
 *  ids; empty ids are ignored. Swallows storage errors (private mode / quota) —
 *  the catalog-default fallback keeps the toggle working regardless. */
export function recordLastLocalSttModel(modelId: string): void {
  if (!modelId) {
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, modelId);
    const next = [modelId, ...readHistory().filter((id) => id !== modelId)];
    writeHistory(next);
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
  const last = readLastLocalSttModel();
  if (
    last &&
    statesById[last]?.cache.state === "cached" &&
    models.some((m) => m.id === last)
  ) {
    return last;
  }
  return pickCachedSttModel(models, statesById);
}
