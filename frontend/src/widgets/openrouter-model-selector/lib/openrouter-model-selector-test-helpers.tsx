import type { OpenRouterEndpoint, OpenRouterModel } from "@/shared/api/models";
import { createModelSelection } from "@/shared/lib/openrouter-model-selection";
import { Spinner } from "@/shared/ui/spinner";
import {
	filterModelsForFallback,
	isEndpointExcluded,
	type ModelExclusionConfig,
} from "./model-exclusion";

export const POPUP_ROLES: ReadonlySet<string> = new Set(["menu", "menuitem", "tooltip"]);
export const POPUP_SLOT = "model-filters-menu-content";

export interface ScrollToMakerRequest {
	maker: string;
	modelId?: string;
	nonce: number;
}

export interface ParsedSelectionToken {
	modelId: string;
	providerSlug?: string | undefined;
}

// --- Pure DOM-walking helpers (used by isInsideMenuPopup) ---

/** True when the element's role attribute marks it as a popup-style node. */
export function nodeRoleIsPopup(node: HTMLElement): boolean {
	const role = node.getAttribute("role");
	return role !== null && POPUP_ROLES.has(role);
}

/** True when the element's data-slot marks it as the filters menu content. */
export function nodeSlotIsPopup(node: HTMLElement): boolean {
	return node.dataset?.slot === POPUP_SLOT;
}

/**
 * True when the node is the combobox's own popup, has a popup role, or
 * carries the model-filters-menu data-slot.
 */
export function nodeMatchesPopupSelector(node: HTMLElement, ownPopup: HTMLElement | null): boolean {
	return node === ownPopup || nodeRoleIsPopup(node) || nodeSlotIsPopup(node);
}

/** Materializes the ancestor chain (including `start`) into an array. */
export function walkAncestors(start: HTMLElement | null): HTMLElement[] {
	const chain: HTMLElement[] = [];
	for (let cursor = start; cursor; cursor = cursor.parentElement) {
		chain.push(cursor);
	}
	return chain;
}

/**
 * If a click landed inside an open Base UI menu / submenu, the parent
 * combobox popup should stay open. Walks the click target's ancestors
 * looking for any popup-style attribute Base UI emits.
 */
export function isInsideMenuPopup(
	target: HTMLElement | null,
	ownPopup: HTMLElement | null
): boolean {
	return walkAncestors(target).some((node) => nodeMatchesPopupSelector(node, ownPopup));
}

// --- Pure model-list filtering helpers (used by filteredModels useMemo) ---

/** Apply the fallback-exclusion config (no-op when config is absent). */
export function applyExclusion(
	models: OpenRouterModel[],
	config: ModelExclusionConfig | undefined
): OpenRouterModel[] {
	if (!config) {
		return models;
	}
	return filterModelsForFallback(models, config);
}

/** Filter out any model whose id is in the disabled-id list. */
export function applyDisabledFilter(
	models: OpenRouterModel[],
	disabledIds: readonly string[] | undefined
): OpenRouterModel[] {
	if (!disabledIds || disabledIds.length === 0) {
		return models;
	}
	const set = new Set(disabledIds);
	return models.filter((m) => !set.has(m.id));
}

/** Compose exclusion + disabled-id filtering into a single pipeline call. */
export function applyModelFilters(
	models: OpenRouterModel[],
	exclusionConfig: ModelExclusionConfig | undefined,
	disabledModelIds: readonly string[] | undefined
): OpenRouterModel[] {
	return applyDisabledFilter(applyExclusion(models, exclusionConfig), disabledModelIds);
}

// --- Pure endpoint-resolution helpers (used by selectedEndpoint useMemo) ---

/** True when the endpoint's provider_name or tag matches the slug. */
export function endpointMatchesProviderSlug(endpoint: OpenRouterEndpoint, slug: string): boolean {
	return endpoint.provider_name === slug || endpoint.tag === slug;
}

/** Pick the first endpoint matching `slug`, or null when none match. */
export function selectEndpointFromList(
	endpoints: OpenRouterEndpoint[],
	slug: string
): OpenRouterEndpoint | null {
	return endpoints.find((e) => endpointMatchesProviderSlug(e, slug)) ?? null;
}

/** Resolve the active endpoint for a model + provider slug pair. */
export function findEndpointForProviderSlug(
	model: OpenRouterModel | undefined,
	slug: string | undefined
): OpenRouterEndpoint | null {
	if (!(model?.endpoints && slug)) {
		return null;
	}
	return selectEndpointFromList(model.endpoints, slug);
}

// --- Pure selection helpers (used by handleSelectModel / handleValueChange) ---

/** True when the (modelId, providerSlug) pair is excluded by the fallback config. */
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

/** Resolve the value to push to onChange given the chosen + default model ids. */
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

/**
 * Split a `modelId@providerSlug` token. Empty providerSlug becomes undefined
 * so callers don't pass empty strings into createModelSelection.
 */
export function splitTokenAtSeparator(token: string): ParsedSelectionToken {
	const atIndex = token.lastIndexOf("@");
	if (atIndex === -1) {
		return { modelId: token };
	}
	const providerSlug = token.slice(atIndex + 1) || undefined;
	return { modelId: token.slice(0, atIndex), providerSlug };
}

/** Parse Combobox.Root onValueChange string into a selection, or null when invalid. */
export function parseSelectionToken(token: string | null): ParsedSelectionToken | null {
	if (typeof token !== "string" || token.length === 0) {
		return null;
	}
	return splitTokenAtSeparator(token);
}

/** Build the next scroll-to-maker request preserving the prev nonce monotonic counter. */
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

/** Return true when a close event should be intercepted (popup click). */
export function shouldInterceptClose(
	reason: string | undefined,
	itemPressReason: string,
	isInsidePopup: boolean
): boolean {
	return reason !== itemPressReason && isInsidePopup;
}

/**
 * Applies the close-with-reason logic: calls setOpen(false) unless the event
 * is intercepted. Returns true when the popup was closed, false when intercepted.
 */
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

/** Apply the toggle-expand updater to a set of expanded model ids. */
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

/** Build a scroll request for a manually-clicked provider on the rail. */
export function buildScrollRequestForProvider(
	prev: ScrollToMakerRequest | null,
	provider: string
): ScrollToMakerRequest {
	return {
		maker: provider,
		nonce: (prev?.nonce ?? 0) + 1,
	};
}

/** Renders a spinner overlay on the search input when a search is pending. */
export function SearchPendingIndicator({ pending }: { pending: boolean }) {
	if (!pending) {
		return null;
	}
	return (
		<div className="pointer-events-none absolute end-10 top-1/2 -translate-y-1/2 text-foreground-muted">
			<Spinner className="size-4" />
		</div>
	);
}

/**
 * Test helpers for newly extracted pure functions. Not part of the public
 * runtime API — exported so unit tests can exercise the helpers without
 * mounting the component.
 */
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
	SearchPendingIndicator,
};
