"use client";

import { type ReactNode, useEffect, useState } from "react";
import type { OllamaModel, OllamaPullProgress } from "@/shared/api/models";
import {
	ALL_AUTHORS_RAIL_ID,
	buildAllAuthorsRailItem,
	GroupRail,
	type GroupRailItem,
	RailIconChip,
} from "../../core/GroupRail";
import { ModelPicker } from "../../core/ModelPicker";
import { useFavoriteSet } from "../../core/use-favorite-set";
import { useModelPickerCloseGuard } from "../../lib/model-picker-close-guard";
import { resolveProviderIcon } from "../../lib/provider-icons";
import {
	readPersistedSelectorState,
	writePersistedSelectorState,
} from "../../lib/persisted-selector-state";
import { getOllamaPublisherBySlug } from "../lib/family-helpers";
import {
	OLLAMA_SORT_KEYS,
	type OllamaSortValue,
	sortOllamaModels,
} from "../lib/sort-state";
import { useFavoriteOllamaModels } from "../lib/use-favorite-ollama-models";
import {
	buildOllamaDescriptionIndex,
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
} from "../lib/maker-groups";
import { dedupeInstalledOllamaModels } from "../lib/quant-shelf-helpers";
import { OllamaSortMenu } from "./OllamaSortMenu";
import { ListBody, matchingTypedModelTag } from "./OllamaModelRows";
import { buildQuantShelfDeps } from "./OllamaQuantShelf";
import {
	OllamaTrigger,
	OllamaTriggerButton,
	pickPrimaryPull,
} from "./OllamaTrigger";
import type {
	MakerGroupDeps,
	OllamaModelSelectorProps,
	PausedPullState,
} from "./ollama-selector-types";

// Re-export the moved pure helpers + types so the `maker-groups.test.ts` suite
// (which imports them via `./OllamaModelSelector`) keeps working unchanged, and
// so the package barrel's `OllamaModelSelectorProps` re-export stays valid.
export {
	activePullNameForRow,
	buildOllamaDescriptionIndex,
	installedDescriptionForModel,
	ollamaDescriptionForName,
	ollamaPullMatchesRow,
	singleActivePullName,
	supportsOllamaToolCalling,
	typedModelQueryInfo,
} from "../lib/ollama-description-helpers";
export { buildMakerGroups, type MakerGroup } from "../lib/maker-groups";
export type { OllamaModelSelectorProps } from "./ollama-selector-types";

const DEFAULT_PLACEHOLDER = "Select a model";
const OLLAMA_SELECTOR_UI_STORAGE_KEY = "winstt:model-picker:ollama-ui";
const OLLAMA_SORT_KEY_SET = new Set<string>(OLLAMA_SORT_KEYS);

interface PersistedOllamaSelectorUiState {
	activeRailId: string;
	query: string;
	sortKey: OllamaSortValue;
}

const DEFAULT_PERSISTED_OLLAMA_SELECTOR_UI_STATE: PersistedOllamaSelectorUiState =
	{
		activeRailId: ALL_AUTHORS_RAIL_ID,
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
		isOllamaSortValue(candidate.sortKey)
	);
}

// ── Wrapper: composes ModelPicker shell ───────────────────────────────

const EMPTY_PULLS: Readonly<Record<string, OllamaPullProgress>> = Object.freeze(
	{},
);
const EMPTY_PAUSED: Readonly<Record<string, PausedPullState>> = Object.freeze(
	{},
);

/** Wraps the body so the popup keeps the expected flex layout. */
function selectorListSlot(body: ReactNode): ReactNode {
	return <div className="flex min-h-0 flex-1 flex-col">{body}</div>;
}

/** Build the GroupRail tile list: All authors plus one tile per maker. */
/** The rail tile icon for one maker — brand logo when bundled, else a neutral
 *  initials chip (never the misleading OpenRouter "O"). */
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
	// One tile per maker — installed + recommended (+ library on search) collapse
	// into the same group, so there is no separate Recommended / Library tile.
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

/**
 * Combobox picker for Ollama models. Composes the shared `ModelPicker`
 * shell (search + popup + close-on-select) with three sections inside
 * one dropdown:
 *
 *   1. Installed models grouped by family (selectable, with optional delete).
 *   2. Recommended models filtered to NOT installed, each with quant-shelf
 *      download controls.
 *   3. A typed model-tag card that appears when the search query is a valid
 *      Ollama tag (`name`, `name:tag`, etc.), fetches its sibling quants, and
 *      keeps the exact typed tag pullable even when it is outside the catalog.
 *
 * The recommended section is only rendered when callers supply the pull
 * callbacks (`onPull`, `onStopPull`, `onResumePull`, `onDiscardPull`) and
 * a `recommendedModels` list. The typed-tag card only needs the pull callbacks.
 */
export function OllamaModelSelector({
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
	swap,
	systemFit,
	uiStorageKey = OLLAMA_SELECTOR_UI_STORAGE_KEY,
	value,
}: OllamaModelSelectorProps) {
	const selected = models.find((m) => m.name === value);
	// Ollama lists every tag pointing at a blob, so a model pulled under two names
	// (e.g. `gemma4:e2b` ≡ `gemma4:e2b-it-q4_K_M`, identical digest) appears twice.
	// Collapse same-artifact rows for the installed LIST + Combobox registry; the
	// full `models` set still backs `selected`, install-checks, and swap lookups.
	const dedupedModels = dedupeInstalledOllamaModels(models, value);
	const [persistedUiState] = useState(() =>
		readPersistedSelectorState(
			uiStorageKey,
			isPersistedOllamaSelectorUiState,
			DEFAULT_PERSISTED_OLLAMA_SELECTOR_UI_STATE,
		),
	);
	const [query, setQuery] = useState(persistedUiState.query);
	// Active global sort key, or ``null`` for the default per-publisher grouping.
	const [sortKey, setSortKey] = useState<OllamaSortValue>(
		persistedUiState.sortKey,
	);
	const [activeRailId, setActiveRailId] = useState<string>(
		persistedUiState.activeRailId,
	);
	// Controlled-open + click-tracking, mirroring the STT/OpenRouter pickers.
	// The sort menu's Popover content is portaled OUTSIDE the combobox popup, so
	// without this, clicking a sort chip trips Base UI's outside-press dismissal
	// and collapses the whole picker. ``handleOpenChange`` vetoes that close when
	// the click landed inside our own sort popup.
	const [open, setOpen] = useState(false);
	const externalOpen = onOpenDetached != null;
	const effectiveOpen = inline ? true : open;

	// localStorage-backed per-model favorites — same affordance as the STT
	// picker. The star toggle on each installed row flips membership; favorited
	// models surface as a "Favorites" group pinned to the top of the list.
	useEffect(() => {
		writePersistedSelectorState(uiStorageKey, {
			activeRailId,
			query,
			sortKey,
		});
	}, [activeRailId, query, sortKey, uiStorageKey]);

	const { isFavorite, toggleFavorite } = useFavoriteOllamaModels();
	// Per-window starred-AUTHOR set (the publisher rail tiles) — the maker-
	// favoriting affordance every picker shares. Separate localStorage key from
	// the per-model favorites above.
	const { favorites: favoriteAuthors, toggleFavorite: toggleAuthorFavorite } =
		useFavoriteSet("winstt:ollama-favorite-authors");
	const descriptionsByBase = buildOllamaDescriptionIndex(
		librarySearch?.catalog,
	);

	const canPullModels = !!(
		onPull &&
		onStopPull &&
		onResumePull &&
		onDiscardPull
	);

	const installedFiltered = query.trim()
		? dedupedModels.filter((m) =>
				matchesInstalledQuery(m, query, descriptionsByBase),
			)
		: dedupedModels;

	// When a sort is active, the maker groups collapse into one globally-sorted
	// flat column. Computed once here and threaded to both the rail (count) and
	// the list body.
	const sortedInstalled =
		sortKey === null ? [] : sortOllamaModels(installedFiltered, sortKey);

	const handleSelect = (name: string) => {
		onChange(name);
	};

	// Starred installed models, query-filtered — pinned to the top of the list
	// as a synthetic "Favorites" group. The model is repeated (it also keeps its
	// publisher-group row), matching the STT picker's behavior.
	const favoritesVisible = installedFiltered.filter((m) => isFavorite(m.name));

	const installedNameSet = new Set(models.map((m) => m.name));

	// Curated catalog model names. An installed model backed by one of these (same
	// base + size) is part of the shipped set: its card persists for the app's
	// lifetime, so it gets only per-quant shelf deletes — never a whole-card
	// delete. Ad-hoc models pulled by searching the picker keep the card delete.
	const catalogNameSet = new Set((recommendedModels ?? []).map((m) => m.name));
	const isCatalogModel = (name: string) =>
		isCatalogBackedModel(catalogNameSet, name);

	const recommendedVisible = computeRecommendedVisible(
		recommendedModels,
		installedNameSet,
		query,
	);
	// Recommended models the user starred — pinned into the Favorites group (and
	// kept in their maker group too), matching the STT picker.
	const favoriteRecommended = recommendedVisible.filter((m) =>
		isFavorite(m.name),
	);

	const hasQuery = query.trim().length > 0;

	// Maker-first: installed + recommended merge into one group per maker, sorted
	// by maker label. Remote Ollama results are not fuzzy-listed here; an exact
	// typed tag resolves as a single card below.
	const makerGroups = buildMakerView({
		installed: installedFiltered,
		recommended: recommendedVisible,
	});

	// Build the shared rail tile list — one tile per maker (no Recommended /
	// Library tiles). Matches the OpenRouter + STT pickers (same `GroupRail`).
	const railItems = buildOllamaRailItems({
		allModelCount: makerGroups.reduce(
			(sum, group) => sum + makerGroupCount(group),
			0,
		),
		makerGroups,
	});

	const soleActivePullName = singleActivePullName(pulls);

	// The popup node is captured into ``popupRef`` via Base UI's callback ref so
	// the close guard can distinguish internal filter-menu clicks from outside
	// presses. No `useState` for the node lives at this layer.
	const openGuard = useModelPickerCloseGuard({
		setOpen,
		onOpen: () => {
			onOpen?.();
		},
	});
	const handleOpenChange = externalOpen
		? () => undefined
		: openGuard.handleOpenChange;
	// Combobox.Root's built-in filter is used so keyboard typeahead +
	// item-focus stay in sync with our visible installed rows. We mirror
	// the filtered list for our own grouping/recommended rendering.
	const filter = (m: OllamaModel, q: string) =>
		matchesInstalledQuery(m, q, descriptionsByBase);

	const typedModelInfo = typedModelQueryInfo(query);
	const typedModelTagsState = typedModelInfo
		? librarySearch?.tagsByModel[typedModelInfo.baseSlug]
		: undefined;
	const shouldResolveTypedModel = canPullModels && Boolean(effectiveOpen);
	const typedModelBaseSlug = shouldResolveTypedModel
		? typedModelInfo?.baseSlug
		: undefined;
	const fetchTypedModelTags = librarySearch?.fetchTags;
	useEffect(() => {
		if (typedModelBaseSlug) {
			fetchTypedModelTags?.(typedModelBaseSlug);
		}
	}, [fetchTypedModelTags, typedModelBaseSlug]);
	const typedModelMatch = matchingTypedModelTag(
		typedModelInfo,
		typedModelTagsState,
	);

	// The quant shelf's data source + handlers, bundled once and threaded to every
	// row. The pull/select/fit handlers are the SAME ones the old Pull-button
	// cluster used; `getTags`/`fetchTags` lazily source per-base-slug sibling tags
	// from the library store (undefined when no `librarySearch` → shelf shows just
	// the self-badge).
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
		systemFit,
		value,
	});

	// Shared row deps for every maker group — installed + recommended + library
	// rows all draw from this one bundle.
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
	const visibleMakerGroups = allAuthorsSelected
		? makerGroups
		: makerGroups.filter((group) => group.slug === activeRailId);

	const body = (
		<ListBody
			favoriteRecommended={allAuthorsSelected ? favoriteRecommended : []}
			favoritesVisible={allAuthorsSelected ? favoritesVisible : []}
			hasQuery={hasQuery}
			makerDeps={makerDeps}
			makerGroups={visibleMakerGroups}
			onDelete={onDelete}
			onToggleFavorite={toggleFavorite}
			shelfDeps={shelfDeps}
			showTypedModelCard={allAuthorsSelected && canPullModels}
			sortedInstalled={sortedInstalled}
			sortKey={sortKey}
			typedModelInfo={typedModelInfo}
			typedModelMatch={typedModelMatch}
			typedModelTagsState={typedModelTagsState}
			value={value}
		/>
	);

	const swapFromName = swap?.fromName ?? undefined;
	const swapToName = swap?.toName ?? undefined;
	const swapFromModel = swapFromName
		? models.find((m) => m.name === swapFromName)
		: undefined;
	const swapToModel = swapToName
		? models.find((m) => m.name === swapToName)
		: undefined;
	const handleRailClick = (id: string) => {
		if (id !== ALL_AUTHORS_RAIL_ID) {
			setSortKey(null);
		}
		setActiveRailId(id);
	};
	const handleSortChange = (next: OllamaSortValue) => {
		if (next !== null) {
			setActiveRailId(ALL_AUTHORS_RAIL_ID);
		}
		setSortKey(next);
	};
	const sidebarSlot =
		railItems.length > 1 ? (
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
			isLoading={isLoading}
			isSwitching={!!swapToName}
			placeholder={placeholder}
			selected={selected}
			toModel={swapToModel}
			toName={swapToName}
		/>
	);

	return (
		<ModelPicker<OllamaModel, OllamaModel | null>
			disabled={disabled}
			filter={filter}
			filtersMenuSlot={
				<OllamaSortMenu onSortChange={handleSortChange} sort={sortKey} />
			}
			inline={inline}
			inputValue={query}
			isItemEqualToValue={(a, b) => a?.name === b?.name}
			isLoading={isLoading}
			items={dedupedModels}
			itemToStringLabel={(m) => m?.name ?? ""}
			list={selectorListSlot(body)}
			onInputValueChange={setQuery}
			onOpenChange={handleOpenChange}
			onValueChange={(next) => forwardOllamaSelection(next, handleSelect)}
			open={externalOpen ? false : open}
			popupHeightClass={popupHeightClass}
			popupRef={(node) => {
				openGuard.setPopupNode(node);
			}}
			popupWidthClass={popupWidthClass}
			searchPlaceholder="Search models or enter an Ollama tag"
			selectedItemKey={soleActivePullName ?? (value || undefined)}
			sidebarSlot={sidebarSlot}
			trigger={triggerNode}
			value={selected ?? null}
		/>
	);
}

/** Forward a real selection (non-empty string name) to `onChange`. Base UI's
 *  Combobox fires `onValueChange` twice per click — once with the real model,
 *  once with a synthetic value whose `.name` is undefined. The strict guard
 *  prevents the second call from clearing the selection and reverting swaps.
 *  Extracted out of `OllamaModelSelector` to keep its cognitive complexity
 *  under the rule cap. */
function forwardOllamaSelection(
	next: OllamaModel | null,
	onChange: (modelName: string) => void,
): void {
	if (next && typeof next.name === "string" && next.name.length > 0) {
		onChange(next.name);
	}
}
