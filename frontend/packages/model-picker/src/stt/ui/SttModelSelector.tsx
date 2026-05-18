"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useMemo, useRef, useState } from "react";
import type { ModelInfo } from "@/entities/model-catalog";
import type { ModelStateEntry, SystemInfoEntry } from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";
import { GroupRail, type GroupRailItem } from "../../core/GroupRail";
import { ModelPicker } from "../../core/ModelPicker";
import { useRailScrollSpy } from "../../core/use-rail-scroll-spy";
import {
	buildModelSearchCorpus,
	type FamilyKey,
	getAuthorLabel,
	getFamilyConfig,
	groupModelsByAuthor,
} from "../lib/family-helpers";
import {
	collectFilterableLanguages,
	EMPTY_FILTER_STATE,
	filterSttModels,
	hasActiveFilters,
	type SttFilterState,
} from "../lib/filter-state";
import { SttFiltersMenu } from "./SttFiltersMenu";
import { SttModelList } from "./SttModelList";
import { SttModelSelectorTrigger } from "./SttModelSelectorTrigger";

export type SttModelChange = (modelId: string, quantization?: OnnxQuantization) => void;

export interface SttModelSelectorProps {
	currentQuantization: OnnxQuantization;
	disabled?: boolean;
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
	placeholder?: string;
	/** Popup height class. Defaults to the roomy settings-panel height; the
	 *  footer chip overrides this with a compact one to fit the status bar. */
	popupHeightClass?: string;
	/** Popup width class. Defaults to the settings-panel width. */
	popupWidthClass?: string;
	/** Optional pre-filter applied before any user filter (e.g., realtime-only picker). */
	prefilter?: (model: ModelInfo) => boolean;
	statesById: Record<string, ModelStateEntry>;
	systemInfo: SystemInfoEntry | null;
	/** Replaces the default glass-card trigger. The footer passes a compact
	 *  chip here so the bar keeps its small footprint while the popup stays
	 *  the full picker. Must render a `Combobox.Trigger` internally. */
	trigger?: ReactNode;
	value: string;
}

const DEFAULT_STT_POPUP_HEIGHT = "h-[min(620px,var(--available-height))]";
const DEFAULT_STT_POPUP_WIDTH = "w-[max(580px,var(--anchor-width))]";

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

/**
 * Whisper / NeMo / GigaAM / Kaldi / Lite-Whisper / T-One transcription
 * picker. Composes the shared `ModelPicker` shell with an STT-specific
 * trigger (cache pill + quantization), a filters menu (language / hardware /
 * realtime / cached), and the grouped model list (per-row quantization
 * picker, hardware-fit warning, download progress pill).
 *
 * Filter state lives in this wrapper so the user's "cached only + Spanish"
 * choice survives across the popup's search clear; the shell auto-clears
 * only the search query on close (matching the OpenRouter + Ollama
 * behaviour).
 */
export function SttModelSelector({
	models,
	value,
	currentQuantization,
	onChange,
	statesById,
	systemInfo,
	disabled = false,
	isLoading = false,
	placeholder = "Select a model",
	prefilter,
	kind = "main",
	popupHeightClass = DEFAULT_STT_POPUP_HEIGHT,
	popupWidthClass = DEFAULT_STT_POPUP_WIDTH,
	trigger,
	inline = false,
}: SttModelSelectorProps) {
	const [filters, setFilters] = useState<SttFilterState>(EMPTY_FILTER_STATE);

	const baseModels = applyPrefilter(models, prefilter);
	// Menu filters (cached / realtime / language / hardware) prune the items
	// before the picker sees them; the text query is then handled by Base
	// UI's `filter` (via the shell) so groups + keyboard nav stay consistent.
	const menuFilteredModels = filterSttModels(baseModels, {
		statesById,
		systemInfo,
		filters,
		searchQuery: "",
	});
	const groups = groupModelsByAuthor(menuFilteredModels);
	const selectedModel = baseModels.find((m) => m.id === value) ?? null;
	const filtersActive = hasActiveFilters(filters);
	const availableLanguages = collectFilterableLanguages(baseModels);

	// Shared rail: one tile per family, with the family's branded icon and a
	// count badge. Same `GroupRail` component the OpenRouter + Ollama
	// pickers use — visual parity by construction, not by convention.
	const railItems: GroupRailItem[] = useMemo(
		() =>
			groups.map((group) => {
				const cfg = getFamilyConfig(group.value);
				return {
					id: group.value,
					label: `${getAuthorLabel(group.value)} · ${cfg.label}`,
					badge: group.items.length,
					icon: cfg.logoSrc ? (
						// biome-ignore lint/performance/noImgElement: tiny rail thumb, static local asset
						<img
							alt=""
							className="size-5 rounded-[3px] object-cover"
							height={20}
							src={cfg.logoSrc}
							width={20}
						/>
					) : (
						<span className={`flex size-5 items-center justify-center rounded ${cfg.chip}`}>
							<HugeiconsIcon className="size-3" icon={cfg.icon} />
						</span>
					),
				};
			}),
		[groups]
	);
	// Active rail tile = either the user's most recent rail click, or the
	// family of the currently-selected model (whichever happened last).
	// Re-syncs to the selection's family whenever the selected model
	// changes, so a fresh open of the picker always highlights the
	// currently-loaded model's family by default.
	const selectedFamily: FamilyKey | null = selectedModel?.family ?? null;
	const [activeRailId, setActiveRailId] = useState<FamilyKey | string | null>(selectedFamily);
	// Re-sync to the selection's family during render whenever it changes,
	// while still letting a user rail click override it until the selection
	// moves again. The prev-value tracker is a ref (never read in JSX) so the
	// resync doesn't schedule an extra render — see
	// https://react.dev/learn/you-might-not-need-an-effect
	const prevSelectedFamilyRef = useRef(selectedFamily);
	if (prevSelectedFamilyRef.current !== selectedFamily) {
		prevSelectedFamilyRef.current = selectedFamily;
		setActiveRailId(selectedFamily);
	}

	// Variant-bundle expansion (collapsible card mirroring the OpenRouter
	// selector's pattern). One ``Set<string>`` of base ids — pre-seeded with
	// the bundle that owns the currently-selected model so the user sees
	// their selection on first open even if it's an ``.en`` sibling.
	const initialExpanded = (): Set<string> => {
		if (selectedModel === null) {
			return new Set();
		}
		const base = selectedModel.id.endsWith(".en")
			? selectedModel.id.slice(0, -3)
			: selectedModel.id;
		return new Set([base]);
	};
	const [expandedBundles, setExpandedBundles] = useState<Set<string>>(initialExpanded);
	const handleToggleExpanded = (baseId: string) => {
		setExpandedBundles((prev) => {
			const next = new Set(prev);
			if (next.has(baseId)) {
				next.delete(baseId);
			} else {
				next.add(baseId);
			}
			return next;
		});
	};

	// Scope rail-section queries to THIS picker's popup so two STT pickers
	// in the same window (e.g. main + realtime model in ModelSettingsPanel)
	// can't fight for the same DOM matches.
	const popupRef = useRef<HTMLElement | null>(null);
	const [popupNode, setPopupNode] = useState<HTMLElement | null>(null);
	const railSpy = useRailScrollSpy({
		popupNode,
		scrollContainerSelector: '[data-slot="stt-model-list"]',
		onActiveChange: (id) => setActiveRailId(id),
	});
	const handleRailClick = (id: string) => {
		railSpy.suppress();
		setActiveRailId(id);
		const root: ParentNode = popupRef.current ?? document;
		const target = root.querySelector<HTMLElement>(`[data-rail-section="${CSS.escape(id)}"]`);
		target?.scrollIntoView({ block: "start", behavior: "smooth" });
	};

	const handleSelect = (modelId: string, quantization?: OnnxQuantization) => {
		onChange(modelId, quantization);
		// Reset our local filter state on selection so the next open starts
		// fresh — the shell takes care of clearing the search query.
		setFilters(EMPTY_FILTER_STATE);
	};

	return (
		<ModelPicker<ModelInfo, ModelInfo | null>
			disabled={disabled || isLoading}
			filter={matchesQuery}
			filtersMenuSlot={
				<SttFiltersMenu
					availableLanguages={availableLanguages}
					filters={filters}
					onFiltersChange={setFilters}
				/>
			}
			inline={inline}
			isItemEqualToValue={(a, b) => a?.id === b?.id}
			isLoading={isLoading}
			items={groups as never /* Base UI accepts the grouped {items,value} shape */}
			itemToStringLabel={(item) => item?.displayName ?? ""}
			list={
				<SttModelList
					currentQuantization={currentQuantization}
					expandedBundles={expandedBundles}
					hasActiveFilters={filtersActive}
					onSelect={handleSelect}
					onToggleExpanded={handleToggleExpanded}
					selectedId={value}
					statesById={statesById}
					systemInfo={systemInfo}
				/>
			}
			onValueChange={(next) => {
				// Choosing the card itself selects the model at its default precision.
				if (next) {
					handleSelect(next.id);
				}
			}}
			popupHeightClass={popupHeightClass}
			popupRef={(node) => {
				popupRef.current = node;
				setPopupNode(node);
			}}
			popupWidthClass={popupWidthClass}
			searchPlaceholder="Search transcription models"
			sidebarSlot={
				railItems.length > 1 ? (
					<GroupRail activeId={activeRailId} items={railItems} onClick={handleRailClick} />
				) : undefined
			}
			trigger={
				inline
					? undefined
					: (trigger ?? (
							<SttModelSelectorTrigger
								catalog={baseModels}
								disabled={disabled || isLoading}
								kind={kind}
								open={false /* shell owns open state; trigger uses Combobox.Trigger internally */}
								placeholder={placeholder}
								selectedModel={selectedModel ?? undefined}
							/>
						))
			}
			value={selectedModel}
		/>
	);
}
