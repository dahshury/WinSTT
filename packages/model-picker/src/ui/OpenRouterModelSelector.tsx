"use client";

import { type MouseEvent, useEffect, useState } from "react";
import type { OpenRouterModel } from "@/shared/api/models";
import { parseModelSelection } from "@/shared/lib/openrouter-model-selection";
import {
	ALL_AUTHORS_RAIL_ID,
	buildAllAuthorsRailItem,
	GroupRail,
	type GroupRailItem,
} from "../core/GroupRail";
import { useFavoriteSet } from "../core/use-favorite-set";
import { ModelPicker } from "../core/ModelPicker";
import { isReasoningModel } from "../lib/model-selector-display-utils";
import { formatMaker } from "../lib/model-selector-utils";
import type { ModelVariant } from "../lib/model-variant-utils";
import { useModelPickerCloseGuard } from "../lib/model-picker-close-guard";
import {
	isStringArray,
	readPersistedSelectorState,
	writePersistedSelectorState,
} from "../lib/persisted-selector-state";
import {
	applyModelFilters,
	applyToggleExpanded,
	buildScrollRequestForModel,
	parseSelectionToken,
	resolveSelectionValue,
	type ScrollToMakerRequest,
	shouldBlockSelection,
} from "../lib/openrouter-model-selector-test-helpers";
import type { FilterableParameter } from "../lib/openrouter-provider-utils";
import {
	OPENROUTER_SORT_KEYS,
	OPENROUTER_SORT_HEADER_LABEL,
	type OpenRouterSortValue,
} from "../lib/openrouter-sort";
import { publicAsset } from "../lib/public-asset";
import { getProviderIcon } from "../lib/provider-icons";
import { useModelSelectorFilters } from "../lib/use-model-selector-filters";
import type { OpenRouterModelSelectorProps } from "../model/openrouter-model-selector.types";
import { ActiveFiltersBar } from "./ActiveFiltersBar";
import { ModelFiltersMenu } from "./ModelFiltersMenu";
import { ModelListContentVirtualized } from "./ModelListContentVirtualized";
import { ModelSelectorTrigger, TriggerButton } from "./ModelSelectorTrigger";
import { ReasoningControls } from "./ReasoningControls";

const DEFAULT_PLACEHOLDER = "Select a model";
const DEFAULT_LABEL = "Model";
const DEFAULT_OPENROUTER_SELECTOR_UI_STORAGE_KEY =
	"winstt:model-picker:openrouter-ui";
const DEFAULT_OPENROUTER_FAVORITE_MODELS_STORAGE_KEY =
	"winstt:openrouter-favorite-models";
const OPENROUTER_SORT_KEY_SET = new Set<string>(OPENROUTER_SORT_KEYS);

interface PersistedOpenRouterSelectorState {
	searchQuery: string;
	selectedEndpointProvider: string | null;
	selectedMakers: string[];
	selectedParameters: FilterableParameter[];
	selectedVariant: ModelVariant | "none" | null;
	sortKey: OpenRouterSortValue;
}

const DEFAULT_PERSISTED_OPENROUTER_SELECTOR_STATE: PersistedOpenRouterSelectorState =
	{
		searchQuery: "",
		selectedEndpointProvider: null,
		selectedMakers: [],
		selectedParameters: [],
		selectedVariant: null,
		sortKey: null,
	};

function isOpenRouterSortValue(value: unknown): value is OpenRouterSortValue {
	return (
		value === null ||
		(typeof value === "string" && OPENROUTER_SORT_KEY_SET.has(value))
	);
}

function isOpenRouterVariant(
	value: unknown,
): value is ModelVariant | "none" | null {
	return value === null || typeof value === "string";
}

function isPersistedOpenRouterSelectorState(
	value: unknown,
): value is PersistedOpenRouterSelectorState {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as Partial<PersistedOpenRouterSelectorState>;
	return (
		typeof candidate.searchQuery === "string" &&
		(candidate.selectedEndpointProvider === null ||
			typeof candidate.selectedEndpointProvider === "string") &&
		isStringArray(candidate.selectedMakers) &&
		isStringArray(candidate.selectedParameters) &&
		isOpenRouterVariant(candidate.selectedVariant) &&
		isOpenRouterSortValue(candidate.sortKey)
	);
}

function useModelSelectorState(storageKey: string) {
	const [open, setOpen] = useState(false);
	const [initialState] = useState(() =>
		readPersistedSelectorState(
			storageKey,
			isPersistedOpenRouterSelectorState,
			DEFAULT_PERSISTED_OPENROUTER_SELECTOR_STATE,
		),
	);
	const [searchQuery, setSearchQuery] = useState(initialState.searchQuery);
	const [selectedMakers, setSelectedMakers] = useState<string[]>(
		initialState.selectedMakers,
	);
	const [selectedVariant, setSelectedVariant] = useState<
		ModelVariant | "none" | null
	>(initialState.selectedVariant);
	const [selectedEndpointProvider, setSelectedEndpointProvider] = useState<
		string | null
	>(initialState.selectedEndpointProvider);
	const [selectedParameters, setSelectedParameters] = useState<
		FilterableParameter[]
	>(initialState.selectedParameters);
	const [sortKey, setSortKey] = useState<OpenRouterSortValue>(
		initialState.sortKey,
	);
	const [expandedModels, setExpandedModels] = useState<Set<string>>(new Set());
	const [scrollToMakerRequest, setScrollToMakerRequest] =
		useState<ScrollToMakerRequest | null>(null);
	useEffect(() => {
		writePersistedSelectorState(storageKey, {
			searchQuery,
			selectedEndpointProvider,
			selectedMakers,
			selectedParameters,
			selectedVariant,
			sortKey,
		});
	}, [
		storageKey,
		searchQuery,
		selectedEndpointProvider,
		selectedMakers,
		selectedParameters,
		selectedVariant,
		sortKey,
	]);
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
	inline = false,
	maxOutputTokens,
	onMaxOutputTokensChange,
	onOpenDetached,
	onReasoningEffortChange,
	onVerbosityChange,
	popupHeightClass = "h-[min(620px,var(--available-height))]",
	popupWidthClass = "w-[max(580px,var(--anchor-width))]",
	reasoningEffort,
	uiStorageKey = DEFAULT_OPENROUTER_SELECTOR_UI_STORAGE_KEY,
	favoriteModelsStorageKey = DEFAULT_OPENROUTER_FAVORITE_MODELS_STORAGE_KEY,
	favoriteProvidersStorageKey,
	verbosity,
}: OpenRouterModelSelectorProps) {
	const filteredModels = applyModelFilters(
		models,
		exclusionConfig,
		disabledModelIds,
	);
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
		scrollToMakerRequest,
		setScrollToMakerRequest,
	} = useModelSelectorState(uiStorageKey);
	const externalOpen = onOpenDetached != null;
	const effectiveOpen = inline ? true : open;
	// Per-MODEL favorites (the amber card star), alongside the per-MAKER `favorites`
	// from useModelSelectorState (the rail). Mirrors the STT / Ollama model-favorite
	// gesture so the star reads identically across every picker.
	const { isFavorite: isFavoriteModel, toggleFavorite: toggleModelFavorite } =
		useFavoriteSet(favoriteModelsStorageKey);

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
		isOpen: effectiveOpen,
		favoriteProvidersStorageKey,
	});

	const providerModelCounts = new Map<string, number>();
	for (const model of filteredModels) {
		if (model.maker) {
			providerModelCounts.set(
				model.maker,
				(providerModelCounts.get(model.maker) ?? 0) + 1,
			);
		}
	}

	const { modelId: parsedModelId, providerSlug: parsedProviderSlug } =
		parseModelSelection(value);
	const selectedModel = filteredModels.find((m) => m.id === parsedModelId);

	const toggleModelExpanded = (modelId: string, nextOpen?: boolean) => {
		setExpandedModels((prev) => applyToggleExpanded(prev, modelId, nextOpen));
	};

	const defaultModelId =
		filteredModels.find((m) => m.id === "openrouter/auto")?.id ?? null;

	const handleSelectModel = (
		modelId: string | undefined,
		providerSlug?: string,
	) => {
		if (shouldBlockSelection(modelId, providerSlug, exclusionConfig)) {
			return;
		}
		onChange(resolveSelectionValue(modelId, providerSlug, defaultModelId));
		setOpen(false);
		setExpandedModels(new Set());
	};

	const handleOpenWith = (model: OpenRouterModel | undefined) => {
		onOpen?.();
		if (model?.maker) {
			if (parsedProviderSlug) {
				setExpandedModels((prev) => applyToggleExpanded(prev, model.id, true));
			}
			setScrollToMakerRequest((prev) =>
				buildScrollRequestForModel(prev, model),
			);
		}
	};

	const openGuard = useModelPickerCloseGuard({
		setOpen,
		onOpen: () => handleOpenWith(selectedModel),
	});
	const handleOpenChange = externalOpen
		? () => undefined
		: openGuard.handleOpenChange;

	const handleValueChange = (next: string | null) => {
		const parsed = parseSelectionToken(next);
		if (parsed) {
			handleSelectModel(parsed.modelId, parsed.providerSlug);
		}
	};

	const handleProviderRailClick = (provider: string) => {
		setExpandedModels(new Set());
		if (provider === ALL_AUTHORS_RAIL_ID) {
			setSelectedMakers([]);
			return;
		}
		setSortKey(null);
		setSelectedMakers([provider]);
	};
	const handleSortChange = (next: OpenRouterSortValue) => {
		if (next !== null) {
			setSelectedMakers([]);
		}
		setSortKey(next);
	};

	const filtersMenu = (
		<ModelFiltersMenu
			allProviders={allProviders}
			favoriteProviders={favoriteProviders}
			models={filteredModels}
			onEndpointProviderSelect={handleEndpointProviderSelect}
			onMakersChange={handleMakersChange}
			onParametersChange={handleParametersChange}
			onSortChange={handleSortChange}
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
	const handleDetachedOpen = (event: MouseEvent<HTMLButtonElement>) => {
		onOpen?.();
		onOpenDetached?.(event.currentTarget.getBoundingClientRect());
	};

	const makerRailItems: GroupRailItem[] = allProviders.map((maker) => {
		const iconSrc = getProviderIcon(maker);
		return {
			id: maker,
			label: formatMaker(maker),
			badge: providerModelCounts.get(maker) ?? 0,
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
	const railItems: GroupRailItem[] = [
		buildAllAuthorsRailItem(filteredModels.length),
		...makerRailItems,
	];

	// All authors keeps the existing grouped/sorted OpenRouter view. A single
	// provider tile applies a maker-only filter; multi-maker filters from the menu
	// keep the rail visible without highlighting one author as active.
	const activeRailId =
		selectedMakers.length === 0
			? ALL_AUTHORS_RAIL_ID
			: selectedMakers.length === 1
				? (selectedMakers[0] ?? ALL_AUTHORS_RAIL_ID)
				: null;
	const isAllAuthorsView = selectedMakers.length === 0;
	const sidebar = (
		<GroupRail
			activeId={activeRailId}
			favorites={favorites}
			items={railItems}
			onClick={handleProviderRailClick}
			onToggleFavorite={toggleFavorite}
		/>
	);

	const list = (
		<ModelListContentVirtualized
			expandedModels={expandedModels}
			groupedModels={groupedModelsAll}
			hasActiveFilters={hasActiveFilters}
			isFavoriteModel={isFavoriteModel}
			onSelectModel={handleSelectModel}
			onToggleModelExpanded={toggleModelExpanded}
			onToggleModelFavorite={toggleModelFavorite}
			parsedModelId={parsedModelId}
			parsedProviderSlug={parsedProviderSlug}
			scrollToMakerRequest={scrollToMakerRequest}
			showFavoritesGroup={isAllAuthorsView}
			sortHeaderLabel={
				sortKey === null ? undefined : OPENROUTER_SORT_HEADER_LABEL[sortKey]
			}
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
			supportsMaxTokens={
				selectedModel?.supported_parameters?.includes("max_tokens") ?? false
			}
			supportsVerbosity={
				selectedModel?.supported_parameters?.includes("verbosity") ?? false
			}
		/>
	);

	const triggerNode = externalOpen ? (
		<TriggerButton
			buttonProps={{ onClick: handleDetachedOpen, type: "button" }}
			disabled={disabled}
			isLoading={isLoading}
			open={false}
			parsedModelId={parsedModelId}
			placeholder={placeholder}
			selectedModel={selectedModel}
		/>
	) : (
		<ModelSelectorTrigger
			disabled={disabled}
			isLoading={isLoading}
			open={open}
			parsedModelId={parsedModelId}
			placeholder={placeholder}
			selectedModel={selectedModel}
		/>
	);

	return (
		<div
			className={
				inline
					? "flex h-full min-h-0 flex-col [&>[data-slot=model-picker]]:min-h-0 [&>[data-slot=model-picker]]:flex-1"
					: "flex flex-col gap-2"
			}
			data-slot="openrouter-model-selector"
		>
			{inline ? null : (
				<label
					className="text-body-sm text-foreground-secondary"
					htmlFor="openrouter-model-selector-input"
				>
					{label}
				</label>
			)}
			<ModelPicker<string, string | null>
				activeFiltersSlot={activeFiltersBar}
				belowListSlot={
					<>
						{reasoningBlock}
						{description ? (
							<p className="text-foreground-muted text-xs-tight">
								{description}
							</p>
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
				open={externalOpen ? false : open}
				inline={inline}
				popupHeightClass={popupHeightClass}
				popupRef={openGuard.setPopupNode}
				popupWidthClass={popupWidthClass}
				sidebarSlot={sidebar}
				trigger={triggerNode}
			/>
		</div>
	);
}
