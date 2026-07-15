import type { OllamaModel, RecommendedOllamaModel } from "@/shared/api/models";
import { countActiveFlags } from "@/shared/ui/model-picker/core/lib/filter-state";

/**
 * The boolean catalog filters the Ollama picker exposes, ported from the
 * STT selector's
 * {@link import("@/features/select-local-stt-model/lib/filter-state").SttFilterState}.
 *
 * `installedOnly` is the Ollama analogue of STT's `cachedOnly` — it hides every
 * card that isn't already on disk (recommended, typed-tag, library) so the list
 * collapses to just the models the user has downloaded. `fitsHardwareOnly`
 * mirrors STT's filter of the same name. STT's `realtimeOnly` / `languages`
 * filters have no Ollama analogue and are intentionally dropped.
 */
export interface OllamaFilterState {
	fitsHardwareOnly: boolean;
	installedOnly: boolean;
	/** Spec-based "Suggested" filter (default ON): hide models with NO quant
	 *  that fits this machine's memory budgets (either-pool: VRAM budget OR
	 *  RAM budget — Ollama does CPU/partial offload). The predicate itself is
	 *  injected by the host via the selector's `suggestions` prop — when the
	 *  host hasn't wired one (onboarding, budgets not loaded yet) the flag is
	 *  inert. */
	suggestedOnly: boolean;
}

export const EMPTY_OLLAMA_FILTER_STATE: OllamaFilterState = {
	installedOnly: false,
	fitsHardwareOnly: false,
	suggestedOnly: true,
};

/** A persisted filter blob may predate the `suggestedOnly` flag. */
export type PersistedOllamaFilterState = Omit<
	OllamaFilterState,
	"suggestedOnly"
> &
	Partial<Pick<OllamaFilterState, "suggestedOnly">>;

/** Migration rule: persisted blobs written before the Suggested filter lack
 *  the key — a MISSING `suggestedOnly` defaults to `true` (ON for existing
 *  users), it is never treated as invalid state. */
export function normalizeOllamaFilterState(
	filters: PersistedOllamaFilterState,
): OllamaFilterState {
	return { suggestedOnly: true, ...filters };
}

/**
 * Boolean toggles in display order — keeps the count/active logic table-driven.
 * `suggestedOnly` is deliberately EXCLUDED from the count: it is ON by default
 * and surfaced by its own always-visible chip, so counting it would permanently
 * badge the filter trigger with "1 active" and keep "Clear all" lit in the
 * default state (same convention as the STT menu's `TOGGLE_KEYS`).
 */
const OLLAMA_COUNTED_FILTER_FLAGS = [
	"installedOnly",
	"fitsHardwareOnly",
] as const;

export type OllamaFilterFlag = keyof OllamaFilterState;

/** Active-filter count over a chosen flag subset (the menu passes only the
 *  flags it actually renders, so a stale `fitsHardwareOnly` from a host without
 *  system-fit data never inflates the trigger badge). `suggestedOnly` is never
 *  counted, even when rendered. */
export function ollamaActiveFilterCount(
	filters: OllamaFilterState,
	flags: readonly OllamaFilterFlag[] = OLLAMA_COUNTED_FILTER_FLAGS,
): number {
	return countActiveFlags(
		filters,
		flags.filter((flag) => flag !== "suggestedOnly"),
	);
}

/** Validates a persisted filter blob. A MISSING `suggestedOnly` is VALID (old
 *  blob, defaults to ON via {@link normalizeOllamaFilterState}); a present but
 *  non-boolean one is not. */
export function isOllamaFilterState(
	value: unknown,
): value is PersistedOllamaFilterState {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as Partial<OllamaFilterState>;
	return (
		typeof candidate.installedOnly === "boolean" &&
		typeof candidate.fitsHardwareOnly === "boolean" &&
		(candidate.suggestedOnly === undefined ||
			typeof candidate.suggestedOnly === "boolean")
	);
}

/**
 * Embedding models (e.g. `nomic-embed-text`, capabilities `["embedding"]`)
 * emit vectors, not text — they can't drive post-processing, so the LLM picker
 * hides them even when installed (Ollama or another tool often pulls one the
 * user never chose). A model is excluded only when it ADVERTISES `embedding`
 * WITHOUT a `completion` capability; models whose capabilities are unknown are
 * kept, so we never hide a legitimate generator on an older Ollama build.
 */
export function isEmbeddingOnlyOllamaModel(model: OllamaModel): boolean {
	const caps = model.capabilities;
	if (!caps || caps.length === 0) {
		return false;
	}
	return caps.includes("embedding") && !caps.includes("completion");
}

/** Minimal shape of the host's fit lookup — kept structural so this lib stays
 *  free of the UI-layer `OllamaFitInfo` type (FSD: a lib slice must not reach
 *  up into `ui`). The selector's `systemFit` is structurally compatible. */
export type OllamaFitLookup = (sizeBytes: number) => { fits: boolean };

/**
 * An installed model "fits" when the host can actually run it. Unknown / zero
 * on-disk sizes — or a missing lookup — are treated as a fit, the same lenient
 * rule STT applies to models with an unknown footprint, so the filter never
 * hides a model purely because we lack the data to judge it.
 */
export function installedModelFitsHardware(
	m: OllamaModel,
	getFit: OllamaFitLookup | undefined,
): boolean {
	const bytes = m.size ?? 0;
	if (!getFit || bytes <= 0) {
		return true;
	}
	return getFit(bytes).fits;
}

/** Recommended-model variant of {@link installedModelFitsHardware} —
 *  recommended cards carry their download size on `sizeBytes`. */
export function recommendedModelFitsHardware(
	m: RecommendedOllamaModel,
	getFit: OllamaFitLookup | undefined,
): boolean {
	if (!getFit || m.sizeBytes <= 0) {
		return true;
	}
	return getFit(m.sizeBytes).fits;
}

/**
 * Apply the active filters to the installed-model list. `installedOnly` is a
 * no-op here (installed models are, by definition, already downloaded);
 * `fitsHardwareOnly` prunes by the legacy VRAM-first warning-chip rule, and
 * the Suggested predicate (`suggested`, host-injected; `null`/absent = no
 * verdict, flag inert) hides models with NO quant fitting the memory budgets.
 * Returns the input reference untouched when no pruning filter is active
 * (avoids a per-render copy of the installed list).
 */
export function filterInstalledOllamaModels(
	models: readonly OllamaModel[],
	filters: OllamaFilterState,
	getFit: OllamaFitLookup | undefined,
	suggested?: ((m: OllamaModel) => boolean) | null,
): readonly OllamaModel[] {
	const useSuggested = filters.suggestedOnly && suggested != null;
	if (!(filters.fitsHardwareOnly || useSuggested)) {
		return models;
	}
	return models.filter(
		(m) =>
			(!filters.fitsHardwareOnly || installedModelFitsHardware(m, getFit)) &&
			(!useSuggested || suggested(m)),
	);
}

/**
 * Apply the active filters to the recommended-model list. `installedOnly`
 * empties it (recommended cards are by definition not installed); otherwise
 * `fitsHardwareOnly` and the host-injected Suggested predicate prune the ones
 * the host can't run (see {@link filterInstalledOllamaModels}).
 */
export function filterRecommendedOllamaModels(
	models: readonly RecommendedOllamaModel[],
	filters: OllamaFilterState,
	getFit: OllamaFitLookup | undefined,
	suggested?: ((m: RecommendedOllamaModel) => boolean) | null,
): readonly RecommendedOllamaModel[] {
	if (filters.installedOnly) {
		return [];
	}
	const useSuggested = filters.suggestedOnly && suggested != null;
	if (!(filters.fitsHardwareOnly || useSuggested)) {
		return models;
	}
	return models.filter(
		(m) =>
			(!filters.fitsHardwareOnly || recommendedModelFitsHardware(m, getFit)) &&
			(!useSuggested || suggested(m)),
	);
}
