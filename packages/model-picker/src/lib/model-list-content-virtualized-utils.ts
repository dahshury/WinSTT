import type { ScrollToIndexOpts } from "virtua";
import type { OpenRouterEndpoint, OpenRouterModel } from "@/shared/api/models";
import { cn } from "@/shared/lib/cn";
import { collectFavorites, FAVORITES_GROUP_VALUE } from "../core/favorites";
import {
	getPricingTier,
	getUniqueEndpoints,
	getVariantClasses,
} from "./model-selector-display-utils";
import { formatMaker } from "./model-selector-utils";
import { getProviderIconWithFallback } from "./provider-icons";

type ModelVariantKey = NonNullable<OpenRouterModel["variant"]>;

// fluidfunctionalism: the decorative top variant strip is redundant with the
// variant badge, so every variant now paints the SAME quiet neutral hairline
// instead of a 7-hue rainbow ribbon. Color is reserved for selection; the strip
// is just a faint structural seam at the card's top edge.
const NEUTRAL_VARIANT_HAIRLINE = "from-foreground/[0.10] via-foreground/[0.04]";
export const VARIANT_GRADIENT_MAP: Record<ModelVariantKey, string> = {
	free: NEUTRAL_VARIANT_HAIRLINE,
	nitro: NEUTRAL_VARIANT_HAIRLINE,
	thinking: NEUTRAL_VARIANT_HAIRLINE,
	extended: NEUTRAL_VARIANT_HAIRLINE,
	exacto: NEUTRAL_VARIANT_HAIRLINE,
	floor: NEUTRAL_VARIANT_HAIRLINE,
	online: NEUTRAL_VARIANT_HAIRLINE,
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
// Restrained selection accent — matches the canonical FF card-selected string
// (also used by the STT picker) so a selected OpenRouter model reads with the
// same warm Docker-blue wash + ring across both pickers.
const MODEL_CARD_SELECTED_CLASSES = cn(
	"border-accent/55 bg-accent/[0.09] shadow-surface-3 ring-1 ring-accent/25",
	"hover:border-accent/70 hover:bg-accent/[0.12]"
);

export function isAnyModelSelected(flags: SelectionFlags): boolean {
	return flags.isSelected || flags.isProviderSelected;
}

export function getModelCardClassName(flags: SelectionFlags): string {
	return cn(MODEL_CARD_BASE_CLASSES, isAnyModelSelected(flags) && MODEL_CARD_SELECTED_CLASSES);
}

const PROVIDER_CARD_BASE_CLASSES = cn(
	"group/provider relative flex h-full cursor-pointer flex-col gap-1 rounded-md p-2 ring-1 ring-divider transition-[color,background-color,box-shadow] duration-200",
	"hover:shadow-sm hover:ring-border"
);
const PROVIDER_CARD_SELECTED_CLASSES = "bg-accent/10 ring-1 ring-accent/40";

// `idleSurface` carries the substrate-relative surfaceBg/hover the caller computes
// from `useSurface()` (this helper can't call hooks) so each provider card reads
// as its OWN lifted surface instead of a flat token that blends into the popup bg.
export function getProviderCardClassName(isSelected: boolean, idleSurface = ""): string {
	return cn(PROVIDER_CARD_BASE_CLASSES, isSelected ? PROVIDER_CARD_SELECTED_CLASSES : idleSurface);
}

const SELECTION_DOT_BASE =
	"absolute end-1.5 top-1.5 size-2 rounded-full transition-[background-color,box-shadow] duration-200";
const SELECTION_DOT_SELECTED = "bg-accent shadow-[0_0_4px_var(--color-accent-glow-strong)]";
const SELECTION_DOT_IDLE = "bg-transparent ring-1 ring-border/50 group-hover/provider:ring-border";

export function getSelectionDotClassName(isSelected: boolean): string {
	return cn(SELECTION_DOT_BASE, isSelected ? SELECTION_DOT_SELECTED : SELECTION_DOT_IDLE);
}

export function getNonFreeBaseTextColor(_withForegroundFallback: boolean): string {
	// fluidfunctionalism: paid pricing is a single muted scale — the $/M numbers
	// carry the magnitude, so the text stays calmly muted regardless of context.
	return "text-foreground-muted";
}

export function getPricingBaseTextColor(
	pricingInfo: ReturnType<typeof getPricingTier>,
	withForegroundFallback: boolean
): string {
	if (pricingInfo.tier === "free") {
		// Muted emerald — a gentle "cheap" signal, not a glowing badge.
		return "text-emerald-300/80";
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
	// Idle hover is neutral (FF: accent is reserved for the active/expanded state
	// + selection + focus). The expanded state below carries the lone accent.
	"text-foreground-muted hover:bg-foreground/[0.08] hover:text-foreground active:bg-foreground/[0.10]"
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

/** Synthetic section id for the pinned "Favorites" group of starred models —
 *  matches the Favorites rail tile id so the scroll-spy + click-to-jump align,
 *  and is distinct from any real maker slug so maker jump/highlight is unaffected
 *  by the favorites group's REPEATED model rows. */
export const FAVORITES_SECTION_ID = FAVORITES_GROUP_VALUE;

export type VirtualizedItem =
	| {
			type: "model";
			model: OpenRouterModel;
			groupIndex: number;
			index: number;
			isExpanded: boolean;
			hasProviders: boolean;
			// Optional only so hand-built test fixtures stay valid; buildVirtualItems
			// always sets it (= maker slug, or FAVORITES_SECTION_ID).
			sectionId?: string | undefined;
	  }
	| {
			type: "providers";
			model: OpenRouterModel;
			endpoints: OpenRouterEndpoint[];
			isOpen: boolean;
			index: number;
			sectionId?: string | undefined;
	  }
	| {
			type: "header";
			sectionId: string;
			label: string;
			count: number;
			index: number;
	  };


/** Push a sticky section header item (the Favorites group or a maker group). */
function pushSectionHeader(
	items: VirtualizedItem[],
	index: number,
	sectionId: string,
	label: string,
	count: number
): void {
	items.push({ type: "header", sectionId, label, count, index });
}

/** Append every model (+ its providers row) of a group; returns the next index. */
function appendGroupModels(
	items: VirtualizedItem[],
	startIndex: number,
	models: OpenRouterModel[],
	groupIndex: number,
	expandedModels: Set<string>,
	sectionId: string
): number {
	let index = startIndex;
	for (const model of models) {
		index = appendModelEntries(items, index, model, groupIndex, expandedModels, sectionId);
	}
	return index;
}

export function buildVirtualItems(
	groupedModels: [string, OpenRouterModel[]][],
	expandedModels: Set<string>,
	isFavoriteModel?: (id: string) => boolean,
	// Per-maker section headers are only meaningful in the grouped view. While a
	// global sort is active the list is one flat `SORTED_GROUP_KEY` group, so the
	// caller passes `false` to avoid a spurious header beside the "Sorted" one.
	addSectionHeaders = true
): VirtualizedItem[] {
	const items: VirtualizedItem[] = [];
	let globalIndex = 0;
	// Favorited models are REPEATED in a "Favorites" group pinned to the top (the
	// STT/Ollama pattern) — they keep their normal per-maker row too, and carry
	// sectionId=FAVORITES_SECTION_ID so the maker scroll-spy never confuses them.
	if (isFavoriteModel) {
		// Shared dedup-walk (STT/TTS use the same): adapt the maker tuples to the
		// `{ items }` shape the generic collector expects.
		const favorites = collectFavorites(
			groupedModels.map(([, models]) => ({ items: models })),
			isFavoriteModel,
			(m) => m.id
		);
		if (favorites.length > 0) {
			pushSectionHeader(items, globalIndex, FAVORITES_SECTION_ID, "Favorites", favorites.length);
			globalIndex = appendGroupModels(
				items,
				globalIndex + 1,
				favorites,
				-1,
				expandedModels,
				FAVORITES_SECTION_ID
			);
		}
	}
	for (const [groupIndex, [maker, makerModels]] of groupedModels.entries()) {
		// One sticky maker header per group (grouped view only) — matches the STT
		// per-family header so the author is named once at the top of its group.
		if (addSectionHeaders) {
			pushSectionHeader(items, globalIndex, maker, formatMaker(maker), makerModels.length);
			globalIndex += 1;
		}
		globalIndex = appendGroupModels(
			items,
			globalIndex,
			makerModels,
			groupIndex,
			expandedModels,
			maker
		);
	}
	return items;
}

export function appendModelEntries(
	items: VirtualizedItem[],
	startIndex: number,
	model: OpenRouterModel,
	groupIndex: number,
	expandedModels: Set<string>,
	sectionId?: string
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
		sectionId,
	});
	nextIndex += 1;
	if (hasProviders) {
		items.push({
			type: "providers",
			model,
			endpoints: uniqueEndpoints,
			isOpen: isExpanded,
			index: nextIndex,
			sectionId,
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
	return items.findIndex((item) => item.sectionId === maker);
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
	if (item.type === "header") {
		return `header-${item.sectionId}`;
	}
	const prefix = item.type === "model" ? "model" : "providers";
	return `${prefix}-${item.model.id}`;
}

export function resolveActiveMaker(items: VirtualizedItem[], idx: number): string | null {
	return items[idx]?.sectionId ?? null;
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
	if (!scrollToIndex) {
		return lastNonce;
	}
	const targetIndex = findScrollTargetIndex(virtualItems, scrollToMakerRequest);
	if (targetIndex < 0) {
		return lastNonce;
	}
	scrollToIndex(targetIndex, { align: "start" } satisfies ScrollToIndexOpts);
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
