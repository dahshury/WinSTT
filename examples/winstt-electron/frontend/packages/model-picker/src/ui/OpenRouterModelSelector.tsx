"use client";

import { StarIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRef, useState } from "react";
import type { OpenRouterModel } from "@/shared/api/models";
import { parseModelSelection } from "@/shared/lib/openrouter-model-selection";
import { GroupRail, type GroupRailItem, RailIconChip } from "../core/GroupRail";
import { useFavoriteSet } from "../core/use-favorite-set";
import { ModelPicker } from "../core/ModelPicker";
import { isReasoningModel } from "../lib/model-selector-display-utils";
import { formatMaker } from "../lib/model-selector-utils";
import type { ModelVariant } from "../lib/model-variant-utils";
import {
	applyCloseWith,
	applyModelFilters,
	applyToggleExpanded,
	buildScrollRequestForModel,
	buildScrollRequestForProvider,
	isInsideMenuPopup,
	parseSelectionToken,
	resolveSelectionValue,
	type ScrollToMakerRequest,
	shouldBlockSelection,
} from "../lib/openrouter-model-selector-test-helpers";
import type { FilterableParameter } from "../lib/openrouter-provider-utils";
import { OPENROUTER_SORT_HEADER_LABEL, type OpenRouterSortValue } from "../lib/openrouter-sort";
import { FAVORITES_SECTION_ID } from "../lib/model-list-content-virtualized-utils";
import { publicAsset } from "../lib/public-asset";
import { getProviderIcon } from "../lib/provider-icons";
import { useModelSelectorClickTracking } from "../lib/use-model-selector-click-tracking";
import { useModelSelectorFilters } from "../lib/use-model-selector-filters";
import type { OpenRouterModelSelectorProps } from "../model/openrouter-model-selector.types";
import { ActiveFiltersBar } from "./ActiveFiltersBar";
import { ModelFiltersMenu } from "./ModelFiltersMenu";
import { ModelListContentVirtualized } from "./ModelListContentVirtualized";
import { ModelSelectorTrigger } from "./ModelSelectorTrigger";
import { ReasoningControls } from "./ReasoningControls";

const DEFAULT_PLACEHOLDER = "Select a model";
const DEFAULT_LABEL = "Model";
const ITEM_PRESS_REASON = "item-press";

function useModelSelectorState() {
	const [open, setOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedMakers, setSelectedMakers] = useState<string[]>([]);
	const [selectedVariant, setSelectedVariant] = useState<ModelVariant | "none" | null>(null);
	const [selectedEndpointProvider, setSelectedEndpointProvider] = useState<string | null>(null);
	const [selectedParameters, setSelectedParameters] = useState<FilterableParameter[]>([]);
	const [sortKey, setSortKey] = useState<OpenRouterSortValue>(null);
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
		sortKey,
		setSortKey,
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
	onOpen,
	disabled = false,
	isLoading = false,
	placeholder = DEFAULT_PLACEHOLDER,
	label = DEFAULT_LABEL,
	description,
	exclusionConfig,
	disabledModelIds,
	fallback: _fallback = false,
	disabledReason: _disabledReason,
	maxOutputTokens,
	onMaxOutputTokensChange,
	onReasoningEffortChange,
	onVerbosityChange,
	reasoningEffort,
	verbosity,
}: OpenRouterModelSelectorProps) {
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
		sortKey,
		setSortKey,
		expandedModels,
		setExpandedModels,
		activeProvider,
		setActiveProvider,
		scrollToMakerRequest,
		setScrollToMakerRequest,
	} = useModelSelectorState();
	const lastClickTargetRef = useModelSelectorClickTracking();
	// Per-MODEL favorites (the amber card star), alongside the per-MAKER `favorites`
	// from useModelSelectorState (the rail). Mirrors the STT / Ollama model-favorite
	// gesture so the star reads identically across every picker.
	const { isFavorite: isFavoriteModel, toggleFavorite: toggleModelFavorite } = useFavoriteSet(
		"winstt:openrouter-favorite-models"
	);
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
		sortKey,
		isOpen: open,
	});

	const railProviders = groupedModelsAll.map(([maker]) => maker);

	const { modelId: parsedModelId, providerSlug: parsedProviderSlug } = parseModelSelection(value);
	const selectedModel = filteredModels.find((m) => m.id === parsedModelId);

	const clearFilters = () => {
		setSelectedMakers([]);
		setSearchQuery("");
		setSelectedVariant(null);
		setSelectedEndpointProvider(null);
		setSelectedParameters([]);
		setSortKey(null);
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
		onOpen?.();
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
			onSortChange={setSortKey}
			onToggleFavorite={toggleFavorite}
			onVariantSelect={handleVariantSelect}
			selectedEndpointProvider={selectedEndpointProvider}
			selectedMakers={selectedMakers}
			selectedParameters={selectedParameters}
			selectedVariant={selectedVariant}
			sortKey={sortKey}
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

	const comboboxFilter = () => true;

	const makerRailItems: GroupRailItem[] = railProviders.map((maker) => {
		const iconSrc = getProviderIcon(maker);
		return {
			id: maker,
			label: formatMaker(maker),
			badge: groupedModelsAll.find(([m]) => m === maker)?.[1].length,
			// Real brand logo when we have one, else a neutral letter chip
			// (GroupRail's FallbackInitial) — matching the STT rail, instead of
			// repeating the OpenRouter logo for every maker without an icon.
			icon: iconSrc ? (
				<img
					alt=""
					className="size-5 rounded-[3px] object-cover"
					height={20}
					src={publicAsset(iconSrc)}
					width={20}
				/>
			) : undefined,
		};
	});
	// Favorited MODELS get a pinned "Favorites" tile at the top of the rail that
	// jumps to the Favorites group in the list — the same model-favorites shortcut
	// STT / Ollama show. Distinct from the per-MAKER favorites partition below.
	const favoriteModelCount = groupedModelsAll.reduce(
		(sum, [, models]) => sum + models.filter((m) => isFavoriteModel(m.id)).length,
		0
	);
	const railItems: GroupRailItem[] =
		favoriteModelCount > 0
			? [
					{
						id: FAVORITES_SECTION_ID,
						label: "Favorites",
						pinned: true,
						badge: favoriteModelCount,
						icon: (
							<RailIconChip tone="favorite">
								<HugeiconsIcon className="size-3 fill-amber-400" icon={StarIcon} />
							</RailIconChip>
						),
					},
					...makerRailItems,
				]
			: makerRailItems;

	// A global sort flattens the makers into one column, so the maker rail (and
	// its scroll-spy) no longer maps to anything — hide it while sorting.
	const sidebar =
		sortKey === null ? (
			<GroupRail
				activeId={activeProvider}
				favorites={favorites}
				items={railItems}
				onClick={handleProviderRailClick}
				onToggleFavorite={toggleFavorite}
			/>
		) : undefined;

	const list = (
		<ModelListContentVirtualized
			expandedModels={expandedModels}
			groupedModels={groupedModelsAll}
			hasActiveFilters={hasActiveFilters}
			isFavoriteModel={isFavoriteModel}
			onActiveMakerChange={setActiveProvider}
			onSelectModel={handleSelectModel}
			onToggleModelExpanded={toggleModelExpanded}
			onToggleModelFavorite={toggleModelFavorite}
			parsedModelId={parsedModelId}
			parsedProviderSlug={parsedProviderSlug}
			scrollToMakerRequest={scrollToMakerRequest}
			sortHeaderLabel={sortKey === null ? undefined : OPENROUTER_SORT_HEADER_LABEL[sortKey]}
		/>
	);

	const reasoningBlock = (
		<ReasoningControls
			effectiveReasoningEffort={reasoningEffort ?? "medium"}
			effectiveVerbosity={verbosity ?? "medium"}
			isReasoningSelected={isReasoningModel(selectedModel)}
			maxOutputTokens={maxOutputTokens}
			onMaxOutputTokensChange={onMaxOutputTokensChange}
			onReasoningEffortChange={onReasoningEffortChange}
			onVerbosityChange={onVerbosityChange}
			supportsMaxTokens={selectedModel?.supported_parameters?.includes("max_tokens") ?? false}
			supportsVerbosity={selectedModel?.supported_parameters?.includes("verbosity") ?? false}
		/>
	);

	return (
		<div className="flex flex-col gap-2" data-slot="openrouter-model-selector">
			<label
				className="text-body-sm text-foreground-secondary"
				htmlFor="openrouter-model-selector-input"
			>
				{label}
			</label>
			<ModelPicker<string, string | null>
				activeFiltersSlot={activeFiltersBar}
				belowListSlot={
					<>
						{reasoningBlock}
						{description ? (
							<p className="text-foreground-muted text-xs-tight">{description}</p>
						) : null}
					</>
				}
				disabled={disabled}
				filter={comboboxFilter}
				filtersMenuSlot={filtersMenu}
				inputValue={searchQuery}
				isLoading={isLoading || isSearchPending}
				items={comboboxItems}
				list={list}
				onInputValueChange={handleSearchChange}
				onOpenChange={handleOpenChange}
				onValueChange={handleValueChange}
				open={open}
				popupHeightClass="h-[min(620px,var(--available-height))]"
				popupRef={handlePopupRef}
				popupWidthClass="w-[max(580px,var(--anchor-width))]"
				sidebarSlot={sidebar}
				trigger={
					<ModelSelectorTrigger
						disabled={disabled}
						isLoading={isLoading}
						open={open}
						parsedModelId={parsedModelId}
						placeholder={placeholder}
						selectedModel={selectedModel}
					/>
				}
			/>
		</div>
	);
}
