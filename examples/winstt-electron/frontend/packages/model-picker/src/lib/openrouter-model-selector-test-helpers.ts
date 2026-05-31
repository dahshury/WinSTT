"use client";

import type { OpenRouterEndpoint, OpenRouterModel } from "@/shared/api/models";
import { createModelSelection } from "@/shared/lib/openrouter-model-selection";
import {
	filterModelsForFallback,
	isEndpointExcluded,
	type ModelExclusionConfig,
} from "./model-exclusion";

const POPUP_ROLES: ReadonlySet<string> = new Set([
	"menu",
	"menuitem",
	"tooltip",
	// AlertDialog / Dialog popups portaled out of the combobox (e.g. the
	// STT picker's "Delete quantization" confirmation). Without these,
	// clicking the dialog's confirm button dismisses the whole picker via
	// Base UI's outside-press detection.
	"alertdialog",
	"dialog",
]);
/**
 * Union of every picker's filter-menu Popover.Popup ``data-slot`` value.
 * The literal union prevents typos at the producer side — any new picker
 * MUST extend this union before its filter popover will be recognised as
 * "inside a friendly popup" by ``isInsideMenuPopup``. Without the
 * extension, clicking a filter toggle while the picker is open trips
 * Base UI's outside-press detection and dismisses the whole selector.
 */
export type FilterMenuPopupSlot =
	| "model-filters-menu-content"
	| "ollama-sort-menu-content"
	| "stt-filters-menu-content";
const POPUP_SLOTS: ReadonlySet<FilterMenuPopupSlot> = new Set<FilterMenuPopupSlot>([
	"model-filters-menu-content",
	"ollama-sort-menu-content",
	"stt-filters-menu-content",
]);

export interface ScrollToMakerRequest {
	maker: string;
	modelId?: string;
	nonce: number;
}

export interface ParsedSelectionToken {
	modelId: string;
	providerSlug?: string | undefined;
}

function nodeRoleIsPopup(node: HTMLElement): boolean {
	const role = node.getAttribute("role");
	return role !== null && POPUP_ROLES.has(role);
}

function nodeSlotIsPopup(node: HTMLElement): boolean {
	const slot = node.dataset?.slot;
	return slot !== undefined && (POPUP_SLOTS as ReadonlySet<string>).has(slot);
}

function nodeMatchesPopupSelector(node: HTMLElement, ownPopup: HTMLElement | null): boolean {
	return node === ownPopup || nodeRoleIsPopup(node) || nodeSlotIsPopup(node);
}

function walkAncestors(start: HTMLElement | null): HTMLElement[] {
	const chain: HTMLElement[] = [];
	for (let cursor = start; cursor; cursor = cursor.parentElement) {
		chain.push(cursor);
	}
	return chain;
}

export function isInsideMenuPopup(
	target: HTMLElement | null,
	ownPopup: HTMLElement | null
): boolean {
	return walkAncestors(target).some((node) => nodeMatchesPopupSelector(node, ownPopup));
}

function applyExclusion(
	models: OpenRouterModel[],
	config: ModelExclusionConfig | undefined
): OpenRouterModel[] {
	if (!config) {
		return models;
	}
	return filterModelsForFallback(models, config);
}

function applyDisabledFilter(
	models: OpenRouterModel[],
	disabledIds: readonly string[] | undefined
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
	disabledModelIds: readonly string[] | undefined
): OpenRouterModel[] {
	return applyDisabledFilter(applyExclusion(models, exclusionConfig), disabledModelIds);
}

function endpointMatchesProviderSlug(endpoint: OpenRouterEndpoint, slug: string): boolean {
	return endpoint.provider_name === slug || endpoint.tag === slug;
}

function selectEndpointFromList(
	endpoints: OpenRouterEndpoint[],
	slug: string
): OpenRouterEndpoint | null {
	return endpoints.find((e) => endpointMatchesProviderSlug(e, slug)) ?? null;
}

function findEndpointForProviderSlug(
	model: OpenRouterModel | undefined,
	slug: string | undefined
): OpenRouterEndpoint | null {
	if (!(model?.endpoints && slug)) {
		return null;
	}
	return selectEndpointFromList(model.endpoints, slug);
}

export function shouldBlockSelection(
	modelId: string | undefined,
	providerSlug: string | undefined,
	exclusionConfig: ModelExclusionConfig | undefined
): boolean {
	if (!(exclusionConfig && modelId)) {
		return false;
	}
	return isEndpointExcluded(modelId, providerSlug, exclusionConfig);
}

export function resolveSelectionValue(
	modelId: string | undefined,
	providerSlug: string | undefined,
	defaultModelId: string | null
): string {
	if (modelId) {
		return createModelSelection(modelId, providerSlug);
	}
	if (defaultModelId) {
		return createModelSelection(defaultModelId);
	}
	return "";
}

function splitTokenAtSeparator(token: string): ParsedSelectionToken {
	const atIndex = token.lastIndexOf("@");
	if (atIndex === -1) {
		return { modelId: token };
	}
	const providerSlug = token.slice(atIndex + 1) || undefined;
	return { modelId: token.slice(0, atIndex), providerSlug };
}

export function parseSelectionToken(token: string | null): ParsedSelectionToken | null {
	if (typeof token !== "string" || token.length === 0) {
		return null;
	}
	return splitTokenAtSeparator(token);
}

export function buildScrollRequestForModel(
	prev: ScrollToMakerRequest | null,
	model: OpenRouterModel
): ScrollToMakerRequest {
	return {
		maker: model.maker as string,
		modelId: model.id,
		nonce: (prev?.nonce ?? 0) + 1,
	};
}

function shouldInterceptClose(
	reason: string | undefined,
	itemPressReason: string,
	isInsidePopup: boolean
): boolean {
	return reason !== itemPressReason && isInsidePopup;
}

export function applyCloseWith(
	reason: string | undefined,
	itemPressReason: string,
	isInsidePopup: boolean,
	setOpen: (open: boolean) => void
): boolean {
	if (shouldInterceptClose(reason, itemPressReason, isInsidePopup)) {
		return false;
	}
	setOpen(false);
	return true;
}

export function applyToggleExpanded(
	prev: Set<string>,
	modelId: string,
	nextOpen?: boolean
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
	provider: string
): ScrollToMakerRequest {
	return {
		maker: provider,
		nonce: (prev?.nonce ?? 0) + 1,
	};
}

export const __openrouter_model_selector_test_helpers__ = {
	nodeRoleIsPopup,
	nodeSlotIsPopup,
	nodeMatchesPopupSelector,
	walkAncestors,
	isInsideMenuPopup,
	applyExclusion,
	applyDisabledFilter,
	applyModelFilters,
	endpointMatchesProviderSlug,
	selectEndpointFromList,
	findEndpointForProviderSlug,
	shouldBlockSelection,
	resolveSelectionValue,
	splitTokenAtSeparator,
	parseSelectionToken,
	buildScrollRequestForModel,
	buildScrollRequestForProvider,
	applyToggleExpanded,
	shouldInterceptClose,
	applyCloseWith,
};
