import { useEffect } from "react";
import { useCatalogStore, useModelStateStore } from "@/entities/model-catalog";
import { useSettingsStore } from "@/entities/setting";
import { isRealtimeEnabled } from "@/shared/lib/realtime-enabled";
import { resolveRealtimePreviewFallbackPatch } from "../model/realtime-preview-fallback";

/**
 * Global guard for the optional separate realtime model.
 *
 * Live transcription itself is enabled by display settings. If there is no
 * cached compatible native-streaming realtime model, we clear the realtime
 * slot and let the backend preview through the main model's chunked/window
 * path instead of selecting or downloading a model implicitly.
 */
export function useRealtimePreviewFallback(): void {
  const settingsLoaded = useSettingsStore((s) => s.isLoaded);
  const model = useSettingsStore((s) => s.settings.model);
  const showRecordingOverlay = useSettingsStore(
    (s) => s.settings.general?.showRecordingOverlay ?? true,
  );
  const liveTranscriptionDisplay = useSettingsStore(
    (s) => s.settings.general?.liveTranscriptionDisplay ?? "both",
  );
  const wordByWordPasting = useSettingsStore(
    (s) => s.settings.general?.wordByWordPasting ?? false,
  );
  const llmDictationEnabled = useSettingsStore(
    (s) => s.settings.llm.dictation.enabled,
  );
  const updateModelSettings = useSettingsStore((s) => s.updateModelSettings);
  const catalogLoaded = useCatalogStore((s) => s.isLoaded);
  const catalogModels = useCatalogStore((s) => s.models);
  const statesLoaded = useModelStateStore((s) => s.isLoaded);
  const statesById = useModelStateStore((s) => s.statesById);
  const refreshStates = useModelStateStore((s) => s.refresh);
  const realtimeEnabled = isRealtimeEnabled({
    showRecordingOverlay,
    liveTranscriptionDisplay,
    llmDictationEnabled,
    wordByWordPasting,
  });

  useEffect(() => {
    if (settingsLoaded && realtimeEnabled && !statesLoaded) {
      void refreshStates();
    }
  }, [refreshStates, realtimeEnabled, settingsLoaded, statesLoaded]);

  useEffect(() => {
    if (!settingsLoaded) {
      return;
    }
    const patch = resolveRealtimePreviewFallbackPatch({
      catalogLoaded,
      catalogModels,
      currentMainModel: model.model,
      currentRealtimeModel: model.realtimeModel,
      realtimeEnabled,
      statesById,
      statesLoaded,
    });
    if (patch) {
      updateModelSettings(patch);
    }
  }, [
    catalogLoaded,
    catalogModels,
    model.model,
    model.realtimeModel,
    realtimeEnabled,
    settingsLoaded,
    statesById,
    statesLoaded,
    updateModelSettings,
  ]);
}
