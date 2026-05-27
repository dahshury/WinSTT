import type { ScrollToIndexOpts } from "virtua";
import type { OpenRouterEndpoint, OpenRouterModel } from "@/shared/api/models";
import { cn } from "@/shared/lib/cn";
import {
	getPricingTier,
	getUniqueEndpoints,
	getVariantClasses,
} from "./model-selector-display-utils";
import { getProviderIconWithFallback } from "./provider-icons";

type ModelVariantKey = NonNullable<OpenRouterModel["variant"]>;

export const VARIANT_GRADIENT_MAP: Record<ModelVariantKey, string> = {
	free: "from-emerald-500/40 via-emerald-500/20",
	nitro: "from-amber-500/40 via-amber-500/20",
	thinking: "from-violet-500/40 via-violet-500/20",
	extended: "from-blue-500/40 via-blue-500/20",
	exacto: "from-rose-500/40 via-rose-500/20",
	floor: "from-cyan-500/40 via-cyan-500/20",
	online: "from-sky-500/40 via-sky-500/20",
};

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

export function isPositiveNumber(value: number | null | undefined): value is number {
	return value != null && value > 0;
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

const MODEL_CARD_BASE_CLASSES = cn(
	"group/card relative flex items-stretch rounded-md border p-0 transition-[color,background-color,border-color,box-shadow] duration-200",
	"border-border bg-surface-secondary/60",
	"hover:border-border-hover hover:bg-surface-hover/60 hover:shadow-md"
);
const MODEL_CARD_SELECTED_CLASSES = "border-accent/50 bg-accent/10 shadow-md ring-1 ring-accent/30";

export function isAnyModelSelected(flags: SelectionFlags): boolean {
	return flags.isSelected || flags.isProviderSelected;
}

export function getModelCardClassName(flags: SelectionFlags): string {
	return cn(MODEL_CARD_BASE_CLASSES, isAnyModelSelected(flags) && MODEL_CARD_SELECTED_CLASSES);
}

const PROVIDER_CARD_BASE_CLASSES = cn(
	"group/provider relative flex h-full cursor-pointer flex-col gap-1 rounded-md border p-2 transition-[color,background-color,border-color,box-shadow] duration-200",
	"border-border/50 bg-surface-secondary/40",
	"hover:border-border-hover hover:bg-surface-hover/70 hover:shadow-sm"
);
const PROVIDER_CARD_SELECTED_CLASSES = "border-accent/50 bg-accent/10 ring-1 ring-accent/30";

export function getProviderCardClassName(isSelected: boolean): string {
	return cn(PROVIDER_CARD_BASE_CLASSES, isSelected && PROVIDER_CARD_SELECTED_CLASSES);
}

const SELECTION_DOT_BASE =
	"absolute end-1.5 top-1.5 size-2 rounded-full transition-[background-color,box-shadow] duration-200";
const SELECTION_DOT_SELECTED = "bg-accent shadow-[0_0_4px_var(--color-accent-glow-strong)]";
const SELECTION_DOT_IDLE = "bg-transparent ring-1 ring-border/50 group-hover/provider:ring-border";

export function getSelectionDotClassName(isSelected: boolean): string {
	return cn(SELECTION_DOT_BASE, isSelected ? SELECTION_DOT_SELECTED : SELECTION_DOT_IDLE);
}

export function getNonFreeBaseTextColor(withForegroundFallback: boolean): string {
	return withForegroundFallback ? "text-foreground-secondary" : "text-foreground";
}

export function getPricingBaseTextColor(
	pricingInfo: ReturnType<typeof getPricingTier>,
	withForegroundFallback: boolean
): string {
	if (pricingInfo.tier === "free") {
		return "text-emerald-600 dark:text-emerald-400";
	}
	return getNonFreeBaseTextColor(withForegroundFallback);
}

export function getPricingExtraClass(
	pricingInfo: ReturnType<typeof getPricingTier>
): string | false {
	return pricingInfo.tier === "free" ? false : pricingInfo.className;
}

export function getPricingClassName(
	pricingInfo: ReturnType<typeof getPricingTier>,
	withForegroundFallback: boolean
): string {
	return cn(
		"flex cursor-default items-center font-semibold text-[11px] tabular-nums",
		getPricingBaseTextColor(pricingInfo, withForegroundFallback),
		getPricingExtraClass(pricingInfo)
	);
}

export function getPricingLabel(pricingInfo: ReturnType<typeof getPricingTier>): string {
	return pricingInfo.tier === "free" ? "Free" : pricingInfo.label;
}

export function getProvidersRowState(isOpen: boolean): "open" | "closed" {
	return isOpen ? "open" : "closed";
}

export function getProvidersGridTemplateRows(isOpen: boolean): string {
	return isOpen ? "1fr" : "0fr";
}

export function getExpandAriaLabel(isExpanded: boolean, providerCount: number): string {
	const verb = isExpanded ? "Hide" : "Show";
	return `${verb} ${providerCount} hosting providers`;
}

const EXPAND_BUTTON_BASE = cn(
	"flex w-11 shrink-0 flex-col items-center justify-center gap-0.5 self-stretch border-border border-s font-medium text-[10px] transition-colors duration-150",
	"text-foreground-muted hover:bg-accent/10 hover:text-accent active:bg-accent/15"
);

export function getExpandButtonClassName(isExpanded: boolean): string {
	return cn(EXPAND_BUTTON_BASE, isExpanded && "bg-accent/10 text-accent");
}

export function getChevronClassName(isExpanded: boolean): string {
	return cn("size-3 transition-transform duration-200", isExpanded && "rotate-90");
}

export function getProviderCountTooltip(providerCount: number): string {
	const verb = providerCount === 1 ? " hosts" : "s host";
	return `${providerCount} provider${verb} this model. Tap to compare pricing, latency, and features.`;
}

export interface SelectionState {
	kind: "selected" | "provider" | "none";
}

export function getSelectionState(
	isSelected: boolean,
	isProviderSelected: boolean
): SelectionState {
	if (isSelected) {
		return { kind: "selected" };
	}
	if (isProviderSelected) {
		return { kind: "provider" };
	}
	return { kind: "none" };
}

export function getSelectionProviderTooltip(selectedProviderName: string | undefined): string {
	return selectedProviderName ? `Provider: ${selectedProviderName}` : "Provider selected";
}

export type VirtualizedItem =
	| {
			type: "model";
			model: OpenRouterModel;
			groupIndex: number;
			index: number;
			isExpanded: boolean;
			hasProviders: boolean;
	  }
	| {
			type: "providers";
			model: OpenRouterModel;
			endpoints: OpenRouterEndpoint[];
			isOpen: boolean;
			index: number;
	  };

export function buildVirtualItems(
	groupedModels: [string, OpenRouterModel[]][],
	expandedModels: Set<string>
): VirtualizedItem[] {
	const items: VirtualizedItem[] = [];
	let globalIndex = 0;
	for (const [groupIndex, [, makerModels]] of groupedModels.entries()) {
		for (const model of makerModels) {
			globalIndex = appendModelEntries(items, globalIndex, model, groupIndex, expandedModels);
		}
	}
	return items;
}

export function appendModelEntries(
	items: VirtualizedItem[],
	startIndex: number,
	model: OpenRouterModel,
	groupIndex: number,
	expandedModels: Set<string>
): number {
	const isExpanded = expandedModels.has(model.id);
	const uniqueEndpoints = getCachedUniqueEndpoints(model);
	const hasProviders = uniqueEndpoints.length > 1;
	let nextIndex = startIndex;
	items.push({
		type: "model",
		model,
		groupIndex,
		index: nextIndex,
		isExpanded: isExpanded && hasProviders,
		hasProviders,
	});
	nextIndex += 1;
	if (hasProviders) {
		items.push({
			type: "providers",
			model,
			endpoints: uniqueEndpoints,
			isOpen: isExpanded,
			index: nextIndex,
		});
		nextIndex += 1;
	}
	return nextIndex;
}

interface ItemSizeHandle {
	getItemOffset: (index: number) => number;
	getItemSize: (index: number) => number;
}

export function findActiveVirtualIndex(
	handle: ItemSizeHandle,
	itemCount: number,
	offset: number
): number {
	const threshold = offset + 1;
	for (let i = 0; i < itemCount; i++) {
		const start = handle.getItemOffset(i);
		const size = handle.getItemSize(i);
		if (start + size > threshold) {
			return i;
		}
	}
	return itemCount - 1;
}

export function findIndexByModelId(items: VirtualizedItem[], modelId: string | undefined): number {
	if (!modelId) {
		return -1;
	}
	return items.findIndex((item) => item.type === "model" && item.model.id === modelId);
}

export function findIndexByMaker(items: VirtualizedItem[], maker: string): number {
	return items.findIndex((item) => item.type === "model" && item.model.maker === maker);
}

export interface ScrollRequest {
	maker: string;
	modelId?: string | undefined;
	nonce: number;
}

export function findScrollTargetIndex(items: VirtualizedItem[], request: ScrollRequest): number {
	const byId = findIndexByModelId(items, request.modelId);
	if (byId >= 0) {
		return byId;
	}
	return findIndexByMaker(items, request.maker);
}

export function isProviderSelected(
	model: OpenRouterModel,
	providerSlug: string,
	parsedModelId: string | undefined,
	parsedProviderSlug: string | undefined
): boolean {
	return parsedModelId === model.id && parsedProviderSlug === providerSlug;
}

export function resolveMakerIconSrc(maker: string | undefined): string | null {
	if (!maker) {
		return null;
	}
	return getProviderIconWithFallback(maker) ?? null;
}

export function shouldShowStatsRow(
	contextLength: number | null | undefined,
	maxOut: number | null | undefined
): boolean {
	return isPositiveNumber(contextLength) || isPositiveNumber(maxOut);
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

export function shouldRenderInlineMeta(
	contextLength: number | null | undefined,
	pricingInfo: ReturnType<typeof getPricingTier> | null,
	featuredEndpoint: OpenRouterEndpoint | null,
	modalities?: readonly string[] | undefined
): boolean {
	return (
		isPositiveNumber(contextLength) ||
		!!pricingInfo ||
		!!featuredEndpoint ||
		(modalities?.length ?? 0) > 0
	);
}

export function getRowKey(item: VirtualizedItem): string {
	const prefix = item.type === "model" ? "model" : "providers";
	return `${prefix}-${item.model.id}`;
}

export function resolveActiveMaker(items: VirtualizedItem[], idx: number): string | null {
	return items[idx]?.model.maker ?? null;
}

export function shouldNotifyMaker(nextMaker: string | null, lastMaker: string | null): boolean {
	return nextMaker !== lastMaker;
}

export function isNewScrollNonce(lastNonce: number | null, nonce: number): boolean {
	return lastNonce !== nonce;
}

export function applyVirtualScrollMakerUpdate(
	handle: { getItemOffset: (i: number) => number; getItemSize: (i: number) => number } | null,
	virtualItems: VirtualizedItem[],
	offset: number,
	lastNotifiedMaker: string | null,
	onActiveMakerChange: ((maker: string | null) => void) | undefined
): string | null {
	if (!handle || virtualItems.length === 0) {
		return lastNotifiedMaker;
	}
	const activeIdx = findActiveVirtualIndex(handle, virtualItems.length, offset);
	const nextMaker = resolveActiveMaker(virtualItems, activeIdx);
	if (shouldNotifyMaker(nextMaker, lastNotifiedMaker)) {
		onActiveMakerChange?.(nextMaker);
		return nextMaker;
	}
	return lastNotifiedMaker;
}

export function applyScrollToMakerRequest(
	scrollToMakerRequest: ScrollRequest | null | undefined,
	lastNonce: number | null,
	virtualItems: VirtualizedItem[],
	scrollToIndex: ((index: number, opts?: ScrollToIndexOpts) => void) | undefined
): number | null {
	if (!scrollToMakerRequest) {
		return lastNonce;
	}
	if (!isNewScrollNonce(lastNonce, scrollToMakerRequest.nonce)) {
		return lastNonce;
	}
	const targetIndex = findScrollTargetIndex(virtualItems, scrollToMakerRequest);
	if (targetIndex >= 0) {
		scrollToIndex?.(targetIndex, { align: "start" } satisfies ScrollToIndexOpts);
	}
	return scrollToMakerRequest.nonce;
}

export function getEmptyStateLabel(hasActiveFilters: boolean): string {
	return hasActiveFilters ? "No models found" : "Unable to load models";
}

export function getEmptyStateBody(hasActiveFilters: boolean): string {
	return hasActiveFilters
		? "Try adjusting your filters to see more results."
		: "The OpenRouter servers may be down or you may have lost internet connection. Please check your connection and try again.";
}

export type { ModelVariantKey };
