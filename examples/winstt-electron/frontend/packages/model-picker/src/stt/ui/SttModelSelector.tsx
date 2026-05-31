"use client";

import { StarIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useReducer, useRef, useState } from "react";
import type { ModelInfo } from "@/entities/model-catalog";
import type { ModelStateEntry, SystemInfoEntry } from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";
import { RailIconChip, type GroupRailItem } from "../../core/GroupRail";
import { useFavoriteSet } from "../../core/use-favorite-set";
import { useRailScrollSpy } from "../../core/use-rail-scroll-spy";
import { extractCloseReason } from "../../lib/combobox-reasons";
import {
	applyCloseWith,
	isInsideMenuPopup,
} from "../../lib/openrouter-model-selector-test-helpers";
import { publicAsset } from "../../lib/public-asset";
import { useModelSelectorClickTracking } from "../../lib/use-model-selector-click-tracking";
import { STT_PICKER_WIDTH_CLASS } from "../lib/dimensions";
import {
	buildModelSearchCorpus,
	FAVORITES_GROUP_VALUE,
	type FamilyKey,
	getAuthorLabel,
	getBaseId,
	getFamilyConfig,
	groupModelsByAuthor,
	isFavoritesGroup,
	isSortedGroup,
	SORTED_GROUP_VALUE,
	type SttListGroup,
	withFavoritesGroup,
} from "../lib/family-helpers";
import { collectFilterableLanguages, filterSttModels, hasActiveFilters } from "../lib/filter-state";
import { sortSttModels } from "../lib/sort-state";
import { useFavoriteSttModels } from "../lib/use-favorite-stt-models";
import { DeleteQuantConfirmDialog, type PendingDelete } from "./DeleteQuantConfirmDialog";
import { SttModelSelectorTriggerButton } from "./SttModelSelectorTrigger";
import { SttModelSelectorView } from "./SttModelSelectorView";
import { createInitialUiState, sttSelectorUiReducer } from "./stt-selector-ui-state";

type SttModelChange = (modelId: string, quantization?: OnnxQuantization) => void;

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
	/** Per-quant download action — start / pause / resume / cancel. The
	 *  consumer wires these to ``useDownloadStore`` actions. */
	onDownloadAction?: (
		action: import("./SttModelCard").QuantDownloadAction,
		modelId: string,
		quantization: OnnxQuantization
	) => void;
	/** Per-quant download snapshot lookup (active downloads only). */
	onDownloadSnapshot?: (
		modelId: string,
		quantization: OnnxQuantization
	) => import("./SttModelCard").QuantDownloadSnapshot | undefined;
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

function applyPrefilter(
	models: readonly ModelInfo[],
	prefilter: ((m: ModelInfo) => boolean) | undefined
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

function buildRailItems(groups: readonly SttListGroup[]): GroupRailItem[] {
	const items: GroupRailItem[] = [];
	for (const group of groups) {
		// The flat sorted column has no maker rail tile.
		if (isSortedGroup(group.value)) {
			continue;
		}
		// The Favorites tile is maker-agnostic — a star instead of a brand logo,
		// jumping to the synthetic group pinned at the top of the list.
		if (isFavoritesGroup(group.value)) {
			items.push({
				id: FAVORITES_GROUP_VALUE,
				label: "Favorites",
				pinned: true,
				badge: group.items.length,
				icon: (
					<RailIconChip tone="favorite">
						<HugeiconsIcon className="size-3 fill-amber-400" icon={StarIcon} />
					</RailIconChip>
				),
			});
			continue;
		}
		const family: FamilyKey = group.value;
		const cfg = getFamilyConfig(family);
		items.push({
			id: family,
			label: `${getAuthorLabel(family)} · ${cfg.label}`,
			badge: group.items.length,
			icon: cfg.logoSrc ? (
				<img
					alt=""
					className="size-5 rounded-[3px] object-cover"
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
	onDownloadAction,
	onDownloadSnapshot,
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
	const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
	const handleRequestDelete = onDeleteQuant
		? (
				modelId: string,
				quantization: OnnxQuantization,
				displayName: string,
				quantLabel: string
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
	const { favorites: favoriteAuthors, toggleFavorite: toggleAuthorFavorite } = useFavoriteSet(
		"winstt:stt-favorite-authors"
	);

	const baseModels = applyPrefilter(models, prefilter);
	const selectedModel = baseModels.find((m) => m.id === value) ?? null;
	const selectedFamily: FamilyKey | null = selectedModel?.family ?? null;
	const selectedBaseId = selectedModel === null ? null : getBaseId(selectedModel.id);

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
			onActivate={(event) => onOpenDetached?.(event.currentTarget.getBoundingClientRect())}
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
	const [uiState, dispatch] = useReducer(sttSelectorUiReducer, undefined, () =>
		createInitialUiState(selectedFamily, selectedBaseId)
	);
	const { filters, sort, activeRailId, expandedBundles, open } = uiState;

	// Menu filters (cached / realtime / language / hardware) prune the items
	// before the picker sees them; the text query is then handled by Base
	// UI's `filter` (via the shell) so groups + keyboard nav stay consistent.
	const menuFilteredModels = filterSttModels(baseModels, {
		statesById,
		systemInfo,
		filters,
		searchQuery: "",
	});
	// Two list shapes:
	//   • Default (no sort): the synthetic Favorites group (starred models,
	//     maker-sorted + deduped, REPEATED not moved) ahead of the per-maker
	//     groups, with the maker rail on the side.
	//   • Sorted: every surviving model flattened into ONE globally-sorted
	//     column (rail suppressed below) so "fastest / smallest / most-accurate
	//     overall" reads top-to-bottom instead of being split per maker.
	const groups: SttListGroup[] =
		sort === null
			? withFavoritesGroup(groupModelsByAuthor(menuFilteredModels), isFavorite)
			: [{ value: SORTED_GROUP_VALUE, items: sortSttModels(menuFilteredModels, sort) }];
	const filtersActive = hasActiveFilters(filters);
	const availableLanguages = collectFilterableLanguages(baseModels);

	// Shared rail: one tile per family. Suppressed while a global sort flattens
	// the list — a single column has no maker sections to jump between.
	const railItems: GroupRailItem[] = sort === null ? buildRailItems(groups) : [];
	// Re-sync the active rail tile to the selection's family during render
	// whenever it changes, while still letting a user rail click override
	// it until the selection moves again. The prev-value tracker is a ref
	// (never read in JSX) so the resync doesn't schedule an extra render —
	// see https://react.dev/learn/you-might-not-need-an-effect
	const prevSelectedFamilyRef = useRef(selectedFamily);
	if (prevSelectedFamilyRef.current !== selectedFamily) {
		prevSelectedFamilyRef.current = selectedFamily;
		dispatch({ type: "setActiveRailId", id: selectedFamily });
	}

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

	// Scope rail-section queries to THIS picker's popup so two STT pickers
	// in the same window (e.g. main + realtime model in ModelSettingsPanel)
	// can't fight for the same DOM matches.
	const popupRef = useRef<HTMLElement | null>(null);
	// Controlled-open + click-tracking, mirroring the OpenRouter picker.
	// Without this, the filter Popover's portaled content is treated as
	// "outside" by Base UI's combobox dismiss logic, so the first click on
	// any filter row collapses the whole picker. ``lastClickTargetRef`` is
	// updated on every pointerdown at the capture phase; on close attempts
	// we ask "was that click inside one of our friendly popups?" — if yes,
	// we veto the close. The reason guard lets ``item-press`` (a legit
	// model selection) close the picker even though that click lands
	// inside the popup, while ``outside-press`` from a filter row gets
	// intercepted.
	const lastClickTargetRef = useModelSelectorClickTracking();
	const handleOpenChange = (next: boolean, eventDetails?: unknown) => {
		if (externalOpen) {
			return;
		}
		if (next) {
			dispatch({ type: "setOpen", open: true });
			return;
		}
		applyCloseWith(
			extractCloseReason(eventDetails),
			"item-press",
			isInsideMenuPopup(lastClickTargetRef.current, popupRef.current),
			(nextOpen) => dispatch({ type: "setOpen", open: nextOpen })
		);
	};
	const railSpy = useRailScrollSpy({
		scrollContainerSelector: '[data-slot="stt-model-list"]',
		onActiveChange: (id) => dispatch({ type: "setActiveRailId", id }),
	});
	const handleRailClick = (id: string) => {
		railSpy.suppress();
		dispatch({ type: "setActiveRailId", id });
		const root: ParentNode = popupRef.current ?? document;
		const target = root.querySelector<HTMLElement>(`[data-rail-section="${CSS.escape(id)}"]`);
		target?.scrollIntoView({ block: "start", behavior: "smooth" });
	};

	const handleSelect = (modelId: string, quantization?: OnnxQuantization) => {
		onChange(modelId, quantization);
		// Reset our local filter state on selection so the next open starts
		// fresh — the shell takes care of clearing the search query.
		dispatch({ type: "resetFilters" });
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
				filters={filters}
				filtersActive={filtersActive}
				groups={groups}
				handleOpenChange={handleOpenChange}
				handleRailClick={handleRailClick}
				handleSelect={handleSelect}
				inline={inline}
				isFavorite={isFavorite}
				isLoading={isLoading}
				kind={kind}
				menuFilteredModels={menuFilteredModels}
				onDownloadAction={onDownloadAction}
				onDownloadSnapshot={onDownloadSnapshot}
				onFiltersChange={(next) => dispatch({ type: "setFilters", filters: next })}
				onRequestDelete={handleRequestDelete}
				onSortChange={(next) => dispatch({ type: "setSort", sort: next })}
				onToggleExpanded={handleToggleExpanded}
				onToggleFavorite={toggleFavorite}
					onToggleRailFavorite={toggleAuthorFavorite}
				open={externalOpen ? false : open}
				placeholder={placeholder}
				popupHeightClass={popupHeightClass}
				popupRef={(node) => {
					popupRef.current = node;
					railSpy.attach(node);
				}}
				popupWidthClass={popupWidthClass}
				railFavorites={favoriteAuthors}
					railItems={railItems}
				selectedModel={selectedModel}
				sort={sort}
				statesById={statesById}
				systemInfo={systemInfo}
				trigger={effectiveTrigger}
				value={value}
			/>
			<DeleteQuantConfirmDialog
				onCancel={() => setPendingDelete(null)}
				onConfirm={handleConfirmDelete}
				pending={pendingDelete}
			/>
		</>
	);
}
