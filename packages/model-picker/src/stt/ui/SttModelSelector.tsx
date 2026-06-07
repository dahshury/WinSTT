"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useEffect, useReducer, useRef, useState } from "react";
import type { ModelInfo } from "@/entities/model-catalog";
import type {
	FitAssessmentEntry,
	ModelStateEntry,
	SystemInfoEntry,
} from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";
import {
	ALL_AUTHORS_RAIL_ID,
	buildAllAuthorsRailItem,
	type GroupRailItem,
	RailIconChip,
} from "../../core/GroupRail";
import { useFavoriteSet } from "../../core/use-favorite-set";
import { useModelPickerCloseGuard } from "../../lib/model-picker-close-guard";
import {
	isStringArray,
	readPersistedSelectorState,
	writePersistedSelectorState,
} from "../../lib/persisted-selector-state";
import { publicAsset } from "../../lib/public-asset";
import { STT_PICKER_WIDTH_CLASS } from "../lib/dimensions";
import {
	buildModelSearchCorpus,
	type FamilyKey,
	getAuthorLabel,
	getBaseId,
	getFamilyConfig,
	groupModelsByAuthor,
	SORTED_GROUP_VALUE,
	type SttListGroup,
	withFavoritesGroup,
} from "../lib/family-helpers";
import {
	collectFilterableLanguages,
	filterSttModels,
	hasActiveFilters,
	type SttFilterState,
} from "../lib/filter-state";
import {
	sortSttModels,
	STT_SORT_KEYS,
	type SttSortValue,
} from "../lib/sort-state";
import {
	findDisplayModelByBackingId,
	mergeStreamingPrecisionModels,
	mergeStreamingPrecisionStates,
} from "../lib/streaming-precision-merge";
import { useFavoriteSttModels } from "../lib/use-favorite-stt-models";
import {
	DeleteQuantConfirmDialog,
	type PendingDelete,
} from "./DeleteQuantConfirmDialog";
import { SttModelSelectorTriggerButton } from "./SttModelSelectorTrigger";
import { SttModelSelectorView } from "./SttModelSelectorView";
import {
	createInitialUiState,
	type PersistedSttSelectorUiState,
	sttSelectorUiReducer,
} from "./stt-selector-ui-state";
import type { LockedSttFilterFlag } from "./SttFiltersMenu";

type SttModelChange = (
	modelId: string,
	quantization?: OnnxQuantization,
) => void;

export interface SttModelSelectorProps {
	currentQuantization: OnnxQuantization;
	disabled?: boolean;
	/** Live download snapshot — drives the trigger's "downloading X · 23%"
	 *  variant when the in-flight swap target matches the downloading model.
	 *  Self-contained package, so the consumer wires the store. */
	downloadProgress?: { modelId: string; percent: number | null } | null;
	/** Render as an inline panel (no trigger/popup) that fills its host —
	 *  used by the detached model-picker window. */
	inline?: boolean;
	isLoading?: boolean;
	/** Which swap-store slot this picker is bound to. Drives the trigger's
	 *  in-flight `from → to` indicator so the main picker and the realtime
	 *  picker each only react to their own swap. Defaults to `"main"`. */
	kind?: "main" | "realtime";
	models: readonly ModelInfo[];
	onChange: SttModelChange;
	/** Per-quant delete handler. Receives the (modelId, quantization)
	 *  tuple after the user confirms in the selector-level alert dialog.
	 *  When omitted, the trash icon is NOT rendered next to cached/partial
	 *  quants (the selector becomes read-only with respect to deletion). */
	onDeleteQuant?: (modelId: string, quantization: OnnxQuantization) => void;
	/** Per-quant delete availability. Returning false hides the trash icon
	 *  for that installed/partial precision without making the whole selector
	 *  read-only. */
	canDeleteQuant?: (modelId: string, quantization: OnnxQuantization) => boolean;
	/** Per-quant download action — start / pause / resume / cancel. The
	 *  consumer wires these to ``useDownloadStore`` actions. */
	onDownloadAction?: (
		action: import("./SttModelCard").QuantDownloadAction,
		modelId: string,
		quantization: OnnxQuantization,
	) => void;
	/** Per-quant download snapshot lookup (active downloads only). */
	onDownloadSnapshot?: (
		modelId: string,
		quantization: OnnxQuantization,
	) => import("./SttModelCard").QuantDownloadSnapshot | undefined;
	/** Optional live RAM/VRAM fit assessment lookup per model row. */
	getFitAssessment?:
		| ((modelId: string) => FitAssessmentEntry | null)
		| undefined;
	/** When set, the trigger opens a detached picker window (passing its
	 *  on-screen rect) INSTEAD of the in-window popup — used by the settings
	 *  panel so the picker can extend beyond the 700×560 settings window, the
	 *  same way the main-window footer chip does. The inline popup is fully
	 *  suppressed in this mode. */
	onOpenDetached?: (rect: DOMRect) => void;
	placeholder?: string;
	/** Popup height class. Defaults to the roomy settings-panel height; the
	 *  footer chip overrides this with a compact one to fit the status bar. */
	popupHeightClass?: string;
	/** Popup width class. Defaults to the settings-panel width. */
	popupWidthClass?: string;
	/** Optional pre-filter applied before any user filter (e.g., realtime-only picker). */
	prefilter?: ((model: ModelInfo) => boolean) | undefined;
	statesById: Record<string, ModelStateEntry>;
	systemInfo: SystemInfoEntry | null;
	/** Replaces the default glass-card trigger. The footer passes a compact
	 *  chip here so the bar keeps its small footprint while the popup stays
	 *  the full picker. Must render a `Combobox.Trigger` internally. */
	trigger?: ReactNode;
	value: string;
}

const DEFAULT_STT_POPUP_HEIGHT = "h-[min(620px,var(--available-height))]";
// Pinned, NOT `max(..., var(--anchor-width))`: the detached BrowserWindow and
// the settings popup must render at the exact same pixel width, so we ignore
// the trigger's measured width and use the shared constant verbatim.
const DEFAULT_STT_POPUP_WIDTH = STT_PICKER_WIDTH_CLASS;

const REALTIME_LOCKED_FILTERS: readonly LockedSttFilterFlag[] = [
	"realtimeOnly",
];
const STT_SELECTOR_UI_STORAGE_KEYS: Record<
	NonNullable<SttModelSelectorProps["kind"]>,
	string
> = {
	main: "winstt:model-picker:stt-main-ui",
	realtime: "winstt:model-picker:stt-realtime-ui",
};
const selectedModelMetadataCache = new Map<string, ModelInfo>();
const DEFAULT_PERSISTED_STT_SELECTOR_UI_STATE: PersistedSttSelectorUiState = {
	activeRailId: ALL_AUTHORS_RAIL_ID,
	filters: {
		cachedOnly: false,
		fitsHardwareOnly: false,
		languages: [],
		realtimeOnly: false,
	},
	sort: null,
};
const STT_SORT_KEY_SET = new Set<string>(STT_SORT_KEYS);

function isSttSortValue(value: unknown): value is SttSortValue {
	return (
		value === null || (typeof value === "string" && STT_SORT_KEY_SET.has(value))
	);
}

function isSttFilterState(value: unknown): value is SttFilterState {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as Partial<SttFilterState>;
	return (
		typeof candidate.cachedOnly === "boolean" &&
		typeof candidate.fitsHardwareOnly === "boolean" &&
		typeof candidate.realtimeOnly === "boolean" &&
		isStringArray(candidate.languages)
	);
}

function isPersistedSttSelectorUiState(
	value: unknown,
): value is PersistedSttSelectorUiState {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as Partial<PersistedSttSelectorUiState>;
	return (
		(candidate.activeRailId === null ||
			typeof candidate.activeRailId === "string") &&
		isSttFilterState(candidate.filters) &&
		isSttSortValue(candidate.sort)
	);
}

function applyLockedFilters(
	filters: SttFilterState,
	locked: readonly LockedSttFilterFlag[],
): SttFilterState {
	let next = filters;
	for (const key of locked) {
		if (!next[key]) {
			next = { ...next, [key]: true };
		}
	}
	return next;
}

function applyPrefilter(
	models: readonly ModelInfo[],
	prefilter: ((m: ModelInfo) => boolean) | undefined,
): readonly ModelInfo[] {
	return prefilter ? models.filter(prefilter) : models;
}

/** Text search delegated to Base UI's filtering pipeline (groups + keyboard). */
function matchesQuery(model: ModelInfo, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (q.length === 0) {
		return true;
	}
	return buildModelSearchCorpus(model).includes(q);
}

function buildRailItems(
	groups: ReturnType<typeof groupModelsByAuthor>,
	allModelCount: number,
): GroupRailItem[] {
	const items: GroupRailItem[] = [buildAllAuthorsRailItem(allModelCount)];
	for (const group of groups) {
		const family: FamilyKey = group.value;
		const cfg = getFamilyConfig(family);
		items.push({
			id: family,
			label: `${getAuthorLabel(family)} · ${cfg.label}`,
			badge: group.items.length,
			icon: cfg.logoSrc ? (
				<img
					alt=""
					className="size-5 rounded-[3px] object-contain"
					height={20}
					src={publicAsset(cfg.logoSrc)}
					width={20}
				/>
			) : (
				<RailIconChip>
					<HugeiconsIcon className="size-3" icon={cfg.icon} />
				</RailIconChip>
			),
		});
	}
	return items;
}

/**
 * Whisper / NeMo / GigaAM / Kaldi / Lite-Whisper / T-One transcription
 * picker. Composes the shared `ModelPicker` shell with an STT-specific
 * trigger (cache pill + quantization), a filters menu (language / hardware /
 * realtime / cached), and the grouped model list (per-row quantization
 * picker, hardware-fit warning, download progress pill).
 *
 * Filter state lives in this wrapper (via the consolidated `useReducer`)
 * so the user's "cached only + Spanish" choice survives across the popup's
 * search clear; the shell auto-clears only the search query on close
 * (matching the OpenRouter + Ollama behaviour).
 */
export function SttModelSelector({
	models,
	value,
	currentQuantization,
	onChange,
	onDeleteQuant,
	canDeleteQuant,
	onDownloadAction,
	onDownloadSnapshot,
	getFitAssessment,
	statesById,
	systemInfo,
	disabled = false,
	downloadProgress = null,
	isLoading = false,
	placeholder = "Select a model",
	prefilter,
	kind = "main",
	popupHeightClass = DEFAULT_STT_POPUP_HEIGHT,
	popupWidthClass = DEFAULT_STT_POPUP_WIDTH,
	trigger,
	inline = false,
	onOpenDetached,
}: SttModelSelectorProps) {
	// Pending delete confirmation — driven by trash-icon clicks bubbling
	// up from any card via `onRequestDeleteQuant`. Lives at the selector
	// level so the AlertDialog isn't trapped inside the Combobox.Item's
	// focus context (which interferes with Base UI's combobox dismiss).
	const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(
		null,
	);
	const handleRequestDelete = onDeleteQuant
		? (
				modelId: string,
				quantization: OnnxQuantization,
				displayName: string,
				quantLabel: string,
			) => {
				setPendingDelete({ modelId, quantization, displayName, quantLabel });
			}
		: undefined;
	const handleConfirmDelete = () => {
		if (pendingDelete && onDeleteQuant) {
			onDeleteQuant(pendingDelete.modelId, pendingDelete.quantization);
		}
		setPendingDelete(null);
	};

	// Per-window starred-model set, persisted to localStorage. Drives both the
	// per-card star toggle and the synthetic "Favorites" group pinned to the top.
	const { isFavorite, toggleFavorite } = useFavoriteSttModels();
	// Per-window starred-AUTHOR set (the family rail tiles). Starred authors float
	// to the top of the side rail — the maker-favoriting affordance every picker
	// now shares. Separate localStorage key from the per-model favorites above.
	const { favorites: favoriteAuthors, toggleFavorite: toggleAuthorFavorite } =
		useFavoriteSet("winstt:stt-favorite-authors");

	const prefilteredModels = applyPrefilter(models, prefilter);
	const baseModels = mergeStreamingPrecisionModels(prefilteredModels);
	const routedStatesById = mergeStreamingPrecisionStates(
		baseModels,
		statesById,
	);
	const selectedCacheKey = `${kind}:${value}`;
	const resolvedSelectedModel = findDisplayModelByBackingId(baseModels, value);
	const cachedSelectedModel =
		value.length > 0 && baseModels.length === 0
			? (selectedModelMetadataCache.get(selectedCacheKey) ?? null)
			: null;
	const selectedModel = resolvedSelectedModel ?? cachedSelectedModel;
	useEffect(() => {
		if (resolvedSelectedModel !== null) {
			selectedModelMetadataCache.set(selectedCacheKey, resolvedSelectedModel);
		}
	}, [resolvedSelectedModel, selectedCacheKey]);
	const selectedFamily: FamilyKey | null = selectedModel?.family ?? null;
	const selectedBaseId =
		selectedModel === null ? null : getBaseId(selectedModel.id);

	// Detached-open mode (settings panel): render the standalone trigger button
	// that opens the floating picker window on click, and keep the in-window
	// popup permanently closed.
	const externalOpen = onOpenDetached != null;
	const effectiveTrigger = externalOpen ? (
		<SttModelSelectorTriggerButton
			catalog={baseModels}
			disabled={disabled || isLoading}
			downloadProgress={downloadProgress}
			kind={kind}
			onActivate={(event) =>
				onOpenDetached?.(event.currentTarget.getBoundingClientRect())
			}
			open={false}
			placeholder={placeholder}
			selectedModel={selectedModel ?? undefined}
		/>
	) : (
		trigger
	);

	// Consolidated UI/nav state — collapses the 4 separate `useState`s for
	// filters / activeRailId / expandedBundles / open into one reducer to
	// stay under the `react-doctor/prefer-useReducer` threshold.
	const uiStorageKey = STT_SELECTOR_UI_STORAGE_KEYS[kind];
	const [uiState, dispatch] = useReducer(sttSelectorUiReducer, undefined, () =>
		createInitialUiState(
			selectedFamily,
			selectedBaseId,
			readPersistedSelectorState(
				uiStorageKey,
				isPersistedSttSelectorUiState,
				DEFAULT_PERSISTED_STT_SELECTOR_UI_STATE,
			),
		),
	);
	const { filters, sort, activeRailId, expandedBundles, open } = uiState;
	const lockedFilterKeys = kind === "realtime" ? REALTIME_LOCKED_FILTERS : [];
	const effectiveFilters = applyLockedFilters(filters, lockedFilterKeys);
	useEffect(() => {
		writePersistedSelectorState(uiStorageKey, {
			activeRailId,
			filters: effectiveFilters,
			sort,
		});
	}, [activeRailId, effectiveFilters, sort, uiStorageKey]);

	// Menu filters (cached / realtime / language / hardware) prune the items
	// before the picker sees them; the text query is then handled by Base
	// UI's `filter` (via the shell) so groups + keyboard nav stay consistent.
	const menuFilteredModels = filterSttModels(baseModels, {
		statesById: routedStatesById,
		systemInfo,
		filters: effectiveFilters,
		searchQuery: "",
	});
	// All authors keeps the current grouped/sorted view. Selecting a rail author
	// narrows the list to that author only.
	const authorGroups = groupModelsByAuthor(menuFilteredModels);
	const allGroups: SttListGroup[] =
		sort === null
			? withFavoritesGroup(authorGroups, isFavorite)
			: [
					{
						value: SORTED_GROUP_VALUE,
						items: sortSttModels(menuFilteredModels, sort),
					},
				];
	const groups: SttListGroup[] =
		activeRailId === ALL_AUTHORS_RAIL_ID
			? allGroups
			: authorGroups.filter((group) => group.value === activeRailId);
	const filtersActive = hasActiveFilters(effectiveFilters);
	const availableLanguages = collectFilterableLanguages(baseModels);

	// Shared rail: All authors plus one tile per family.
	const railItems: GroupRailItem[] = buildRailItems(
		authorGroups,
		menuFilteredModels.length,
	);
	const visibleModelCount =
		activeRailId === ALL_AUTHORS_RAIL_ID
			? menuFilteredModels.length
			: groups.reduce((sum, group) => sum + group.items.length, 0);
	// Re-sync the active rail tile to the selection's family during render
	// whenever it changes, while still letting a user rail click override
	// it until the selection moves again. The prev-value tracker is a ref
	// (never read in JSX) so the resync doesn't schedule an extra render —
	// see https://react.dev/learn/you-might-not-need-an-effect
	// Variant-bundle expansion. Sync at render-time (cheaper than useEffect,
	// no extra render pass — see https://react.dev/learn/you-might-not-need-an-effect):
	// whenever the externally-controlled selection moves to a different variant,
	// make sure its bundle is expanded BEFORE Combobox.Item renders, so the
	// variant registers into Base UI's listRef and the built-in open-time
	// autoscroll can find it.
	const prevSelectedBaseIdRef = useRef(selectedBaseId);
	if (prevSelectedBaseIdRef.current !== selectedBaseId) {
		prevSelectedBaseIdRef.current = selectedBaseId;
		if (selectedBaseId !== null) {
			dispatch({ type: "ensureBundleExpanded", baseId: selectedBaseId });
		}
	}
	const handleToggleExpanded = (baseId: string) => {
		dispatch({ type: "toggleBundle", baseId });
	};
	const handleRailClick = (id: string) => {
		if (id !== ALL_AUTHORS_RAIL_ID && sort !== null) {
			dispatch({ type: "setSort", sort: null });
		}
		dispatch({ type: "setActiveRailId", id });
	};

	// Shared close guard keeps filter popovers from triggering an outside-press
	// dismissal while still allowing item selections to close the picker.
	const openGuard = useModelPickerCloseGuard({
		setOpen: (nextOpen) => dispatch({ type: "setOpen", open: nextOpen }),
	});
	const handleOpenChange = externalOpen
		? () => undefined
		: openGuard.handleOpenChange;

	const handleSelect = (modelId: string, quantization?: OnnxQuantization) => {
		onChange(modelId, quantization);
	};

	return (
		<>
			<SttModelSelectorView
				activeRailId={activeRailId}
				availableLanguages={availableLanguages}
				baseModels={baseModels}
				currentQuantization={currentQuantization}
				disabled={disabled}
				downloadProgress={downloadProgress}
				expandedBundles={expandedBundles}
				filter={matchesQuery}
				filters={effectiveFilters}
				filtersActive={filtersActive}
				groups={groups}
				handleOpenChange={handleOpenChange}
				handleRailClick={handleRailClick}
				handleSelect={handleSelect}
				inline={inline}
				isFavorite={isFavorite}
				isLoading={isLoading}
				kind={kind}
				onDownloadAction={onDownloadAction}
				onDownloadSnapshot={onDownloadSnapshot}
				lockedFilterKeys={lockedFilterKeys}
				onFiltersChange={(next) =>
					dispatch({
						type: "setFilters",
						filters: applyLockedFilters(next, lockedFilterKeys),
					})
				}
				getFitAssessment={getFitAssessment}
				canDeleteQuant={canDeleteQuant}
				onRequestDelete={handleRequestDelete}
				onSortChange={(next) => dispatch({ type: "setSort", sort: next })}
				onToggleExpanded={handleToggleExpanded}
				onToggleFavorite={toggleFavorite}
				onToggleRailFavorite={toggleAuthorFavorite}
				open={externalOpen ? false : open}
				placeholder={placeholder}
				popupHeightClass={popupHeightClass}
				popupRef={(node) => {
					openGuard.setPopupNode(node);
				}}
				popupWidthClass={popupWidthClass}
				railFavorites={favoriteAuthors}
				railItems={railItems}
				selectedModel={selectedModel}
				sort={sort}
				statesById={routedStatesById}
				systemInfo={systemInfo}
				trigger={effectiveTrigger}
				value={value}
				visibleModelCount={visibleModelCount}
			/>
			<DeleteQuantConfirmDialog
				onCancel={() => setPendingDelete(null)}
				onConfirm={handleConfirmDelete}
				pending={pendingDelete}
			/>
		</>
	);
}
