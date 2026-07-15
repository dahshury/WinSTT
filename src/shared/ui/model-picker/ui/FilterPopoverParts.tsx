"use client";

import type { ReactNode } from "react";
import { FilterCheckboxSection } from "./FilterCheckboxSection";
import { FilterMenuPopover } from "./FilterMenuPopover";
import { SectionDivider } from "./FilterSectionDivider";
import { SortChipsSection } from "./FilterSortChipsSection";
import type { FilterFlagConfig, FilterSortConfig } from "./filter-menu-types";

export type { FilterFlagConfig } from "./filter-menu-types";
export { SectionHeader } from "./FilterSectionHeader";
export { SectionDivider } from "./FilterSectionDivider";

/**
 * The full sort + filter menu shared by the STT and Ollama pickers: a
 * count-badged trigger opening a popover with the Sort chips, a divider, the
 * boolean filter checkboxes, and any picker-specific `children` (e.g. STT's
 * language multi-combobox). Owns the two conventions both menus repeated: the
 * trigger badge folds the active sort into the filter count, and "clear all"
 * is enabled whenever a user-clearable filter or a sort is active.
 *
 * Domain specifics stay in the caller: STT passes `clearableFilterCount`
 * (excluding locked-on flags) + `isFlagDisabled`; Ollama prunes its `flags`
 * before passing them in.
 */
export function FilterMenu<
	TSortKey extends string,
	TFlag extends string,
	TFilters extends Record<TFlag, boolean>,
>({
	activeFilterCount,
	children,
	clearableFilterCount,
	clearLabel,
	dataSlot,
	filterLabel,
	filters,
	flags,
	isFlagDisabled,
	label,
	onClearAll,
	onToggleFlag,
	sort,
	widthClass,
}: {
	/** Active boolean filters — folded with the sort into the trigger badge. */
	activeFilterCount: number;
	/** Picker-specific sections rendered after the checkbox group. */
	children?: ReactNode;
	/** Active filters the user can actually clear (excludes locked-on flags).
	 *  Defaults to {@link activeFilterCount}. */
	clearableFilterCount?: number;
	clearLabel: string;
	dataSlot: string;
	filterLabel?: string;
	filters: TFilters;
	flags: readonly FilterFlagConfig<TFlag>[];
	isFlagDisabled?: (flag: TFlag) => boolean;
	label: string;
	onClearAll: () => void;
	onToggleFlag: (flag: TFlag) => void;
	sort: FilterSortConfig<TSortKey>;
	widthClass: string;
}) {
	const sortActive = sort.value !== null;
	const clearable = clearableFilterCount ?? activeFilterCount;
	return (
		<FilterMenuPopover
			canClear={clearable > 0 || sortActive}
			clearLabel={clearLabel}
			count={activeFilterCount + (sortActive ? 1 : 0)}
			dataSlot={dataSlot}
			label={label}
			onClear={onClearAll}
			widthClass={widthClass}
		>
			<SortChipsSection
				hint={sort.hint}
				icons={sort.icons}
				keys={sort.keys}
				labels={sort.labels}
				onChange={sort.onChange}
				sortByLabel={sort.sortByLabel}
				value={sort.value}
			/>
			<SectionDivider />
			<FilterCheckboxSection
				filterLabel={filterLabel}
				filters={filters}
				flags={flags}
				isDisabled={isFlagDisabled}
				onToggle={onToggleFlag}
			/>
			{children}
		</FilterMenuPopover>
	);
}
