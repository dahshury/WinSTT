/**
 * Utilities for excluding models from a fallback selector based on the
 * primary model selection. Ported 1:1 from the event_manager project.
 *
 * Rules:
 *   1. Same model + same provider = excluded (exact match)
 *   2. Same model + no provider in primary = entire model excluded (all providers)
 *   3. Same model + different provider = allowed
 *   4. Both "auto" = caller must validate (not handled here)
 */

import type { OpenRouterModel } from "@/shared/api/models";
import {
	type ParsedModelSelection,
	parseModelSelection,
} from "@/shared/lib/openrouter-model-selection";

/** The model ID for OpenRouter Auto. */
const OPENROUTER_AUTO_MODEL_ID = "openrouter/auto";

/** Auto can be represented as either empty string `""` or `"openrouter/auto"`. */
function isAutoModel(value: string | undefined | null): boolean {
	if (!value || value.trim() === "") {
		return true;
	}
	return parseModelSelection(value).modelId === OPENROUTER_AUTO_MODEL_ID;
}

export interface ModelExclusionConfig {
	/** If true, exclude the entire model regardless of provider. */
	excludeAllProviders: boolean;
	/** The model ID to exclude (if provider specified, only that combo is excluded). */
	excludedModelId: string | undefined;
	/** The specific provider to exclude (only applicable if excludeAllProviders is false). */
	excludedProviderSlug: string | undefined;
}

const NO_EXCLUSION: ModelExclusionConfig = {
	excludedModelId: undefined,
	excludeAllProviders: false,
	excludedProviderSlug: undefined,
};

function buildExclusionFromParsed(
	parsed: ParsedModelSelection,
): ModelExclusionConfig {
	return parsed.modelId
		? {
				excludedModelId: parsed.modelId,
				excludeAllProviders: !parsed.providerSlug,
				excludedProviderSlug: parsed.providerSlug,
			}
		: NO_EXCLUSION;
}

// Provider-side exclusion check shared by isFallbackExcluded and
// isEndpointExcluded. Assumes the modelId match has already been confirmed.
function isProviderExcluded(
	providerSlug: string | undefined,
	config: ModelExclusionConfig,
): boolean {
	return (
		config.excludeAllProviders ||
		!providerSlug ||
		providerSlug === config.excludedProviderSlug
	);
}

/**
 * Compute exclusion config based on the primary model selection.
 * @param primaryValue Encoded as `"modelId"` or `"modelId@providerSlug"`.
 */
export function computeModelExclusionConfig(
	primaryValue: string | undefined | null,
): ModelExclusionConfig {
	// Combine the null/undefined check with isAutoModel so TS narrows
	// `primaryValue` to a definite string after the guard. This removes the
	// previously-required `?? ""` fallback (which was unreachable in
	// practice — isAutoModel already short-circuits for null/undefined).
	if (!primaryValue || isAutoModel(primaryValue)) {
		return NO_EXCLUSION;
	}
	return buildExclusionFromParsed(parseModelSelection(primaryValue));
}

/** True when the fallback selection conflicts with the primary. */
export function isFallbackExcluded(
	fallbackValue: string | undefined | null,
	exclusionConfig: ModelExclusionConfig,
): boolean {
	// Empty/null/undefined fallback → not excluded. Handling this explicitly
	// (instead of routing through `parseModelSelection(fallbackValue ?? "")`)
	// removes the dead `??` fallback branch and lets TS narrow `fallbackValue`
	// to `string` for the remaining logic.
	if (!fallbackValue) {
		return false;
	}
	const { modelId, providerSlug } = parseModelSelection(fallbackValue);
	return (
		modelId === exclusionConfig.excludedModelId &&
		isProviderExcluded(providerSlug, exclusionConfig)
	);
}

/**
 * Filter the model list to exclude entire models that conflict with the primary.
 * Provider-specific exclusions are enforced at endpoint-selection time, not here.
 */
export function filterModelsForFallback(
	models: OpenRouterModel[],
	exclusionConfig: ModelExclusionConfig,
): OpenRouterModel[] {
	// The `if (!excludedModelId)` early-return is redundant — the only
	// excludeAllProviders=true paths come from computeModelExclusionConfig,
	// which couples it to a defined excludedModelId. When excludeAllProviders
	// is false, we return `models` unchanged (preserving reference identity).
	if (exclusionConfig.excludeAllProviders) {
		return models.filter((m) => m.id !== exclusionConfig.excludedModelId);
	}
	return models;
}

/**
 * True when a specific (model, provider) combo conflicts with the primary.
 * Used at selection time to block excluded endpoints.
 */
export function isEndpointExcluded(
	modelId: string,
	providerSlug: string | undefined,
	exclusionConfig: ModelExclusionConfig,
): boolean {
	// Same simplification as isFallbackExcluded — the `!excludedModelId`
	// early-return is redundant because `string !== undefined` is the
	// same answer as the early-return path produces.
	return (
		modelId === exclusionConfig.excludedModelId &&
		isProviderExcluded(providerSlug, exclusionConfig)
	);
}
