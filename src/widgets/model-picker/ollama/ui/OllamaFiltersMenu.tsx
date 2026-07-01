"use client";

import {
	Atom01Icon,
	CheckmarkCircle02Icon,
	CpuIcon,
	HardDriveIcon,
	TextFontIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import {
	FilterCheckboxSection,
	FilterMenuPopover,
	SectionDivider,
	SortChipsSection,
	type FilterFlagConfig,
} from "../../ui/FilterPopoverParts";
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

const FILTER_FLAGS: ReadonlyArray<FilterFlagConfig<OllamaFilterFlag>> = [
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
 * {@link import("../../stt/ui/SttFiltersMenu").SttFiltersMenu} shape; the
 * trigger badge folds the active filters and the active sort into one count.
 */
export function OllamaFiltersMenu({
	filters,
	onFiltersChange,
	onSortChange,
	showHardwareFilter,
	sort,
}: OllamaFiltersMenuProps) {
	const t = useTranslations("modelPicker");
	// Only render the flags the host can actually evaluate, so a stale
	// `fitsHardwareOnly` from a host without fit data neither shows nor counts.
	const flags = showHardwareFilter
		? FILTER_FLAGS
		: FILTER_FLAGS.filter((flag) => flag.key !== "fitsHardwareOnly");
	const activeFilters = ollamaActiveFilterCount(
		filters,
		flags.map((flag) => flag.key),
	);
	const count = activeFilters + (sort === null ? 0 : 1);
	const canClear = activeFilters > 0 || sort !== null;
	const clear = () => {
		onFiltersChange(EMPTY_OLLAMA_FILTER_STATE);
		onSortChange(null);
	};

	return (
		<FilterMenuPopover
			canClear={canClear}
			clearLabel={t("clearAll")}
			count={count}
			dataSlot="ollama-filters-menu-content"
			label={t("sortAndFilter")}
			onClear={clear}
			widthClass="w-[260px]"
		>
			<SortChipsSection
				hint={t("flattenInstalled")}
				icons={SORT_ICON}
				keys={OLLAMA_SORT_KEYS}
				labels={OLLAMA_SORT_CHIP_LABEL}
				onChange={onSortChange}
				sortByLabel={t("sortBy")}
				value={sort}
			/>
			<SectionDivider />
			<FilterCheckboxSection
				filters={filters}
				flags={flags}
				onToggle={(flag) =>
					onFiltersChange({ ...filters, [flag]: !filters[flag] })
				}
			/>
		</FilterMenuPopover>
	);
}
