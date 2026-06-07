"use client";

import type { ReactNode } from "react";
import type { ModelInfo } from "@/entities/model-catalog";
import type {
	FitAssessmentEntry,
	ModelStateEntry,
	SystemInfoEntry,
} from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";
import { GroupRail, type GroupRailItem } from "../../core/GroupRail";
import { ModelPicker } from "../../core/ModelPicker";
import type { SttFilterState } from "../lib/filter-state";
import type { SttSortValue } from "../lib/sort-state";
import { backingModelIdForQuant } from "../lib/streaming-precision-merge";
import { SttFiltersMenu } from "./SttFiltersMenu";
import type { LockedSttFilterFlag } from "./SttFiltersMenu";
import type {
	QuantDownloadAction,
	QuantDownloadSnapshot,
} from "./SttModelCard";
import { SttModelList } from "./SttModelList";
import { SttModelSelectorTrigger } from "./SttModelSelectorTrigger";

type SttModelChange = (
	modelId: string,
	quantization?: OnnxQuantization,
) => void;

export interface SttModelSelectorViewProps {
	activeRailId: string | null;
	availableLanguages: string[];
	baseModels: readonly ModelInfo[];
	currentQuantization: OnnxQuantization;
	disabled: boolean;
	downloadProgress: { modelId: string; percent: number | null } | null;
	expandedBundles: Set<string>;
	filter: (model: ModelInfo, query: string) => boolean;
	filters: SttFilterState;
	filtersActive: boolean;
	groups: readonly { value: string; items: readonly ModelInfo[] }[];
	handleOpenChange: (next: boolean, eventDetails?: unknown) => void;
	handleRailClick: (id: string) => void;
	handleSelect: SttModelChange;
	inline: boolean;
	isFavorite: (modelId: string) => boolean;
	isLoading: boolean;
	kind: "main" | "realtime";
	lockedFilterKeys?: readonly LockedSttFilterFlag[] | undefined;
	onDownloadAction?:
		| ((
				action: QuantDownloadAction,
				modelId: string,
				quantization: OnnxQuantization,
		  ) => void)
		| undefined;
	onDownloadSnapshot?:
		| ((
				modelId: string,
				quantization: OnnxQuantization,
		  ) => QuantDownloadSnapshot | undefined)
		| undefined;
	getFitAssessment?:
		| ((modelId: string) => FitAssessmentEntry | null)
		| undefined;
	onFiltersChange: (next: SttFilterState) => void;
	onRequestDelete?:
		| ((
				modelId: string,
				quantization: OnnxQuantization,
				displayName: string,
				quantLabel: string,
		  ) => void)
		| undefined;
	canDeleteQuant?:
		| ((modelId: string, quantization: OnnxQuantization) => boolean)
		| undefined;
	onSortChange: (next: SttSortValue) => void;
	onToggleExpanded: (baseId: string) => void;
	onToggleFavorite: (modelId: string) => void;
	open: boolean;
	placeholder: string;
	popupHeightClass: string;
	popupRef: (node: HTMLElement | null) => void;
	popupWidthClass: string;
	onToggleRailFavorite?: ((id: string) => void) | undefined;
	railFavorites?: readonly string[] | undefined;
	railItems: readonly GroupRailItem[];
	selectedModel: ModelInfo | null;
	sort: SttSortValue;
	statesById: Record<string, ModelStateEntry>;
	systemInfo: SystemInfoEntry | null;
	trigger?: ReactNode;
	value: string;
	visibleModelCount: number;
}

/**
 * Presentation half of `SttModelSelector`. Holds zero state — the parent
 * owns the reducer and refs and passes everything in as props. Extracted
 * to keep the parent component small enough to satisfy
 * `react-doctor/no-giant-component`.
 */
export function SttModelSelectorView(
	props: SttModelSelectorViewProps,
): ReactNode {
	const {
		activeRailId,
		availableLanguages,
		baseModels,
		currentQuantization,
		disabled,
		downloadProgress,
		expandedBundles,
		filters,
		filtersActive,
		filter,
		groups,
		handleOpenChange,
		handleRailClick,
		handleSelect,
		inline,
		isFavorite,
		isLoading,
		kind,
		lockedFilterKeys,
		onDownloadAction,
		onDownloadSnapshot,
		getFitAssessment,
		onFiltersChange,
		onSortChange,
		onRequestDelete,
		canDeleteQuant,
		onToggleExpanded,
		onToggleFavorite,
		open,
		placeholder,
		popupHeightClass,
		popupRef,
		popupWidthClass,
		onToggleRailFavorite,
		railFavorites,
		railItems,
		selectedModel,
		sort,
		statesById,
		systemInfo,
		trigger,
		value,
		visibleModelCount,
	} = props;
	return (
		<ModelPicker<ModelInfo, ModelInfo | null>
			disabled={disabled || isLoading}
			filter={filter}
			filtersMenuSlot={
				<SttFiltersMenu
					availableLanguages={availableLanguages}
					filters={filters}
					lockedFilterKeys={lockedFilterKeys}
					onFiltersChange={onFiltersChange}
					onSortChange={onSortChange}
					sort={sort}
				/>
			}
			inline={inline}
			isItemEqualToValue={(a, b) => a?.id === b?.id}
			isLoading={isLoading}
			// Base UI's Combobox.Root accepts the grouped ``{value, items}[]``
			// shape (see ``AriaCombobox.d.ts`` overload #1). ModelPicker types
			// this through as ``readonly unknown[]`` so the typed AuthorGroup
			// array assigns directly via covariance — no cast needed.
			items={groups}
			itemToStringLabel={(item) => item?.displayName ?? ""}
			list={
				<SttModelList
					currentQuantization={currentQuantization}
					expandedBundles={expandedBundles}
					getDownloadSnapshot={onDownloadSnapshot}
					getFitAssessment={getFitAssessment}
					hasActiveFilters={filtersActive}
					isFavorite={isFavorite}
					canDeleteQuant={canDeleteQuant}
					onDownloadAction={onDownloadAction}
					onRequestDeleteQuant={onRequestDelete}
					onSelect={handleSelect}
					onToggleExpanded={onToggleExpanded}
					onToggleFavorite={onToggleFavorite}
					selectedId={value}
					sortKey={sort}
					statesById={statesById}
					systemInfo={systemInfo}
					visibleModelCount={visibleModelCount}
				/>
			}
			onOpenChange={handleOpenChange}
			onValueChange={(next) => {
				// Clicking the CARD BODY (anywhere that is NOT a precision badge — the
				// badges ``stopPropagation`` so they never reach here) means "use the
				// RECOMMENDED precision for this model". We send the backend's
				// RAM/VRAM-aware pick — the model state's ``effective_quantization``,
				// the badge marked "Recommended" — as a CONCRETE selection, exactly as
				// if the user had clicked that badge. Falls back to "" (fp32) only when
				// the model's state hasn't loaded yet. The per-badge clicks remain the
				// explicit accuracy/speed/size router. Broken custom-model entries
				// (``available=false``) are guarded — the user clicked a greyed-out row
				// to read the tooltip, not to load broken weights.
				if (next && next.available !== false) {
					const recommended = statesById[next.id]?.effective_quantization;
					const quantization = (recommended ?? "") as OnnxQuantization;
					handleSelect(
						backingModelIdForQuant(next, quantization),
						quantization,
					);
				}
			}}
			open={open}
			popupHeightClass={popupHeightClass}
			popupRef={popupRef}
			popupWidthClass={popupWidthClass}
			searchPlaceholder="Search transcription models"
			selectedItemKey={selectedModel?.id || value || undefined}
			sidebarSlot={
				railItems.length > 1 ? (
					<GroupRail
						activeId={activeRailId}
						favorites={railFavorites}
						items={railItems}
						onClick={handleRailClick}
						onToggleFavorite={onToggleRailFavorite}
					/>
				) : undefined
			}
			trigger={
				inline
					? undefined
					: (trigger ?? (
							<SttModelSelectorTrigger
								catalog={baseModels}
								disabled={disabled || isLoading}
								downloadProgress={downloadProgress}
								kind={kind}
								open={open}
								placeholder={placeholder}
								selectedModel={selectedModel ?? undefined}
							/>
						))
			}
			value={selectedModel}
		/>
	);
}
