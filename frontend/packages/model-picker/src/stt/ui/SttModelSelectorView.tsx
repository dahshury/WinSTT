"use client";

import type { ReactNode } from "react";
import type { ModelInfo } from "@/entities/model-catalog";
import type { ModelStateEntry, SystemInfoEntry } from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";
import { GroupRail, type GroupRailItem } from "../../core/GroupRail";
import { ModelPicker } from "../../core/ModelPicker";
import type { SttFilterState } from "../lib/filter-state";
import { SttFiltersMenu } from "./SttFiltersMenu";
import { SttModelList } from "./SttModelList";
import { SttModelSelectorTrigger } from "./SttModelSelectorTrigger";

type SttModelChange = (modelId: string, quantization?: OnnxQuantization) => void;

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
	isLoading: boolean;
	kind: "main" | "realtime";
	menuFilteredModels: readonly ModelInfo[];
	onFiltersChange: (next: SttFilterState) => void;
	onRequestDelete?:
		| ((
				modelId: string,
				quantization: OnnxQuantization,
				displayName: string,
				quantLabel: string
		  ) => void)
		| undefined;
	onToggleExpanded: (baseId: string) => void;
	open: boolean;
	placeholder: string;
	popupHeightClass: string;
	popupRef: (node: HTMLElement | null) => void;
	popupWidthClass: string;
	railItems: readonly GroupRailItem[];
	selectedModel: ModelInfo | null;
	statesById: Record<string, ModelStateEntry>;
	systemInfo: SystemInfoEntry | null;
	trigger?: ReactNode;
	value: string;
}

/**
 * Presentation half of `SttModelSelector`. Holds zero state — the parent
 * owns the reducer and refs and passes everything in as props. Extracted
 * to keep the parent component small enough to satisfy
 * `react-doctor/no-giant-component`.
 */
export function SttModelSelectorView(props: SttModelSelectorViewProps): ReactNode {
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
		isLoading,
		kind,
		menuFilteredModels,
		onFiltersChange,
		onRequestDelete,
		onToggleExpanded,
		open,
		placeholder,
		popupHeightClass,
		popupRef,
		popupWidthClass,
		railItems,
		selectedModel,
		statesById,
		systemInfo,
		trigger,
		value,
	} = props;
	return (
		<ModelPicker<ModelInfo, ModelInfo | null>
			disabled={disabled || isLoading}
			filter={filter}
			filtersMenuSlot={
				<SttFiltersMenu
					availableLanguages={availableLanguages}
					filters={filters}
					onFiltersChange={onFiltersChange}
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
					hasActiveFilters={filtersActive}
					onRequestDeleteQuant={onRequestDelete}
					onSelect={handleSelect}
					onToggleExpanded={onToggleExpanded}
					selectedId={value}
					statesById={statesById}
					systemInfo={systemInfo}
					visibleModelCount={menuFilteredModels.length}
				/>
			}
			onOpenChange={handleOpenChange}
			onValueChange={(next) => {
				// Choosing the card itself selects the model at its default precision.
				// Broken custom-model entries (``available=false``) are guarded
				// against here — the user clicked a greyed-out row to read the
				// tooltip, not to actually load broken weights.
				if (next && next.available !== false) {
					// If the user's current quantization isn't published by the
					// target model (e.g. switching from a NeMo model on int8 to
					// Cohere which only ships ["", "q4"]), carrying the old
					// quant through would have the server resolve to fp32 with
					// a warning AND still trip the picker's STARTUP_ONLY
					// restart path inconsistently. Explicitly pick a quant the
					// target model actually publishes — preferring the first
					// in the catalog's order, which the refresh script puts in
					// "default-then-smaller" order so we usually land on fp32.
					const supportsCurrent = next.availableQuantizations.includes(currentQuantization);
					const fallback = supportsCurrent
						? undefined
						: ((next.availableQuantizations[0] ?? "") as OnnxQuantization);
					handleSelect(next.id, fallback);
				}
			}}
			open={open}
			popupHeightClass={popupHeightClass}
			popupRef={popupRef}
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
