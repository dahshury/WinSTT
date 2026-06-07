"use client";

import type { OpenRouterEndpoint, OpenRouterModel } from "@/shared/api/models";
import { createModelSelection } from "@/shared/lib/openrouter-model-selection";
import {
	filterModelsForFallback,
	isEndpointExcluded,
	type ModelExclusionConfig,
} from "./model-exclusion";

export {
	applyCloseWith,
	type FilterMenuPopupSlot,
	isInsideMenuPopup,
	nodeMatchesPopupSelector,
	nodeRoleIsPopup,
	nodeSlotIsPopup,
	shouldInterceptClose,
	walkAncestors,
} from "./model-picker-close-guard";

export interface ScrollToMakerRequest {
	maker: string;
	modelId?: string;
	nonce: number;
}

export interface ParsedSelectionToken {
	modelId: string;
	providerSlug?: string | undefined;
}

export function applyExclusion(
	models: OpenRouterModel[],
	config: ModelExclusionConfig | undefined,
): OpenRouterModel[] {
	if (!config) {
		return models;
	}
	return filterModelsForFallback(models, config);
}

export function applyDisabledFilter(
	models: OpenRouterModel[],
	disabledIds: readonly string[] | undefined,
): OpenRouterModel[] {
	if (!disabledIds || disabledIds.length === 0) {
		return models;
	}
	const set = new Set(disabledIds);
	return models.filter((m) => !set.has(m.id));
}

export function applyModelFilters(
	models: OpenRouterModel[],
	exclusionConfig: ModelExclusionConfig | undefined,
	disabledModelIds: readonly string[] | undefined,
): OpenRouterModel[] {
	return applyDisabledFilter(
		applyExclusion(models, exclusionConfig),
		disabledModelIds,
	);
}

export function endpointMatchesProviderSlug(
	endpoint: OpenRouterEndpoint,
	slug: string,
): boolean {
	return endpoint.provider_name === slug || endpoint.tag === slug;
}

export function selectEndpointFromList(
	endpoints: OpenRouterEndpoint[],
	slug: string,
): OpenRouterEndpoint | null {
	return endpoints.find((e) => endpointMatchesProviderSlug(e, slug)) ?? null;
}

export function findEndpointForProviderSlug(
	model: OpenRouterModel | undefined,
	slug: string | undefined,
): OpenRouterEndpoint | null {
	if (!(model?.endpoints && slug)) {
		return null;
	}
	return selectEndpointFromList(model.endpoints, slug);
}

export function shouldBlockSelection(
	modelId: string | undefined,
	providerSlug: string | undefined,
	exclusionConfig: ModelExclusionConfig | undefined,
): boolean {
	if (!(exclusionConfig && modelId)) {
		return false;
	}
	return isEndpointExcluded(modelId, providerSlug, exclusionConfig);
}

export function resolveSelectionValue(
	modelId: string | undefined,
	providerSlug: string | undefined,
	defaultModelId: string | null,
): string {
	if (modelId) {
		return createModelSelection(modelId, providerSlug);
	}
	if (defaultModelId) {
		return createModelSelection(defaultModelId);
	}
	return "";
}

export function splitTokenAtSeparator(token: string): ParsedSelectionToken {
	const atIndex = token.lastIndexOf("@");
	if (atIndex === -1) {
		return { modelId: token };
	}
	const providerSlug = token.slice(atIndex + 1) || undefined;
	return { modelId: token.slice(0, atIndex), providerSlug };
}

export function parseSelectionToken(
	token: string | null,
): ParsedSelectionToken | null {
	if (typeof token !== "string" || token.length === 0) {
		return null;
	}
	return splitTokenAtSeparator(token);
}

export function buildScrollRequestForModel(
	prev: ScrollToMakerRequest | null,
	model: OpenRouterModel,
): ScrollToMakerRequest {
	return {
		maker: model.maker as string,
		modelId: model.id,
		nonce: (prev?.nonce ?? 0) + 1,
	};
}

export function applyToggleExpanded(
	prev: Set<string>,
	modelId: string,
	nextOpen?: boolean,
): Set<string> {
	const next = new Set(prev);
	const shouldOpen = nextOpen ?? !next.has(modelId);
	if (shouldOpen) {
		next.add(modelId);
	} else {
		next.delete(modelId);
	}
	return next;
}

export function buildScrollRequestForProvider(
	prev: ScrollToMakerRequest | null,
	provider: string,
): ScrollToMakerRequest {
	return {
		maker: provider,
		nonce: (prev?.nonce ?? 0) + 1,
	};
}
