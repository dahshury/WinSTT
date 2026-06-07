import type { OpenRouterEndpoint, OpenRouterModel } from "@/shared/api/models";
import {
	getPricingTier,
	getUniqueEndpoints,
	getVariantClasses,
} from "../model-selector-display-utils";

const uniqueEndpointsCache = new WeakMap<OpenRouterModel, OpenRouterEndpoint[]>();
export function getCachedUniqueEndpoints(model: OpenRouterModel): OpenRouterEndpoint[] {
	const cached = uniqueEndpointsCache.get(model);
	if (cached) {
		return cached;
	}
	const fresh = getUniqueEndpoints(model.endpoints ?? []);
	uniqueEndpointsCache.set(model, fresh);
	return fresh;
}

export function hasModelEndpoints(model: OpenRouterModel): boolean {
	return !!(model.endpoints && model.endpoints.length > 0);
}

export function getEndpointProviderSlug(endpoint: OpenRouterEndpoint): string {
	return endpoint.tag || endpoint.provider_name;
}

export function findSelectedProvider(
	endpoints: OpenRouterEndpoint[],
	parsedProviderSlug: string | undefined
): OpenRouterEndpoint | null {
	if (!parsedProviderSlug) {
		return null;
	}
	return (
		endpoints.find((e) => e.provider_name === parsedProviderSlug || e.tag === parsedProviderSlug) ??
		null
	);
}

export interface ModelHeaderState {
	hasEndpoints: boolean;
	isProviderSelected: boolean;
	isSelected: boolean;
	pricingInfo: ReturnType<typeof getPricingTier> | null;
	selectedProvider: OpenRouterEndpoint | null;
	uniqueEndpoints: OpenRouterEndpoint[];
	variantClasses: ReturnType<typeof getVariantClasses> | null;
}

export interface SelectionFlags {
	isProviderSelected: boolean;
	isSelected: boolean;
}

export function computeSelectionFlags(
	modelId: string,
	parsedModelId: string | undefined,
	parsedProviderSlug: string | undefined
): SelectionFlags {
	const isModelMatch = parsedModelId === modelId;
	return {
		isSelected: isModelMatch && !parsedProviderSlug,
		isProviderSelected: isModelMatch && !!parsedProviderSlug,
	};
}

export function computeModelEndpoints(model: OpenRouterModel): {
	hasEndpoints: boolean;
	uniqueEndpoints: OpenRouterEndpoint[];
} {
	const hasEndpoints = hasModelEndpoints(model);
	const uniqueEndpoints = hasEndpoints ? getCachedUniqueEndpoints(model) : [];
	return { hasEndpoints, uniqueEndpoints };
}

export function computeVariantClasses(
	model: OpenRouterModel
): ReturnType<typeof getVariantClasses> | null {
	return model.variant ? getVariantClasses(model.variant) : null;
}

export function computeHeaderPricing(
	uniqueEndpoints: OpenRouterEndpoint[],
	hasProviders: boolean
): ReturnType<typeof getPricingTier> | null {
	if (hasProviders) {
		return null;
	}
	const firstEndpoint = uniqueEndpoints[0];
	return firstEndpoint ? getPricingTier(firstEndpoint.pricing) : null;
}

export function computeSelectedProvider(
	uniqueEndpoints: OpenRouterEndpoint[],
	flags: SelectionFlags,
	parsedProviderSlug: string | undefined
): OpenRouterEndpoint | null {
	return flags.isProviderSelected
		? findSelectedProvider(uniqueEndpoints, parsedProviderSlug)
		: null;
}

export function computeModelHeaderState(
	model: OpenRouterModel,
	parsedModelId: string | undefined,
	parsedProviderSlug: string | undefined,
	hasProviders: boolean
): ModelHeaderState {
	const { hasEndpoints, uniqueEndpoints } = computeModelEndpoints(model);
	const flags = computeSelectionFlags(model.id, parsedModelId, parsedProviderSlug);
	const selectedProvider = computeSelectedProvider(uniqueEndpoints, flags, parsedProviderSlug);
	return {
		hasEndpoints,
		uniqueEndpoints,
		isSelected: flags.isSelected,
		isProviderSelected: flags.isProviderSelected,
		selectedProvider,
		variantClasses: computeVariantClasses(model),
		pricingInfo: computeHeaderPricing(uniqueEndpoints, hasProviders),
	};
}

export function isProviderSelected(
	model: OpenRouterModel,
	providerSlug: string,
	parsedModelId: string | undefined,
	parsedProviderSlug: string | undefined
): boolean {
	return parsedModelId === model.id && parsedProviderSlug === providerSlug;
}

export function isFeaturedEndpointEligible(
	uniqueEndpoints: OpenRouterEndpoint[],
	hasEndpoints: boolean,
	hasProviders: boolean
): boolean {
	if (hasProviders) {
		return false;
	}
	return hasEndpoints && uniqueEndpoints.length > 0;
}

export function getFeaturedEndpoint(
	uniqueEndpoints: OpenRouterEndpoint[],
	hasEndpoints: boolean,
	hasProviders: boolean
): OpenRouterEndpoint | null {
	if (!isFeaturedEndpointEligible(uniqueEndpoints, hasEndpoints, hasProviders)) {
		return null;
	}
	return uniqueEndpoints[0] ?? null;
}
