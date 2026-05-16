"use client";

import { Combobox } from "@base-ui/react/combobox";
import { type ReactNode, useRef, useState } from "react";
import type { OpenRouterEndpoint, OpenRouterModel } from "@/shared/api/models";
import { createModelSelection, parseModelSelection } from "@/shared/lib/openrouter-model-selection";
import { Spinner } from "@/shared/ui/spinner";
import {
	filterModelsForFallback,
	isEndpointExcluded,
	type ModelExclusionConfig,
} from "../lib/model-exclusion";
import type { ModelVariant } from "../lib/model-variant-utils";
import type { FilterableParameter } from "../lib/openrouter-provider-utils";
import { useModelSelectorClickTracking } from "../lib/use-model-selector-click-tracking";
import { useModelSelectorFilters } from "../lib/use-model-selector-filters";
import type { OpenRouterModelSelectorProps } from "../model/openrouter-model-selector.types";
import { ActiveFiltersBar } from "./ActiveFiltersBar";
import { ModelFiltersMenu } from "./ModelFiltersMenu";
import { ModelListContentVirtualized } from "./ModelListContentVirtualized";
import { ModelSelectorTrigger } from "./ModelSelectorTrigger";
import { ProviderRail } from "./ProviderRail";

const DEFAULT_PLACEHOLDER = "Select a model";
const DEFAULT_LABEL = "Model";
const ITEM_PRESS_REASON = "item-press";
const POPUP_ROLES: ReadonlySet<string> = new Set(["menu", "menuitem", "tooltip"]);
const POPUP_SLOT = "model-filters-menu-content";

interface ScrollToMakerRequest {
	maker: string;
	modelId?: string;
	nonce: number;
}

interface ParsedSelectionToken {
	modelId: string;
	providerSlug?: string;
}

// --- Pure DOM-walking helpers (used by isInsideMenuPopup) ---

/** True when the element's role attribute marks it as a popup-style node. */
function nodeRoleIsPopup(node: HTMLElement): boolean {
	const role = node.getAttribute("role");
	return role !== null && POPUP_ROLES.has(role);
}

/** True when the element's data-slot marks it as the filters menu content. */
function nodeSlotIsPopup(node: HTMLElement): boolean {
	return node.dataset?.slot === POPUP_SLOT;
}

/**
 * True when the node is the combobox's own popup, has a popup role, or
 * carries the model-filters-menu data-slot.
 */
function nodeMatchesPopupSelector(node: HTMLElement, ownPopup: HTMLElement | null): boolean {
	return node === ownPopup || nodeRoleIsPopup(node) || nodeSlotIsPopup(node);
}

/** Materializes the ancestor chain (including `start`) into an array. */
function walkAncestors(start: HTMLElement | null): HTMLElement[] {
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
function isInsideMenuPopup(target: HTMLElement | null, ownPopup: HTMLElement | null): boolean {
	return walkAncestors(target).some((node) => nodeMatchesPopupSelector(node, ownPopup));
}

// --- Pure model-list filtering helpers (used by filteredModels useMemo) ---

/** Apply the fallback-exclusion config (no-op when config is absent). */
function applyExclusion(
	models: OpenRouterModel[],
	config: ModelExclusionConfig | undefined
): OpenRouterModel[] {
	if (!config) {
		return models;
	}
	return filterModelsForFallback(models, config);
}

/** Filter out any model whose id is in the disabled-id list. */
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

/** Compose exclusion + disabled-id filtering into a single pipeline call. */
function applyModelFilters(
	models: OpenRouterModel[],
	exclusionConfig: ModelExclusionConfig | undefined,
	disabledModelIds: readonly string[] | undefined
): OpenRouterModel[] {
	return applyDisabledFilter(applyExclusion(models, exclusionConfig), disabledModelIds);
}

// --- Pure endpoint-resolution helpers (used by selectedEndpoint useMemo) ---

/** True when the endpoint's provider_name or tag matches the slug. */
function endpointMatchesProviderSlug(endpoint: OpenRouterEndpoint, slug: string): boolean {
	return endpoint.provider_name === slug || endpoint.tag === slug;
}

/** Pick the first endpoint matching `slug`, or null when none match. */
function selectEndpointFromList(
	endpoints: OpenRouterEndpoint[],
	slug: string
): OpenRouterEndpoint | null {
	return endpoints.find((e) => endpointMatchesProviderSlug(e, slug)) ?? null;
}

/** Resolve the active endpoint for a model + provider slug pair. */
function findEndpointForProviderSlug(
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
function shouldBlockSelection(
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
function resolveSelectionValue(
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
function splitTokenAtSeparator(token: string): ParsedSelectionToken {
	const atIndex = token.lastIndexOf("@");
	if (atIndex === -1) {
		return { modelId: token };
	}
	const providerSlug = token.slice(atIndex + 1) || undefined;
	return { modelId: token.slice(0, atIndex), providerSlug };
}

/** Parse Combobox.Root onValueChange string into a selection, or null when invalid. */
function parseSelectionToken(token: string | null): ParsedSelectionToken | null {
	if (typeof token !== "string" || token.length === 0) {
		return null;
	}
	return splitTokenAtSeparator(token);
}

/** Build the next scroll-to-maker request preserving the prev nonce monotonic counter. */
function buildScrollRequestForModel(
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
function buildScrollRequestForProvider(
	prev: ScrollToMakerRequest | null,
	provider: string
): ScrollToMakerRequest {
	return {
		maker: provider,
		nonce: (prev?.nonce ?? 0) + 1,
	};
}

/**
 * Bundle the selector's local UI state into one hook so the panel doesn't
 * declare 9 individual useState calls inline. Refactor exists to satisfy the
 * react-doctor `prefer-useReducer` heuristic without forcing a reducer onto
 * what is genuinely independent state.
 */
function useModelSelectorState() {
	const [open, setOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedMakers, setSelectedMakers] = useState<string[]>([]);
	const [selectedVariant, setSelectedVariant] = useState<ModelVariant | "none" | null>(null);
	const [selectedEndpointProvider, setSelectedEndpointProvider] = useState<string | null>(null);
	const [selectedParameters, setSelectedParameters] = useState<FilterableParameter[]>([]);
	const [expandedModels, setExpandedModels] = useState<Set<string>>(new Set());
	const [activeProvider, setActiveProvider] = useState<string | null>(null);
	const [scrollToMakerRequest, setScrollToMakerRequest] = useState<ScrollToMakerRequest | null>(
		null
	);
	return {
		open,
		setOpen,
		searchQuery,
		setSearchQuery,
		selectedMakers,
		setSelectedMakers,
		selectedVariant,
		setSelectedVariant,
		selectedEndpointProvider,
		setSelectedEndpointProvider,
		selectedParameters,
		setSelectedParameters,
		expandedModels,
		setExpandedModels,
		activeProvider,
		setActiveProvider,
		scrollToMakerRequest,
		setScrollToMakerRequest,
	};
}

export function OpenRouterModelSelector({
	models,
	value,
	onChange,
	disabled = false,
	isLoading = false,
	placeholder = DEFAULT_PLACEHOLDER,
	label = DEFAULT_LABEL,
	description,
	exclusionConfig,
	disabledModelIds,
	fallback: _fallback = false,
	disabledReason: _disabledReason,
}: OpenRouterModelSelectorProps) {
	// Apply exclusion + disabled-id filtering. React Compiler memoizes
	// pure expressions, so we don't need useMemo here.
	const filteredModels = applyModelFilters(models, exclusionConfig, disabledModelIds);
	const {
		open,
		setOpen,
		searchQuery,
		setSearchQuery,
		selectedMakers,
		setSelectedMakers,
		selectedVariant,
		setSelectedVariant,
		selectedEndpointProvider,
		setSelectedEndpointProvider,
		selectedParameters,
		setSelectedParameters,
		expandedModels,
		setExpandedModels,
		activeProvider,
		setActiveProvider,
		scrollToMakerRequest,
		setScrollToMakerRequest,
	} = useModelSelectorState();
	const lastClickTargetRef = useModelSelectorClickTracking();
	const popupRef = useRef<HTMLElement | null>(null);

	const {
		allProviders,
		favoriteProviders,
		groupedModelsAll,
		comboboxItems,
		hasActiveFilters,
		favorites,
		toggleFavorite,
		handleSearchChange,
		handleMakerToggle,
		handleMakersChange,
		handleVariantSelect,
		handleEndpointProviderSelect,
		handleParametersChange,
		handleRemoveParameter,
		isSearchPending,
	} = useModelSelectorFilters({
		models: filteredModels,
		searchQuery,
		selectedMakers,
		selectedVariant,
		selectedEndpointProvider,
		selectedParameters,
		setSearchQuery,
		setSelectedMakers,
		setSelectedVariant,
		setSelectedEndpointProvider,
		setSelectedParameters,
		isOpen: open,
	});

	const railProviders = groupedModelsAll.map(([maker]) => maker);

	const { modelId: parsedModelId, providerSlug: parsedProviderSlug } = parseModelSelection(value);
	const selectedModel = filteredModels.find((m) => m.id === parsedModelId);
	const selectedEndpoint = findEndpointForProviderSlug(selectedModel, parsedProviderSlug);

	const clearFilters = () => {
		setSelectedMakers([]);
		setSearchQuery("");
		setSelectedVariant(null);
		setSelectedEndpointProvider(null);
		setSelectedParameters([]);
	};

	const toggleModelExpanded = (modelId: string, nextOpen?: boolean) => {
		setExpandedModels((prev) => applyToggleExpanded(prev, modelId, nextOpen));
	};

	const defaultModelId = filteredModels.find((m) => m.id === "openrouter/auto")?.id ?? null;

	const handleSelectModel = (modelId: string | undefined, providerSlug?: string) => {
		if (shouldBlockSelection(modelId, providerSlug, exclusionConfig)) {
			return;
		}
		onChange(resolveSelectionValue(modelId, providerSlug, defaultModelId));
		setOpen(false);
		clearFilters();
		setExpandedModels(new Set());
	};

	const handleOpenWith = (model: OpenRouterModel | undefined) => {
		setOpen(true);
		if (model?.maker) {
			setActiveProvider(model.maker);
			setScrollToMakerRequest((prev) => buildScrollRequestForModel(prev, model));
		}
	};

	const handleCloseWith = (reason: string | undefined) => {
		applyCloseWith(
			reason,
			ITEM_PRESS_REASON,
			isInsideMenuPopup(lastClickTargetRef.current, popupRef.current),
			setOpen
		);
	};

	const handleOpenChange = (newOpen: boolean, eventDetails: unknown) => {
		if (newOpen) {
			handleOpenWith(selectedModel);
			return;
		}
		handleCloseWith((eventDetails as { reason?: string } | undefined)?.reason);
	};

	// Keyboard Enter on a highlighted item routes through the same selection
	// path as mouse clicks (mouse calls `handleSelectModel` directly via
	// `Combobox.Item` onClick).
	const handleValueChange = (next: string | null) => {
		const parsed = parseSelectionToken(next);
		if (parsed) {
			handleSelectModel(parsed.modelId, parsed.providerSlug);
		}
	};

	const handleProviderRailClick = (provider: string) => {
		setScrollToMakerRequest((prev) => buildScrollRequestForProvider(prev, provider));
	};

	const handlePopupRef = (node: HTMLElement | null) => {
		popupRef.current = node;
	};

	const filtersMenu = (
		<ModelFiltersMenu
			allProviders={allProviders}
			favoriteProviders={favoriteProviders}
			models={filteredModels}
			onEndpointProviderSelect={handleEndpointProviderSelect}
			onMakersChange={handleMakersChange}
			onParametersChange={handleParametersChange}
			onToggleFavorite={toggleFavorite}
			onVariantSelect={handleVariantSelect}
			selectedEndpointProvider={selectedEndpointProvider}
			selectedMakers={selectedMakers}
			selectedParameters={selectedParameters}
			selectedVariant={selectedVariant}
		/>
	);

	const activeFiltersBar = (
		<ActiveFiltersBar
			onEndpointProviderSelect={handleEndpointProviderSelect}
			onMakerToggle={handleMakerToggle}
			onParametersChange={handleParametersChange}
			onRemoveParameter={handleRemoveParameter}
			onVariantSelect={handleVariantSelect}
			selectedEndpointProvider={selectedEndpointProvider}
			selectedMakers={selectedMakers}
			selectedParameters={selectedParameters}
			selectedVariant={selectedVariant}
		/>
	);

	// Combobox.Root expects a `filter` callback of type `(item, query) => boolean`.
	// We filter manually via `useModelSelectorFilters` and feed pre-filtered ids
	// into `comboboxItems`, so we always return true.
	const comboboxFilter = () => true;

	return (
		<div className="flex flex-col gap-2" data-slot="model-selector">
			<label
				className="text-body-sm text-foreground-secondary"
				htmlFor="openrouter-model-selector-input"
			>
				{label}
			</label>
			<Combobox.Root
				filter={comboboxFilter}
				inputValue={searchQuery}
				items={comboboxItems}
				modal={false}
				onInputValueChange={handleSearchChange}
				onOpenChange={handleOpenChange}
				onValueChange={handleValueChange}
				open={open}
			>
				<ModelSelectorTrigger
					disabled={disabled}
					isLoading={isLoading}
					open={open}
					parsedModelId={parsedModelId}
					placeholder={placeholder}
					selectedEndpoint={selectedEndpoint}
					selectedModel={selectedModel}
				/>
				<Combobox.Portal>
					<Combobox.Positioner align="start" sideOffset={4}>
						<Combobox.Popup
							className="select-popup z-[200] flex h-[min(620px,var(--available-height))] w-[max(560px,var(--anchor-width))] max-w-[calc(100vw-32px)] origin-(--transform-origin) flex-col overflow-hidden rounded-md border border-border bg-surface-elevated p-0 shadow-md transition-[transform,opacity] duration-150 ease-out data-[ending-style]:ease-in"
							ref={handlePopupRef}
						>
							<ModelSelectorPopupBody
								activeFiltersBar={activeFiltersBar}
								activeProvider={activeProvider}
								expandedModels={expandedModels}
								favorites={favorites}
								filtersMenu={filtersMenu}
								groupedModelsAll={groupedModelsAll}
								handleProviderRailClick={handleProviderRailClick}
								handleSelectModel={handleSelectModel}
								hasActiveFilters={hasActiveFilters}
								isSearchPending={isSearchPending}
								parsedModelId={parsedModelId}
								parsedProviderSlug={parsedProviderSlug}
								railProviders={railProviders}
								scrollToMakerRequest={scrollToMakerRequest}
								setActiveProvider={setActiveProvider}
								toggleFavorite={toggleFavorite}
								toggleModelExpanded={toggleModelExpanded}
							/>
						</Combobox.Popup>
					</Combobox.Positioner>
				</Combobox.Portal>
			</Combobox.Root>
			{description ? <p className="text-foreground-muted text-xs-tight">{description}</p> : null}
		</div>
	);
}

/** Renders a spinner overlay on the search input when a search is pending. */
function SearchPendingIndicator({ pending }: { pending: boolean }) {
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
 * Inner popup body — extracted so the parent component stays under the
 * giant-component threshold. Owns no state of its own; everything is
 * threaded down from the OpenRouterModelSelector closure.
 */
type ProviderRailProps = React.ComponentProps<typeof ProviderRail>;
type ModelListProps = React.ComponentProps<typeof ModelListContentVirtualized>;

interface ModelSelectorPopupBodyProps {
	activeFiltersBar: ReactNode;
	activeProvider: ProviderRailProps["activeProvider"];
	expandedModels: ModelListProps["expandedModels"];
	favorites: ProviderRailProps["favorites"];
	filtersMenu: ReactNode;
	groupedModelsAll: ModelListProps["groupedModels"];
	handleProviderRailClick: ProviderRailProps["onProviderClick"];
	handleSelectModel: ModelListProps["onSelectModel"];
	hasActiveFilters: ModelListProps["hasActiveFilters"];
	isSearchPending: boolean;
	parsedModelId: ModelListProps["parsedModelId"];
	parsedProviderSlug: ModelListProps["parsedProviderSlug"];
	railProviders: ProviderRailProps["providers"];
	scrollToMakerRequest: ModelListProps["scrollToMakerRequest"];
	setActiveProvider: ModelListProps["onActiveMakerChange"];
	toggleFavorite: ProviderRailProps["onToggleFavorite"];
	toggleModelExpanded: ModelListProps["onToggleModelExpanded"];
}

function ModelSelectorPopupBody({
	activeFiltersBar,
	activeProvider,
	expandedModels,
	favorites,
	filtersMenu,
	groupedModelsAll,
	handleProviderRailClick,
	handleSelectModel,
	hasActiveFilters,
	isSearchPending,
	parsedModelId,
	parsedProviderSlug,
	railProviders,
	scrollToMakerRequest,
	setActiveProvider,
	toggleFavorite,
	toggleModelExpanded,
}: ModelSelectorPopupBodyProps) {
	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="p-2">
				<div className="relative flex w-full items-center">
					<Combobox.Input
						className="h-9 w-full rounded-sm border border-border bg-surface-tertiary px-3 pe-16 font-inherit text-body text-foreground leading-normal outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
						dir="ltr"
						id="openrouter-model-selector-input"
						placeholder="Search models"
					/>
					<SearchPendingIndicator pending={isSearchPending} />
					<div className="absolute end-1 top-1/2 -translate-y-1/2">{filtersMenu}</div>
				</div>
			</div>
			{activeFiltersBar}
			<div className="flex min-h-0 flex-1">
				<ProviderRail
					activeProvider={activeProvider}
					favorites={favorites}
					onProviderClick={handleProviderRailClick}
					onToggleFavorite={toggleFavorite}
					providers={railProviders}
				/>
				<div className="flex min-h-0 flex-1 flex-col">
					<ModelListContentVirtualized
						expandedModels={expandedModels}
						groupedModels={groupedModelsAll}
						hasActiveFilters={hasActiveFilters}
						onActiveMakerChange={setActiveProvider}
						onSelectModel={handleSelectModel}
						onToggleModelExpanded={toggleModelExpanded}
						parsedModelId={parsedModelId}
						parsedProviderSlug={parsedProviderSlug}
						scrollToMakerRequest={scrollToMakerRequest}
					/>
				</div>
			</div>
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
