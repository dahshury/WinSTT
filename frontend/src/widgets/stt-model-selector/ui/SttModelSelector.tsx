"use client";

import { Combobox } from "@base-ui/react/combobox";
import { useState } from "react";
import type { ModelInfo } from "@/entities/model-catalog";
import type { ModelStateEntry, SystemInfoEntry } from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";
import { Spinner } from "@/shared/ui/spinner";
import { groupModelsByAuthor } from "../lib/family-helpers";
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
	isLoading?: boolean;
	models: readonly ModelInfo[];
	onChange: SttModelChange;
	placeholder?: string;
	/** Optional pre-filter applied before any user filter (e.g., realtime-only picker). */
	prefilter?: (model: ModelInfo) => boolean;
	statesById: Record<string, ModelStateEntry>;
	systemInfo: SystemInfoEntry | null;
	value: string;
}

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
	return `${model.displayName} ${model.id} ${model.family} ${model.sizeLabel}`
		.toLowerCase()
		.includes(q);
}

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
}: SttModelSelectorProps) {
	const [open, setOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [filters, setFilters] = useState<SttFilterState>(EMPTY_FILTER_STATE);

	const baseModels = applyPrefilter(models, prefilter);
	// Menu filters (cached / realtime / language / hardware) prune the items;
	// the text query is handled by Base UI's `filter` so groups + keyboard nav
	// stay consistent with the official Combobox behaviour.
	const menuFilteredModels = filterSttModels(baseModels, {
		statesById,
		systemInfo,
		filters,
		searchQuery: "",
	});
	const groups = groupModelsByAuthor(menuFilteredModels);
	const selectedModel = baseModels.find((m) => m.id === value) ?? null;
	const selectedState = statesById[value];
	const filtersActive = hasActiveFilters(filters) || searchQuery.trim() !== "";
	const availableLanguages = collectFilterableLanguages(baseModels);

	const handleSelect = (modelId: string, quantization?: OnnxQuantization) => {
		onChange(modelId, quantization);
		setOpen(false);
		setSearchQuery("");
		setFilters(EMPTY_FILTER_STATE);
	};

	const handleValueChange = (next: ModelInfo | null) => {
		// Choosing the card itself selects the model at its default precision.
		if (next) {
			handleSelect(next.id);
		}
	};

	return (
		<div className="flex flex-col gap-2" data-slot="stt-model-selector">
			<Combobox.Root
				filter={(item: ModelInfo, query: string) => matchesQuery(item, query)}
				inputValue={searchQuery}
				isItemEqualToValue={(a: ModelInfo | null, b: ModelInfo | null) => a?.id === b?.id}
				items={groups}
				itemToStringLabel={(item: ModelInfo | null) => item?.displayName ?? ""}
				modal={false}
				onInputValueChange={setSearchQuery}
				onOpenChange={setOpen}
				onValueChange={handleValueChange}
				open={open}
				value={selectedModel}
			>
				<SttModelSelectorTrigger
					currentQuantization={currentQuantization}
					disabled={disabled || isLoading}
					open={open}
					placeholder={placeholder}
					selectedModel={selectedModel ?? undefined}
					state={selectedState}
				/>
				<Combobox.Portal>
					<Combobox.Positioner align="start" sideOffset={4}>
						<Combobox.Popup className="select-popup z-[200] flex h-[min(620px,var(--available-height))] w-[max(520px,var(--anchor-width))] max-w-[calc(100vw-32px)] origin-(--transform-origin) flex-col overflow-hidden rounded-md border border-border bg-surface-elevated p-0 shadow-md transition-[transform,opacity] duration-150 ease-out data-[ending-style]:ease-in">
							<div className="flex flex-col gap-2 border-border/50 border-b p-2">
								<div className="relative flex w-full items-center gap-2">
									<Combobox.Input
										className="h-9 flex-1 rounded-sm border border-border bg-surface-tertiary px-3 font-inherit text-body text-foreground leading-normal outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
										dir="ltr"
										placeholder="Search transcription models"
									/>
									{isLoading ? (
										<Spinner className="absolute end-[120px] size-4 text-foreground-muted" />
									) : null}
									<SttFiltersMenu
										availableLanguages={availableLanguages}
										filters={filters}
										onFiltersChange={setFilters}
									/>
								</div>
							</div>
							<SttModelList
								currentQuantization={currentQuantization}
								hasActiveFilters={filtersActive}
								onSelect={handleSelect}
								selectedId={value}
								statesById={statesById}
								systemInfo={systemInfo}
							/>
						</Combobox.Popup>
					</Combobox.Positioner>
				</Combobox.Portal>
			</Combobox.Root>
		</div>
	);
}
