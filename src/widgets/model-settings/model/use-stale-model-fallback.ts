import { useLayoutEffect } from "react";
import { providerOf } from "@/entities/cloud-stt-provider";
import { useConnectionStore } from "@/entities/connection";
import {
	DEFAULT_STT_MODEL_ID,
	isSelectableRealtimeModel,
	isSelectionCached,
	isVisibleSttModel,
	modelSupportsSelectedSourceLanguages,
	modelsHaveLanguageOverlap,
	pickCachedSttModel,
	pickDefaultSttModel,
	reconcileQuantForModel,
	type CatalogModels,
	type ModelStatesById as StatesById,
	type SourceLanguageSelection,
} from "@/entities/model-catalog";
import { getSettingsStoreState } from "@/entities/setting";

type UpdateModelFn = ReturnType<
	typeof getSettingsStoreState
>["updateModelSettings"];
type ModelPatch = Parameters<UpdateModelFn>[0];

function applyModelPatch(patch: ModelPatch): void {
	getSettingsStoreState().updateModelSettings(patch);
}

let applyModelPatchOverride: ((patch: ModelPatch) => void) | null = null;

export function _setStaleModelFallbackPatchApplierForTests(
	applier: ((patch: ModelPatch) => void) | null,
): void {
	applyModelPatchOverride = applier;
}

function applyResolvedPatch(patch: ModelPatch): void {
	(applyModelPatchOverride ?? applyModelPatch)(patch);
}

function cloudFallbackPatch(
	cloudFallbackModel: string | null,
	currentMainModel: string | undefined,
): ModelPatch | null {
	if (!cloudFallbackModel || cloudFallbackModel === currentMainModel) {
		return null;
	}
	return { model: cloudFallbackModel };
}

/**
 * A main-slot fallback patch that keeps the ``{ model, onnxQuantization }``
 * couple VALID. Moving the model alone can strand a precision the incoming
 * model doesn't publish (`int8` carried onto `tiny`), which the backend rejects
 * wholesale — dropping this patch AND every later save of the model section.
 * Mirrors the adoption path in ``useSyncActiveModel``.
 */
function mainFallbackPatch(
	nextModel: string,
	currentQuant: string,
	catalogModels: CatalogModels,
): ModelPatch {
	const quant = reconcileQuantForModel(nextModel, currentQuant, catalogModels);
	return quant === null
		? { model: nextModel }
		: { model: nextModel, onnxQuantization: quant };
}

/**
 * Pure decision for the main slot: returns the ``{ model }`` patch to apply,
 * or ``null`` when no fallback is warranted. Extracted from the effect so the
 * reactive body is a flat "compute patch → maybe apply" and the guard chain
 * (cloud id / loaded-at-runtime / not-stale / no pick / same pick / unknown
 * entry) is testable without a render.
 */
function resolveMainPatch(
	currentMainModel: string | undefined,
	currentQuant: string,
	catalogModels: CatalogModels,
	statesById: StatesById,
	statesLoaded: boolean,
	cloudFallbackModel: string | null,
	runtimeModel: string | null,
): ModelPatch | null {
	if (providerOf(currentMainModel ?? "") !== null) {
		return null;
	}
	if (!statesLoaded) {
		return null;
	}
	// NEVER fall back off the model the backend currently has LOADED. It is
	// demonstrably usable whatever the cache snapshot claims, and rewriting it
	// starts an infinite ping-pong with `useSyncActiveModel` — mounted in this
	// same window — which re-adopts the runtime model on every settings change:
	// fallback writes `tiny`, adoption writes the runtime model back, repeat
	// until React aborts with "Maximum update depth exceeded".
	if (runtimeModel !== null && runtimeModel === currentMainModel) {
		return null;
	}
	if (catalogModels.length === 0) {
		return cloudFallbackPatch(cloudFallbackModel, currentMainModel);
	}
	const current = catalogModels.find((m) => m.id === currentMainModel);
	const currentValid = current !== undefined && isVisibleSttModel(current);
	const currentCached =
		currentValid && isSelectionCached(statesById[current.id], currentQuant);
	if (currentCached) {
		return null;
	}
	// Fallbacks are DETERMINISTIC: they land on the factory default, never on
	// "whatever small model happens to be cached" (which once silently turned
	// the main slot into a Russian-only Vosk model).
	//   - A VALID selection that merely isn't cached is only ever rewritten to
	//     the CACHED default; without one, prefer the keyed cloud fallback and
	//     otherwise leave the user's pick alone (it can download on demand).
	//   - A STALE id (missing from the catalog) recovers to the default
	//     outright, cached or not.
	const next = currentValid
		? pickCachedSttModel(
				catalogModels,
				statesById,
				(m) => m.id === DEFAULT_STT_MODEL_ID && isVisibleSttModel(m),
			)
		: pickDefaultSttModel(catalogModels, statesById, isVisibleSttModel);
	if (!next) {
		return cloudFallbackPatch(cloudFallbackModel, currentMainModel);
	}
	if (next === currentMainModel) {
		return null;
	}
	return mainFallbackPatch(next, currentQuant, catalogModels);
}

/**
 * Pure decision for the realtime slot, narrowed to native-streaming entries.
 * Returns the ``{ realtimeModel }`` patch to apply, or ``null``.
 */
function resolveRealtimePatch(
	currentRealtimeModel: string | undefined,
	currentMainModel: string | undefined,
	currentQuant: string,
	catalogModels: CatalogModels,
	statesById: StatesById,
	statesLoaded: boolean,
	sourceLanguageSelection?: SourceLanguageSelection,
): ModelPatch | null {
	if (providerOf(currentMainModel ?? "") !== null) {
		return null;
	}
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
	// Cached-ness is judged at the SELECTED precision, not the model's flat
	// `cache` (= the AUTO recommendation's state). A main model downloaded at
	// the user's explicit `int8` but recommended at an uncached fp32 otherwise
	// reads "not cached" here, so the slot skipped the auto-reuse branch and
	// picked a different streaming model — which the panel's slot-lock effect
	// immediately snapped back to main, looping until React gave up.
	if (
		effectiveMain !== null &&
		isSelectableRealtimeModel(effectiveMain) &&
		modelSupportsSelectedSourceLanguages(
			effectiveMain,
			sourceLanguageSelection,
			effectiveMain,
		) &&
		isSelectionCached(statesById[effectiveMain.id], currentQuant)
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
		isSelectionCached(statesById[currentRealtime.id], currentQuant);
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
 * factory default (`DEFAULT_STT_MODEL_ID`, falling back to the smallest
 * cached model only when the default is ineligible) so the user always lands
 * somewhere deterministic. Skips
 * while the catalog is still loading so we don't false-positive every model
 * as missing during the boot race. Also skips when the active model is a
 * cloud `provider:*` id — those are never in the local catalog by design and
 * should not trigger a fallback.
 *
 * `currentQuant` is the persisted `onnxQuantization`: "is my selection
 * downloaded" must be asked of the precision the selection actually loads at,
 * and any fallback that moves the model must carry a precision that model
 * publishes.
 */
export function useStaleModelFallback(
	catalogLoaded: boolean,
	catalogModels: CatalogModels,
	statesById: StatesById,
	statesLoaded: boolean,
	currentMainModel: string | undefined,
	currentRealtimeModel: string | undefined,
	currentQuant: string,
	sourceLanguageSelection?: SourceLanguageSelection,
	cloudFallbackModel: string | null = null,
): void {
	// The model the backend reports as LOADED. Subscribed (not read via
	// getState) so the main effect re-evaluates when it arrives.
	const runtimeModel = useConnectionStore((s) => s.runtimeInfo?.model ?? null);

	useLayoutEffect(() => {
		if (!catalogLoaded) {
			return;
		}
		const patch = resolveMainPatch(
			currentMainModel,
			currentQuant,
			catalogModels,
			statesById,
			statesLoaded,
			cloudFallbackModel,
			runtimeModel,
		);
		if (patch) {
			applyResolvedPatch(patch);
		}
	}, [
		catalogLoaded,
		catalogModels,
		statesById,
		statesLoaded,
		currentMainModel,
		currentQuant,
		cloudFallbackModel,
		runtimeModel,
	]);

	// Same guard for the realtime model, narrowed to native-streaming entries.
	useLayoutEffect(() => {
		if (!catalogLoaded) {
			return;
		}
		const patch = resolveRealtimePatch(
			currentRealtimeModel,
			currentMainModel,
			currentQuant,
			catalogModels,
			statesById,
			statesLoaded,
			sourceLanguageSelection,
		);
		if (patch) {
			applyResolvedPatch(patch);
		}
	}, [
		catalogLoaded,
		catalogModels,
		statesById,
		statesLoaded,
		currentMainModel,
		currentRealtimeModel,
		currentQuant,
		sourceLanguageSelection,
	]);
}
