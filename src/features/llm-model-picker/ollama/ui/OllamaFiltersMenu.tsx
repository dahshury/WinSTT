"use client";

import {
	Atom01Icon,
	CheckmarkCircle02Icon,
	CpuIcon,
	HardDriveIcon,
	SparklesIcon,
	TextFontIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import {
	FilterMenu,
	type FilterFlagConfig,
} from "@/shared/ui/model-picker/ui/FilterPopoverParts";
import {
	EMPTY_OLLAMA_FILTER_STATE,
	type OllamaFilterFlag,
	type OllamaFilterState,
	ollamaActiveFilterCount,
} from "../lib/filter-state";
import {
	OLLAMA_SORT_CHIP_LABEL,
	OLLAMA_SORT_KEYS,
	type OllamaSortKey,
	type OllamaSortValue,
} from "../lib/sort-state";

export interface OllamaFiltersMenuProps {
	filters: OllamaFilterState;
	onFiltersChange: (next: OllamaFilterState) => void;
	onSortChange: (next: OllamaSortValue) => void;
	/** When false, the "Fits hardware" filter is hidden because the host gave no
	 *  system-fit data to evaluate it against. */
	showHardwareFilter: boolean;
	/** Whether the host wired a Suggested verdict — hides the (inert)
	 *  "Suggested" checkbox when there is nothing to filter by. Mirrors
	 *  `showHardwareFilter` and the STT menu's `showSuggestedFilter`. */
	showSuggestedFilter?: boolean | undefined;
	/** Active global sort key, or ``null`` for the default grouped view. */
	sort: OllamaSortValue;
}

/** Icon per sort dimension — kept in the UI layer so {@link OLLAMA_SORT_KEYS}
 *  (the lib) stays presentation-free. */
const SORT_ICON: Record<OllamaSortKey, IconSvgElement> = {
	name: TextFontIcon,
	size: HardDriveIcon,
	params: Atom01Icon,
};

const FILTER_FLAGS: readonly FilterFlagConfig<OllamaFilterFlag>[] = [
	{ key: "suggestedOnly", icon: SparklesIcon, label: "Suggested" },
	{
		key: "installedOnly",
		icon: CheckmarkCircle02Icon,
		label: "Installed only",
	},
	{ key: "fitsHardwareOnly", icon: CpuIcon, label: "Fits hardware" },
];

/**
 * Sort + filter menu for the Ollama picker — a count-badged button opening a
 * Popover with the Sort chips and the boolean catalog filters. Ports the
 * {@link import("@/features/select-local-stt-model/ui/SttFiltersMenu").SttFiltersMenu}
 * shape; the
 * trigger badge folds the active filters and the active sort into one count.
 */
export function OllamaFiltersMenu({
	filters,
	onFiltersChange,
	onSortChange,
	showHardwareFilter,
	showSuggestedFilter = false,
	sort,
}: OllamaFiltersMenuProps) {
	const t = useTranslations("modelPicker");
	// Only render the flags the host can actually evaluate, so a stale
	// `fitsHardwareOnly` / `suggestedOnly` from a host without the backing data
	// neither shows nor counts.
	const flags = FILTER_FLAGS.filter(
		(flag) =>
			(showHardwareFilter || flag.key !== "fitsHardwareOnly") &&
			(showSuggestedFilter || flag.key !== "suggestedOnly"),
	);
	// `suggestedOnly` is excluded from the count inside `ollamaActiveFilterCount`
	// (default-ON flags must not permanently badge the trigger).
	const activeFilters = ollamaActiveFilterCount(
		filters,
		flags.map((flag) => flag.key),
	);

	return (
		<FilterMenu
			activeFilterCount={activeFilters}
			clearLabel={t("clearAll")}
			dataSlot="ollama-filters-menu-content"
			filters={filters}
			flags={flags}
			label={t("sortAndFilter")}
			onClearAll={() => {
				onFiltersChange(EMPTY_OLLAMA_FILTER_STATE);
				onSortChange(null);
			}}
			onToggleFlag={(flag) =>
				onFiltersChange({ ...filters, [flag]: !filters[flag] })
			}
			sort={{
				hint: t("flattenInstalled"),
				icons: SORT_ICON,
				keys: OLLAMA_SORT_KEYS,
				labels: OLLAMA_SORT_CHIP_LABEL,
				onChange: onSortChange,
				sortByLabel: t("sortBy"),
				value: sort,
			}}
			widthClass="w-[260px]"
		/>
	);
}
