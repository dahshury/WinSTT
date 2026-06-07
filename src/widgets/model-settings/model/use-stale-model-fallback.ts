import { useEffect } from "react";
import { providerOf } from "@/entities/cloud-stt-provider";
import {
	isSelectableRealtimeModel,
	isVisibleSttModel,
	modelSupportsSelectedSourceLanguages,
	modelsHaveLanguageOverlap,
	needsModelFallback,
	pickCachedSttModel,
	pickDefaultSttModel,
	type SourceLanguageSelection,
	type useCatalogStore,
	type useModelStateStore,
} from "@/entities/model-catalog";
import type { useSettingsStore } from "@/entities/setting";

type CatalogModels = ReturnType<typeof useCatalogStore.getState>["models"];
type StatesById = ReturnType<typeof useModelStateStore.getState>["statesById"];
type UpdateModelFn = ReturnType<
	typeof useSettingsStore.getState
>["updateModelSettings"];
type ModelPatch = Parameters<UpdateModelFn>[0];

/**
 * Pure decision for the main slot: returns the ``{ model, backend }`` patch
 * to apply, or ``null`` when no fallback is warranted. Extracted from the
 * effect so the reactive body is a flat "compute patch → maybe apply" and
 * the guard chain (cloud id / not-stale / no pick / same pick / no backend)
 * is testable without a render.
 *
 * The backend MUST travel with the model — ``updateModelSettings`` rejects a
 * model-only patch (see the typed ``ModelPatch``). This was the original
 * drift site: the fallback used to write ``{ model: "tiny" }`` while leaving
 * ``backend`` at whatever the previous model used. Disk saved a mismatched
 * pair, every subsequent boot loaded the wrong engine for the right model.
 */
function resolveMainPatch(
	currentMainModel: string | undefined,
	catalogModels: CatalogModels,
	statesById: StatesById,
	statesLoaded: boolean,
): ModelPatch | null {
	if (providerOf(currentMainModel ?? "") !== null) {
		return null;
	}
	if (catalogModels.length === 0 || !statesLoaded) {
		return null;
	}
	const current = catalogModels.find((m) => m.id === currentMainModel);
	const currentCached =
		current !== undefined &&
		isVisibleSttModel(current) &&
		statesById[current.id]?.cache.state === "cached";
	if (currentCached) {
		return null;
	}
	if (
		current !== undefined &&
		!needsModelFallback(currentMainModel, catalogModels)
	) {
		const cachedReplacement = pickCachedSttModel(
			catalogModels,
			statesById,
			isVisibleSttModel,
		);
		if (!cachedReplacement || cachedReplacement === currentMainModel) {
			return null;
		}
		const replacementEntry = catalogModels.find(
			(m) => m.id === cachedReplacement,
		);
		if (!replacementEntry?.backend) {
			return null;
		}
		return { model: cachedReplacement, backend: replacementEntry.backend };
	}
	const next = pickCachedSttModel(catalogModels, statesById, isVisibleSttModel);
	if (!next || next === currentMainModel) {
		return null;
	}
	const fallbackEntry = catalogModels.find((m) => m.id === next);
	if (!fallbackEntry?.backend) {
		return null;
	}
	return { model: next, backend: fallbackEntry.backend };
}

/**
 * Pure decision for the realtime slot, narrowed to native-streaming entries.
 * Returns the ``{ realtimeModel }`` patch to apply, or ``null``.
 */
function resolveRealtimePatch(
	currentRealtimeModel: string | undefined,
	currentMainModel: string | undefined,
	catalogModels: CatalogModels,
	statesById: StatesById,
	statesLoaded: boolean,
	sourceLanguageSelection?: SourceLanguageSelection,
): ModelPatch | null {
	if (catalogModels.length === 0 || !statesLoaded) {
		return null;
	}
	const effectiveMain = resolveEffectiveMainModel(
		currentMainModel,
		catalogModels,
		statesById,
	);
	const compatibleRealtime = catalogModels.filter(
		(m) =>
			isSelectableRealtimeModel(m) &&
			(effectiveMain === null
				? modelSupportsSelectedSourceLanguages(
						m,
						sourceLanguageSelection,
						effectiveMain,
					)
				: modelsHaveLanguageOverlap(effectiveMain, m) &&
					modelSupportsSelectedSourceLanguages(
						m,
						sourceLanguageSelection,
						effectiveMain,
					)),
	);
	if (
		effectiveMain !== null &&
		isSelectableRealtimeModel(effectiveMain) &&
		modelSupportsSelectedSourceLanguages(
			effectiveMain,
			sourceLanguageSelection,
			effectiveMain,
		) &&
		statesById[effectiveMain.id]?.cache.state === "cached"
	) {
		return currentRealtimeModel === effectiveMain.id
			? null
			: { realtimeModel: effectiveMain.id };
	}
	const currentRealtime = compatibleRealtime.find(
		(m) => m.id === currentRealtimeModel,
	);
	const currentRealtimeCached =
		currentRealtime !== undefined &&
		statesById[currentRealtime.id]?.cache.state === "cached";
	if (currentRealtimeCached) {
		return null;
	}
	const next = pickCachedSttModel(compatibleRealtime, statesById);
	if (!next) {
		return currentRealtimeModel ? { realtimeModel: "" } : null;
	}
	if (next === currentRealtimeModel) {
		return null;
	}
	return { realtimeModel: next };
}

function resolveEffectiveMainModel(
	currentMainModel: string | undefined,
	catalogModels: CatalogModels,
	statesById: StatesById,
): CatalogModels[number] | null {
	if (providerOf(currentMainModel ?? "") !== null) {
		return null;
	}
	const current = catalogModels.find((m) => m.id === currentMainModel);
	if (current && isVisibleSttModel(current)) {
		return current;
	}
	const fallbackId = pickDefaultSttModel(
		catalogModels,
		statesById,
		isVisibleSttModel,
	);
	return catalogModels.find((m) => m.id === fallbackId) ?? null;
}

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
	statesLoaded: boolean,
	currentMainModel: string | undefined,
	currentRealtimeModel: string | undefined,
	update: UpdateModelFn,
	sourceLanguageSelection?: SourceLanguageSelection,
): void {
	useEffect(() => {
		if (!catalogLoaded) {
			return;
		}
		const patch = resolveMainPatch(
			currentMainModel,
			catalogModels,
			statesById,
			statesLoaded,
		);
		if (patch) {
			update(patch);
		}
	}, [
		catalogLoaded,
		catalogModels,
		statesById,
		statesLoaded,
		currentMainModel,
		update,
	]);

	// Same guard for the realtime model, narrowed to native-streaming entries.
	useEffect(() => {
		if (!catalogLoaded) {
			return;
		}
		const patch = resolveRealtimePatch(
			currentRealtimeModel,
			currentMainModel,
			catalogModels,
			statesById,
			statesLoaded,
		);
		if (patch) {
			update(patch);
		}
	}, [
		catalogLoaded,
		catalogModels,
		statesById,
		statesLoaded,
		currentMainModel,
		currentRealtimeModel,
		sourceLanguageSelection,
		update,
	]);
}
