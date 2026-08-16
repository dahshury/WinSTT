"use client";

import {
	ArrowUpDownIcon,
	Atom01Icon,
	CheckmarkCircle02Icon,
	CpuIcon,
	FilterIcon,
	HardDriveIcon,
	SparklesIcon,
	TextFontIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import { FilterCheckboxSection } from "@/shared/ui/model-picker/ui/FilterCheckboxSection";
import {
	FilterNavMenu,
	type FilterNavSection,
} from "@/shared/ui/model-picker/ui/FilterNavMenu";
import { SortChipsSection } from "@/shared/ui/model-picker/ui/FilterSortChipsSection";
import type { FilterFlagConfig } from "@/shared/ui/model-picker/ui/filter-menu-types";
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
 * Sort + filter menu for the Ollama picker — the shared drill-down menu with
 * two rows: Sort by, and the boolean catalog filters. The leanest of the four
 * menus, and the reason the root list is worth having anyway: it presents the
 * same way as the nine-dimension TTS menu next to it.
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

	const sections: FilterNavSection[] = [
		{
			icon: ArrowUpDownIcon,
			id: "sort",
			label: t("sortBy"),
			render: () => (
				<SortChipsSection
					hint={t("flattenInstalled")}
					icons={SORT_ICON}
					keys={OLLAMA_SORT_KEYS}
					labels={OLLAMA_SORT_CHIP_LABEL}
					onChange={onSortChange}
					value={sort}
				/>
			),
			value: sort === null ? null : OLLAMA_SORT_CHIP_LABEL[sort],
		},
		{
			badge: flags.filter((flag) => filters[flag.key]).length,
			icon: FilterIcon,
			id: "flags",
			label: t("filters"),
			render: () => (
				<FilterCheckboxSection
					filters={filters}
					flags={flags}
					onToggle={(flag) =>
						onFiltersChange({ ...filters, [flag]: !filters[flag] })
					}
				/>
			),
		},
	];

	return (
		<FilterNavMenu
			activeFilterCount={activeFilters + (sort === null ? 0 : 1)}
			canClear={activeFilters > 0 || sort !== null}
			clearLabel={t("clearAll")}
			dataSlot="ollama-filters-menu-content"
			label={t("sortAndFilter")}
			onClearAll={() => {
				onFiltersChange(EMPTY_OLLAMA_FILTER_STATE);
				onSortChange(null);
			}}
			sections={sections}
			widthPx={280}
		/>
	);
}
