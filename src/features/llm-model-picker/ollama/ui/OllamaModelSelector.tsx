"use client";

import {
	type ReactNode,
	useDeferredValue,
	useEffect,
	useReducer,
	useState,
} from "react";
import type {
	OllamaModel,
	OllamaPullProgress,
	RecommendedOllamaModel,
} from "@/shared/api/models";
import {
	GroupRail,
	type GroupRailItem,
	RailIconChip,
} from "@/shared/ui/model-picker/core/GroupRail";
import {
	ALL_AUTHORS_RAIL_ID,
	buildAllAuthorsRailItem,
} from "@/shared/ui/model-picker/core/group-rail-items";
import {
	ModelPicker,
	type ModelPickerProps,
} from "@/shared/ui/model-picker/core/ModelPicker";
import { useFavoriteSet } from "@/shared/ui/model-picker/core/use-favorite-set";
import { useModelPickerCloseGuard } from "@/shared/ui/model-picker/lib/model-picker-close-guard";
import { resolveProviderIcon } from "@/shared/ui/model-picker/lib/provider-icons";
import {
	readPersistedSelectorState,
	writePersistedSelectorState,
} from "@/shared/lib/persisted-selector-state";
import { getOllamaPublisherBySlug } from "../lib/family-helpers";
import {
	EMPTY_OLLAMA_FILTER_STATE,
	filterInstalledOllamaModels,
	filterRecommendedOllamaModels,
	isEmbeddingOnlyOllamaModel,
	isOllamaFilterState,
	normalizeOllamaFilterState,
	type OllamaFilterState,
	type PersistedOllamaFilterState,
} from "../lib/filter-state";
import {
	installedModelSuggested,
	recommendedModelSuggested,
	sortRecommendedBySuggestedScore,
} from "../lib/suggested-visibility";
import { SuggestedFilterChip } from "@/shared/ui/model-picker/ui/SuggestedFilterChip";
import {
	OLLAMA_SORT_KEYS,
	type OllamaSortValue,
	sortOllamaModels,
} from "../lib/sort-state";
import { useFavoriteOllamaModels } from "../lib/use-favorite-ollama-models";
import {
	buildOllamaDescriptionIndex,
	EMPTY_DESCRIPTION_BY_BASE,
	singleActivePullName,
	typedModelQueryInfo,
} from "../lib/ollama-description-helpers";
import {
	buildMakerView,
	computeRecommendedVisible,
	isCatalogBackedModel,
	type MakerGroup,
	makerGroupCount,
	matchesInstalledQuery,
	rankMakerGroupsBySearch,
} from "../lib/maker-groups";
import { dedupeInstalledOllamaModels } from "../lib/quant-shelf-helpers";
import { OllamaFiltersMenu } from "./OllamaFiltersMenu";
import { ListBody } from "./OllamaModelRows";
import { buildQuantShelfDeps } from "./OllamaQuantShelf.helpers";
import { OllamaTrigger, OllamaTriggerButton } from "./OllamaTrigger";
import { pickPrimaryPull } from "./OllamaTrigger.helpers";
import { matchingTypedModelTag } from "./typed-model-match";
import type {
	MakerGroupDeps,
	OllamaModelSelectorProps,
	PausedPullState,
} from "./ollama-selector-types";

const DEFAULT_PLACEHOLDER = "Select a model";
const OLLAMA_SELECTOR_UI_STORAGE_KEY = "winstt:model-picker:ollama-ui";
const OLLAMA_SORT_KEY_SET = new Set<string>(OLLAMA_SORT_KEYS);
const scheduledTypedTagFetches = new Set<string>();

interface OllamaSelectorUiState {
	activeRailId: string;
	filters: OllamaFilterState;
	query: string;
	sortKey: OllamaSortValue;
}

/** The on-disk shape: `filters` was added after this key first shipped, and a
 *  persisted filter blob may itself predate the `suggestedOnly` flag — both
 *  are normalized on read (missing `suggestedOnly` defaults to ON). */
type PersistedOllamaSelectorUiState = Omit<OllamaSelectorUiState, "filters"> & {
	filters?: PersistedOllamaFilterState | undefined;
};

const DEFAULT_PERSISTED_OLLAMA_SELECTOR_UI_STATE: PersistedOllamaSelectorUiState =
	{
		activeRailId: ALL_AUTHORS_RAIL_ID,
		filters: EMPTY_OLLAMA_FILTER_STATE,
		query: "",
		sortKey: null,
	};

function isOllamaSortValue(value: unknown): value is OllamaSortValue {
	return (
		value === null ||
		(typeof value === "string" && OLLAMA_SORT_KEY_SET.has(value))
	);
}

function isPersistedOllamaSelectorUiState(
	value: unknown,
): value is PersistedOllamaSelectorUiState {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as Partial<PersistedOllamaSelectorUiState>;
	return (
		typeof candidate.activeRailId === "string" &&
		typeof candidate.query === "string" &&
		isOllamaSortValue(candidate.sortKey) &&
		// `filters` was added after this key first shipped: accept its absence so a
		// pre-filter persisted blob keeps the user's rail/query/sort (the missing
		// filters are normalised to the empty state on read below).
		(candidate.filters === undefined || isOllamaFilterState(candidate.filters))
	);
}

function requestTypedTagFetch(
	baseSlug: string | undefined,
	fetchTags: ((model: string) => void) | undefined,
): void {
	if (!(baseSlug && fetchTags) || scheduledTypedTagFetches.has(baseSlug)) {
		return;
	}
	scheduledTypedTagFetches.add(baseSlug);
	queueMicrotask(() => {
		fetchTags(baseSlug);
	});
}

const scheduledTypedHitFetches = new Set<string>();

/** Schedule the per-slug homepage-hit scrape (description / capabilities) for a
 *  typed tag, mirroring {@link requestTypedTagFetch}. The store dedupes further,
 *  but this keeps the render pass side-effect-free by deferring to a microtask. */
function requestTypedModelHitFetch(
	baseSlug: string | undefined,
	fetchHit: ((model: string) => void) | undefined,
): void {
	if (!(baseSlug && fetchHit) || scheduledTypedHitFetches.has(baseSlug)) {
		return;
	}
	scheduledTypedHitFetches.add(baseSlug);
	queueMicrotask(() => {
		fetchHit(baseSlug);
	});
}

type OllamaUiAction =
	| { type: "filtersChanged"; filters: OllamaFilterState }
	| { type: "queryChanged"; query: string }
	| { type: "railSelected"; railId: string }
	| { type: "sortChanged"; sort: OllamaSortValue };

function ollamaUiReducer(
	state: OllamaSelectorUiState,
	action: OllamaUiAction,
): OllamaSelectorUiState {
	switch (action.type) {
		case "filtersChanged":
			return { ...state, filters: action.filters };
		case "queryChanged":
			return { ...state, query: action.query };
		case "railSelected":
			return {
				...state,
				sortKey: action.railId === ALL_AUTHORS_RAIL_ID ? state.sortKey : null,
				activeRailId: action.railId,
			};
		case "sortChanged":
			return {
				...state,
				activeRailId:
					action.sort === null ? state.activeRailId : ALL_AUTHORS_RAIL_ID,
				sortKey: action.sort,
			};
		default:
			return state;
	}
}

const EMPTY_PULLS: Readonly<Record<string, OllamaPullProgress>> = Object.freeze(
	{},
);
const EMPTY_PAUSED: Readonly<Record<string, PausedPullState>> = Object.freeze(
	{},
);

function selectorListSlot(body: ReactNode): ReactNode {
	return <div className="flex min-h-0 flex-1 flex-col">{body}</div>;
}

function makerRailIcon(slug: string): ReactNode {
	const icon = resolveProviderIcon(slug);
	if (icon) {
		return (
			<img
				alt=""
				className="size-5 rounded-[3px] object-cover"
				height={20}
				src={icon}
				width={20}
			/>
		);
	}
	return (
		<RailIconChip>
			{getOllamaPublisherBySlug(slug).label.charAt(0).toUpperCase() || "?"}
		</RailIconChip>
	);
}

function buildOllamaRailItems(opts: {
	allModelCount: number;
	makerGroups: readonly MakerGroup[];
}): GroupRailItem[] {
	const railItems: GroupRailItem[] = [
		buildAllAuthorsRailItem(opts.allModelCount),
	];
	for (const group of opts.makerGroups) {
		railItems.push({
			id: group.slug,
			label: getOllamaPublisherBySlug(group.slug).label,
			badge: makerGroupCount(group),
			icon: makerRailIcon(group.slug),
		});
	}
	return railItems;
}

function OllamaDetachedTrigger({
	disabled = false,
	isLoading = false,
	models,
	onOpen,
	onOpenDetached,
	placeholder = DEFAULT_PLACEHOLDER,
	pulls = EMPTY_PULLS,
	swap,
	systemFit,
	value,
}: OllamaModelSelectorProps) {
	const selected = models.find((m) => m.name === value);
	const swapFromName = swap?.fromName ?? undefined;
	const swapToName = swap?.toName ?? undefined;
	const swapFromModel = swapFromName
		? models.find((m) => m.name === swapFromName)
		: undefined;
	const swapToModel = swapToName
		? models.find((m) => m.name === swapToName)
		: undefined;
	const activePull = pickPrimaryPull(pulls);
	return (
		<OllamaTriggerButton
			activePull={activePull}
			disabled={disabled}
			fromModel={swapFromModel}
			fromName={swapFromName}
			getFit={systemFit}
			isLoading={isLoading}
			isSwitching={!!swapToName}
			onActivate={(event) => {
				onOpen?.();
				onOpenDetached?.(event.currentTarget.getBoundingClientRect());
			}}
			placeholder={placeholder}
			selected={selected}
			toModel={swapToModel}
			toName={swapToName}
		/>
	);
}

interface OllamaModelPickerSurfaceProps {
	body: ReactNode;
	disabled: boolean;
	filter: (model: OllamaModel, query: string) => boolean;
	filters: OllamaFilterState;
	handleFiltersChange: (next: OllamaFilterState) => void;
	handleOpenChange: NonNullable<
		ModelPickerProps<OllamaModel, OllamaModel | null>["onOpenChange"]
	>;
	handleSelect: (name: string) => void;
	handleSortChange: (next: OllamaSortValue) => void;
	inline: boolean;
	isLoading: boolean;
	isQueryPending: boolean;
	items: readonly OllamaModel[];
	onQueryChange: (next: string) => void;
	open: boolean;
	popupHeightClass: string;
	popupWidthClass: string;
	query: string;
	selected: OllamaModel | undefined;
	selectedItemKey: string | undefined;
	setPopupNode: (node: HTMLElement | null) => void;
	showHardwareFilter: boolean;
	/** Whether the host wired a Suggested verdict — gates the chip + menu row. */
	showSuggestedFilter: boolean;
	sidebarSlot: ReactNode;
	sortKey: OllamaSortValue;
	triggerNode: ReactNode;
}

function OllamaModelPickerSurface({
	body,
	disabled,
	filter,
	filters,
	handleFiltersChange,
	handleOpenChange,
	handleSelect,
	handleSortChange,
	inline,
	isLoading,
	isQueryPending,
	items,
	onQueryChange,
	open,
	popupHeightClass,
	popupWidthClass,
	query,
	selected,
	selectedItemKey,
	setPopupNode,
	showHardwareFilter,
	showSuggestedFilter,
	sidebarSlot,
	sortKey,
	triggerNode,
}: OllamaModelPickerSurfaceProps) {
	return (
		<ModelPicker<OllamaModel, OllamaModel | null>
			disabled={disabled}
			filter={filter}
			filtersLeadingSlot={
				showSuggestedFilter ? (
					<SuggestedFilterChip
						active={filters.suggestedOnly}
						onToggle={() =>
							handleFiltersChange({
								...filters,
								suggestedOnly: !filters.suggestedOnly,
							})
						}
					/>
				) : undefined
			}
			filtersMenuSlot={
				<OllamaFiltersMenu
					filters={filters}
					onFiltersChange={handleFiltersChange}
					onSortChange={handleSortChange}
					showHardwareFilter={showHardwareFilter}
					showSuggestedFilter={showSuggestedFilter}
					sort={sortKey}
				/>
			}
			inline={inline}
			inputValue={query}
			isItemEqualToValue={(a, b) => a?.name === b?.name}
			isLoading={isLoading || isQueryPending}
			items={items}
			itemToStringLabel={(m) => m?.name ?? ""}
			list={selectorListSlot(body)}
			onInputValueChange={onQueryChange}
			onOpenChange={handleOpenChange}
			onValueChange={(next) => forwardOllamaSelection(next, handleSelect)}
			open={open}
			popupHeightClass={popupHeightClass}
			popupRef={setPopupNode}
			popupWidthClass={popupWidthClass}
			searchPlaceholder="Search models or enter an Ollama tag"
			selectedItemKey={selectedItemKey}
			sidebarSlot={sidebarSlot}
			trigger={triggerNode}
			value={selected ?? null}
		/>
	);
}

function useOllamaModelSelectorPanelState({
	disabled = false,
	inline = false,
	isLoading = false,
	librarySearch,
	models,
	onChange,
	onDelete,
	onDiscardPull,
	onOpen,
	onOpenDetached,
	onPull,
	onResumePull,
	onStopPull,
	pausedPulls = EMPTY_PAUSED,
	placeholder = DEFAULT_PLACEHOLDER,
	popupHeightClass = "h-[min(620px,var(--available-height))]",
	popupWidthClass = "w-[max(620px,var(--anchor-width))]",
	pulls = EMPTY_PULLS,
	recommendedModels,
	suggestions,
	swap,
	systemFit,
	uiStorageKey = OLLAMA_SELECTOR_UI_STORAGE_KEY,
	value,
}: OllamaModelSelectorProps) {
	const selected = models.find((m) => m.name === value);
	const [persistedUiState] = useState<OllamaSelectorUiState>(() => {
		const read = readPersistedSelectorState(
			uiStorageKey,
			isPersistedOllamaSelectorUiState,
			DEFAULT_PERSISTED_OLLAMA_SELECTOR_UI_STATE,
		);
		// Normalise the optional (newly-added) `filters` to the empty state so the
		// reducer state always carries a concrete filter object; a filter blob
		// that predates `suggestedOnly` defaults the missing flag to ON.
		return {
			...read,
			filters: normalizeOllamaFilterState(
				read.filters ?? EMPTY_OLLAMA_FILTER_STATE,
			),
		};
	});
	const [uiState, dispatchUi] = useReducer(ollamaUiReducer, persistedUiState);
	const { activeRailId, filters, query, sortKey } = uiState;
	const [open, setOpen] = useState(false);
	const externalOpen = onOpenDetached != null;
	const effectiveOpen = inline ? true : open;
	const deferredQuery = useDeferredValue(query);
	const listQuery = effectiveOpen ? deferredQuery : query;
	const isQueryPending = effectiveOpen && query !== deferredQuery;
	const shouldBuildList = effectiveOpen;
	// Hide embedding-only installed models (e.g. `nomic-embed-text`) — they emit
	// vectors, not text, so they can't post-process. Keep the current `value` so a
	// previously-persisted pick still renders in the trigger/list.
	const dedupedModels = shouldBuildList
		? dedupeInstalledOllamaModels(
				models.filter(
					(m) => m.name === value || !isEmbeddingOnlyOllamaModel(m),
				),
				value,
			)
		: [];

	useEffect(() => {
		writePersistedSelectorState(uiStorageKey, uiState);
	}, [uiStorageKey, uiState]);

	const { isFavorite, toggleFavorite } = useFavoriteOllamaModels();
	const { favorites: favoriteAuthors, toggleFavorite: toggleAuthorFavorite } =
		useFavoriteSet("winstt:ollama-favorite-authors");
	const descriptionsByBase = shouldBuildList
		? buildOllamaDescriptionIndex(librarySearch?.catalog)
		: EMPTY_DESCRIPTION_BY_BASE;

	const canPullModels = !!(
		onPull &&
		onStopPull &&
		onResumePull &&
		onDiscardPull
	);

	const installedSearchFiltered =
		shouldBuildList && listQuery.trim()
			? dedupedModels.filter((m) =>
					matchesInstalledQuery(m, listQuery, descriptionsByBase),
				)
			: dedupedModels;

	// Suggested (spec-based recommender). The host injects the verdict; when
	// absent the flag is inert (predicates null) and the chip stays hidden. A
	// card is suggestible iff ANY canonical-ladder quant fits the memory
	// budgets — judged against the scraped tag list when fetched, the card's
	// single known size otherwise (lenient on unknown sizes).
	const suggestionsAvailable = suggestions !== undefined;
	const suggestedFilterOn = suggestionsAvailable && filters.suggestedOnly;
	const tagsByModel = librarySearch?.tagsByModel;
	const getSuggestionTags = tagsByModel
		? (baseSlug: string) => tagsByModel[baseSlug.toLowerCase()]?.tags ?? []
		: undefined;
	const installedSuggested =
		suggestedFilterOn && suggestions
			? (m: OllamaModel) =>
					installedModelSuggested(m, getSuggestionTags, suggestions.fits)
			: null;
	const recommendedSuggested =
		suggestedFilterOn && suggestions
			? (m: RecommendedOllamaModel) =>
					recommendedModelSuggested(m, getSuggestionTags, suggestions.fits)
			: null;

	// `installedOnly` is a no-op here (installed models are all downloaded);
	// `fitsHardwareOnly` + the Suggested predicate prune the ones the host
	// can't run.
	const installedFiltered = filterInstalledOllamaModels(
		installedSearchFiltered,
		filters,
		systemFit,
		installedSuggested,
	);

	const sortedInstalled =
		shouldBuildList && sortKey !== null
			? sortOllamaModels(installedFiltered, sortKey)
			: [];

	const handleSelect = (name: string) => {
		onChange(name);
	};

	const favoritesVisible = shouldBuildList
		? installedFiltered.filter((m) => isFavorite(m.name))
		: [];

	const installedNameSet = shouldBuildList
		? new Set(models.map((m) => m.name))
		: new Set<string>();

	const catalogNameSet = shouldBuildList
		? new Set((recommendedModels ?? []).map((m) => m.name))
		: new Set<string>();
	const isCatalogModel = (name: string) =>
		isCatalogBackedModel(catalogNameSet, name);

	// `installedOnly` empties the recommended list (those cards are by definition
	// not installed); `fitsHardwareOnly` + the Suggested predicate prune the
	// ones the host can't run.
	const recommendedBase = computeRecommendedVisible(
		shouldBuildList ? recommendedModels : undefined,
		installedNameSet,
		listQuery,
	);
	const recommendedFiltered = filterRecommendedOllamaModels(
		recommendedBase,
		filters,
		systemFit,
		recommendedSuggested,
	);
	// With Suggested ON and NO explicit sort, recommended cards order best
	// bang-for-buck first (the engine's proxy ranking) instead of the curated
	// catalog order. A user-chosen sort key overrides the ordering — but never
	// the hiding or the per-tag badge gating.
	const recommendedVisible =
		suggestedFilterOn && suggestions && sortKey === null
			? sortRecommendedBySuggestedScore(recommendedFiltered, (m) =>
					suggestions.score({
						displayName: m.displayName,
						name: m.name,
						paramSizeLabel: m.paramSize,
						sizeBytes: m.sizeBytes,
					}),
				)
			: recommendedFiltered;
	// How many models the Suggested flag alone is hiding — drives the
	// empty-state "N models hidden by Suggested — tap to show all" hint.
	const suggestedHiddenCount = suggestedFilterOn
		? filterInstalledOllamaModels(installedSearchFiltered, filters, systemFit)
				.length -
			installedFiltered.length +
			(filterRecommendedOllamaModels(recommendedBase, filters, systemFit)
				.length -
				recommendedFiltered.length)
		: 0;
	const favoriteRecommended = recommendedVisible.filter((m) =>
		isFavorite(m.name),
	);

	const hasQuery = listQuery.trim().length > 0;

	const makerGroups = shouldBuildList
		? buildMakerView({
				installed: installedFiltered,
				recommended: recommendedVisible,
			})
		: [];

	const railItems = buildOllamaRailItems({
		allModelCount: makerGroups.reduce(
			(sum, group) => sum + makerGroupCount(group),
			0,
		),
		makerGroups,
	});

	const soleActivePullName = singleActivePullName(pulls);

	const openGuard = useModelPickerCloseGuard({
		setOpen,
		onOpen: () => {
			onOpen?.();
		},
	});
	const handleOpenChange = externalOpen
		? () => undefined
		: openGuard.handleOpenChange;
	const filter = (m: OllamaModel, q: string) =>
		matchesInstalledQuery(m, q, descriptionsByBase);

	const typedModelInfo = shouldBuildList
		? typedModelQueryInfo(listQuery)
		: null;
	const typedModelTagsState = typedModelInfo
		? librarySearch?.tagsByModel[typedModelInfo.baseSlug]
		: undefined;
	const typedModelHitState = typedModelInfo
		? librarySearch?.hitsByModel[typedModelInfo.baseSlug]
		: undefined;
	const shouldResolveTypedModel = canPullModels && Boolean(effectiveOpen);
	const typedModelBaseSlug = shouldResolveTypedModel
		? typedModelInfo?.baseSlug
		: undefined;
	const fetchTypedModelTags = librarySearch?.fetchTags;
	requestTypedTagFetch(typedModelBaseSlug, fetchTypedModelTags);
	requestTypedModelHitFetch(typedModelBaseSlug, librarySearch?.fetchHit);
	const typedModelMatch = matchingTypedModelTag(
		typedModelInfo,
		typedModelTagsState,
	);

	const shelfDeps = buildQuantShelfDeps({
		installedNames: installedNameSet,
		librarySearch,
		onDelete,
		onDiscardPull,
		onPull,
		onResumePull,
		onSelect: handleSelect,
		onStopPull,
		pausedPulls,
		pulls,
		suggestedFits:
			suggestedFilterOn && suggestions ? suggestions.fits : undefined,
		systemFit,
		value,
	});

	const makerDeps: MakerGroupDeps = {
		descriptionsByBase,
		getFit: systemFit,
		installedNames: installedNameSet,
		isCatalogModel,
		isFavorite,
		onDelete,
		onSelect: handleSelect,
		onToggleFavorite: toggleFavorite,
		pausedPulls,
		pulls,
		shelfDeps,
		tagsByModel: librarySearch?.tagsByModel ?? {},
		value,
	};
	const allAuthorsSelected = activeRailId === ALL_AUTHORS_RAIL_ID;
	// Rank the list body best-match-first while searching; the rail keeps the
	// unranked (alphabetical) `makerGroups` so the sidebar order stays stable.
	const rankedMakerGroups = hasQuery
		? rankMakerGroupsBySearch(makerGroups, listQuery)
		: makerGroups;
	const visibleMakerGroups = allAuthorsSelected
		? rankedMakerGroups
		: rankedMakerGroups.filter((group) => group.slug === activeRailId);

	const body = shouldBuildList ? (
		<ListBody
			favoriteRecommended={allAuthorsSelected ? favoriteRecommended : []}
			favoritesVisible={allAuthorsSelected ? favoritesVisible : []}
			hasQuery={hasQuery}
			makerDeps={makerDeps}
			makerGroups={visibleMakerGroups}
			onDelete={onDelete}
			onShowAllSuggested={() =>
				dispatchUi({
					type: "filtersChanged",
					filters: { ...filters, suggestedOnly: false },
				})
			}
			onToggleFavorite={toggleFavorite}
			shelfDeps={shelfDeps}
			suggestedHiddenCount={suggestedHiddenCount}
			showTypedModelCard={
				allAuthorsSelected && canPullModels && !filters.installedOnly
			}
			sortedInstalled={sortedInstalled}
			sortKey={sortKey}
			typedModelHitState={typedModelHitState}
			typedModelInfo={typedModelInfo}
			typedModelMatch={typedModelMatch}
			typedModelTagsState={typedModelTagsState}
			value={value}
		/>
	) : null;

	const swapFromName = swap?.fromName ?? undefined;
	const swapToName = swap?.toName ?? undefined;
	const swapFromModel = swapFromName
		? models.find((m) => m.name === swapFromName)
		: undefined;
	const swapToModel = swapToName
		? models.find((m) => m.name === swapToName)
		: undefined;
	const handleRailClick = (id: string) => {
		dispatchUi({ type: "railSelected", railId: id });
	};
	const handleSortChange = (next: OllamaSortValue) => {
		dispatchUi({ type: "sortChanged", sort: next });
	};
	const handleFiltersChange = (next: OllamaFilterState) => {
		dispatchUi({ type: "filtersChanged", filters: next });
	};
	const sidebarSlot =
		shouldBuildList && railItems.length > 1 ? (
			<GroupRail
				activeId={activeRailId}
				favorites={favoriteAuthors}
				items={railItems}
				onClick={handleRailClick}
				onToggleFavorite={toggleAuthorFavorite}
			/>
		) : undefined;
	const activePull = pickPrimaryPull(pulls);
	const triggerNode = externalOpen ? (
		<OllamaTriggerButton
			activePull={activePull}
			disabled={disabled}
			fromModel={swapFromModel}
			fromName={swapFromName}
			getFit={systemFit}
			isLoading={isLoading}
			isSwitching={!!swapToName}
			onActivate={(event) => {
				onOpen?.();
				onOpenDetached?.(event.currentTarget.getBoundingClientRect());
			}}
			placeholder={placeholder}
			selected={selected}
			toModel={swapToModel}
			toName={swapToName}
		/>
	) : (
		<OllamaTrigger
			activePull={activePull}
			disabled={disabled}
			fromModel={swapFromModel}
			fromName={swapFromName}
			getFit={systemFit}
			isLoading={isLoading}
			isSwitching={!!swapToName}
			placeholder={placeholder}
			selected={selected}
			toModel={swapToModel}
			toName={swapToName}
		/>
	);

	const surfaceProps: OllamaModelPickerSurfaceProps = {
		body,
		disabled,
		filter,
		filters,
		handleFiltersChange,
		handleOpenChange,
		handleSelect,
		handleSortChange,
		inline,
		isLoading,
		isQueryPending,
		items: shouldBuildList ? dedupedModels : [],
		onQueryChange: (next) => dispatchUi({ type: "queryChanged", query: next }),
		open: externalOpen ? false : open,
		popupHeightClass,
		popupWidthClass,
		query,
		selected,
		selectedItemKey: soleActivePullName ?? (value || undefined),
		setPopupNode: openGuard.setPopupNode,
		showHardwareFilter: !!systemFit,
		showSuggestedFilter: suggestionsAvailable,
		sidebarSlot,
		sortKey,
		triggerNode,
	};

	return surfaceProps;
}

function OllamaModelSelectorPanel(props: OllamaModelSelectorProps) {
	const surfaceProps = useOllamaModelSelectorPanelState(props);
	return <OllamaModelPickerSurface {...surfaceProps} />;
}

export function OllamaModelSelector(props: OllamaModelSelectorProps) {
	if (props.onOpenDetached && !props.inline) {
		return <OllamaDetachedTrigger {...props} />;
	}
	return <OllamaModelSelectorPanel {...props} />;
}

function forwardOllamaSelection(
	next: OllamaModel | null,
	onChange: (modelName: string) => void,
): void {
	if (next && typeof next.name === "string" && next.name.length > 0) {
		onChange(next.name);
	}
}
