import type { OpenRouterEndpoint, OpenRouterModel } from "@/shared/api/models";
import { collectFavorites, FAVORITES_GROUP_VALUE } from "../../core/favorites";
import type { getPricingTier } from "../model-selector-display-utils";
import { formatMaker } from "../model-selector-utils";
import { getProviderIconWithFallback } from "../provider-icons";
import { getCachedUniqueEndpoints } from "./header";

export function isPositiveNumber(value: number | null | undefined): value is number {
	return value != null && value > 0;
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

export function getEmptyStateLabel(hasActiveFilters: boolean): string {
	return hasActiveFilters ? "No models found" : "Unable to load models";
}

export function getEmptyStateBody(hasActiveFilters: boolean): string {
	return hasActiveFilters
		? "Try adjusting your filters to see more results."
		: "The OpenRouter servers may be down or you may have lost internet connection. Please check your connection and try again.";
}
