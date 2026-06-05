import { providerOf } from "@/entities/cloud-stt-provider";
import {
  isSelectableRealtimeModel,
  type ModelInfo,
  modelsHaveLanguageOverlap,
  pickCachedSttModel,
  pickDefaultSttModel,
} from "@/entities/model-catalog";
import type { ModelStateEntry } from "@/shared/api/ipc-client";

type StatesById = Record<string, ModelStateEntry>;

export interface RealtimePreviewFallbackArgs {
  catalogLoaded: boolean;
  catalogModels: readonly ModelInfo[];
  currentMainModel: string | undefined;
  currentRealtimeModel: string | undefined;
  realtimeEnabled: boolean;
  statesById: StatesById;
  statesLoaded: boolean;
}

export interface RealtimePreviewFallbackPatch {
  realtimeModel: string;
}

function resolveEffectiveMainModel(
  currentMainModel: string | undefined,
  catalogModels: readonly ModelInfo[],
  statesById: StatesById,
): ModelInfo | null {
  if (providerOf(currentMainModel ?? "") !== null) {
    return null;
  }
  const current = catalogModels.find((m) => m.id === currentMainModel);
  if (current) {
    return current;
  }
  const fallbackId = pickDefaultSttModel(catalogModels, statesById);
  return catalogModels.find((m) => m.id === fallbackId) ?? null;
}

function compatibleRealtimeModels(
  effectiveMain: ModelInfo | null,
  catalogModels: readonly ModelInfo[],
): readonly ModelInfo[] {
  return catalogModels.filter(
    (m) =>
      isSelectableRealtimeModel(m) &&
      (effectiveMain === null || modelsHaveLanguageOverlap(effectiveMain, m)),
  );
}

function isCached(model: ModelInfo | undefined, statesById: StatesById): boolean {
  return model !== undefined && statesById[model.id]?.cache.state === "cached";
}

/**
 * Keep the realtime slot honest when live preview is enabled.
 *
 * A separate realtime model is optional in the Rust port: the backend worker
 * already falls back to the loaded main transcriber and its chunked/window
 * preview path when no cached native-streaming model is selected.
 */
export function resolveRealtimePreviewFallbackPatch(
  args: RealtimePreviewFallbackArgs,
): RealtimePreviewFallbackPatch | null {
  if (
    !args.realtimeEnabled ||
    !args.catalogLoaded ||
    !args.statesLoaded ||
    args.catalogModels.length === 0
  ) {
    return null;
  }
  const effectiveMain = resolveEffectiveMainModel(
    args.currentMainModel,
    args.catalogModels,
    args.statesById,
  );
  const compatibleRealtime = compatibleRealtimeModels(
    effectiveMain,
    args.catalogModels,
  );
  if (
    effectiveMain !== null &&
    isSelectableRealtimeModel(effectiveMain) &&
    isCached(effectiveMain, args.statesById)
  ) {
    return effectiveMain.id === args.currentRealtimeModel
      ? null
      : { realtimeModel: effectiveMain.id };
  }
  const currentRealtime = compatibleRealtime.find(
    (m) => m.id === args.currentRealtimeModel,
  );
  if (isCached(currentRealtime, args.statesById)) {
    return null;
  }
  const next = pickCachedSttModel(compatibleRealtime, args.statesById);
  if (next) {
    return next === args.currentRealtimeModel ? null : { realtimeModel: next };
  }
  return args.currentRealtimeModel ? { realtimeModel: "" } : null;
}
