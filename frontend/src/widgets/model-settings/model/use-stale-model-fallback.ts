import { useEffect } from "react";
import { providerOf } from "@/entities/cloud-stt-provider";
import {
	needsModelFallback,
	pickDefaultSttModel,
	type useCatalogStore,
	type useModelStateStore,
} from "@/entities/model-catalog";
import type { useSettingsStore } from "@/entities/setting";

type CatalogModels = ReturnType<typeof useCatalogStore.getState>["models"];
type StatesById = ReturnType<typeof useModelStateStore.getState>["statesById"];
type UpdateModelFn = ReturnType<typeof useSettingsStore.getState>["updateModelSettings"];

/**
 * Stale-model fallback for both the main and realtime model slots.
 *
 * STT is the always-on core capability — the selector must never be in a
 * "no model" state. If the saved id is empty (corrupted settings) or refers
 * to a model that's no longer in the catalog (catalog change), auto-pick the
 * smallest cached model so the user always lands on something usable. Skips
 * while the catalog is still loading so we don't false-positive every model
 * as missing during the boot race. Also skips when the active model is a
 * cloud `provider:*` id — those are never in the local catalog by design and
 * should not trigger a fallback.
 */
export function useStaleModelFallback(
	catalogLoaded: boolean,
	catalogModels: CatalogModels,
	statesById: StatesById,
	currentMainModel: string | undefined,
	currentRealtimeModel: string | undefined,
	update: UpdateModelFn
): void {
	useEffect(() => {
		if (!catalogLoaded) {
			return;
		}
		if (providerOf(currentMainModel ?? "") !== null) {
			return;
		}
		if (!needsModelFallback(currentMainModel, catalogModels)) {
			return;
		}
		const next = pickDefaultSttModel(catalogModels, statesById);
		if (next && next !== currentMainModel) {
			// Look up the picked model's catalog entry so we can patch
			// ``model`` and ``backend`` together — ``updateModelSettings``
			// rejects a model-only patch (see the typed ``ModelPatch``).
			// This was the original drift site: the fallback used to write
			// ``{ model: "tiny" }`` while leaving ``backend`` at whatever
			// the previous model used. Disk saved a mismatched pair, every
			// subsequent boot loaded the wrong engine for the right model.
			const fallbackEntry = catalogModels.find((m) => m.id === next);
			if (fallbackEntry?.backend) {
				update({ model: next, backend: fallbackEntry.backend });
			}
		}
	}, [catalogLoaded, catalogModels, statesById, currentMainModel, update]);

	// Same guard for the realtime model, narrowed to realtime-viable entries.
	useEffect(() => {
		if (!catalogLoaded) {
			return;
		}
		const realtimeViable = catalogModels.filter((m) => m.supportsRealtime);
		if (!needsModelFallback(currentRealtimeModel, realtimeViable)) {
			return;
		}
		const next = pickDefaultSttModel(catalogModels, statesById, (m) => m.supportsRealtime);
		if (next && next !== currentRealtimeModel) {
			update({ realtimeModel: next });
		}
	}, [catalogLoaded, catalogModels, statesById, currentRealtimeModel, update]);
}
