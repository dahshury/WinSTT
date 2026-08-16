"use client";

import {
	ArrowUpDownIcon,
	CheckmarkCircle02Icon,
	CpuIcon,
	FilterIcon,
	FlashIcon,
	HardDriveIcon,
	LanguageSkillIcon,
	LiveStreaming02Icon,
	SparklesIcon,
	Target01Icon,
	TextFontIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import { FilterCheckboxSection } from "@/shared/ui/model-picker/ui/FilterCheckboxSection";
import { FilterMultiSelectView } from "@/shared/ui/model-picker/ui/FilterMultiSelectView";
import {
	FilterNavMenu,
	type FilterNavSection,
} from "@/shared/ui/model-picker/ui/FilterNavMenu";
import { SortChipsSection } from "@/shared/ui/model-picker/ui/FilterSortChipsSection";
import type { FilterFlagConfig } from "@/shared/ui/model-picker/ui/filter-menu-types";
import { languageLabel } from "@/shared/ui/model-picker/lib/language-names";
import {
	activeFilterCount,
	EMPTY_FILTER_STATE,
	type SttFilterState,
} from "../lib/filter-state";
import {
	STT_SORT_CHIP_LABEL,
	STT_SORT_KEYS,
	type SttSortKey,
	type SttSortValue,
} from "../lib/sort-state";

export interface SttFiltersMenuProps {
	/** Language codes that appear in the catalog (sorted). */
	availableLanguages: string[];
	filters: SttFilterState;
	lockedFilterKeys?: readonly LockedSttFilterFlag[] | undefined;
	onFiltersChange: (next: SttFilterState) => void;
	onSortChange: (next: SttSortValue) => void;
	/** Whether the host wired a Suggested verdict — hides the (inert)
	 *  "Suggested" checkbox when there is nothing to filter by. Mirrors the
	 *  Ollama menu's `showHardwareFilter` pruning. */
	showSuggestedFilter?: boolean | undefined;
	/** Active global sort key, or ``null`` for the default grouped view. */
	sort: SttSortValue;
}

/** Icon per sort dimension — kept in the UI layer so {@link STT_SORT_KEYS}
 *  (the lib) stays presentation-free. */
const SORT_ICON: Record<SttSortKey, IconSvgElement> = {
	speed: FlashIcon,
	accuracy: Target01Icon,
	size: HardDriveIcon,
	name: TextFontIcon,
};

/** The boolean catalog filters, rendered as a fluidfunctionalism
 *  checkbox group in the menu's "Filters" view. */
type SttFilterFlag =
	| "cachedOnly"
	| "realtimeOnly"
	| "fitsHardwareOnly"
	| "suggestedOnly";
export type LockedSttFilterFlag = SttFilterFlag;
const FILTER_FLAGS: readonly FilterFlagConfig<SttFilterFlag>[] = [
	{ key: "suggestedOnly", icon: SparklesIcon, label: "Suggested" },
	{ key: "cachedOnly", icon: CheckmarkCircle02Icon, label: "Cached only" },
	{ key: "realtimeOnly", icon: LiveStreaming02Icon, label: "Streaming" },
	{ key: "fitsHardwareOnly", icon: CpuIcon, label: "Fits hardware" },
];

// Moved to the shared picker UI layer so the Ollama picker can render the same
// chip; re-exported here to keep existing import sites working.
export { SuggestedFilterChip } from "@/shared/ui/model-picker/ui/SuggestedFilterChip";

function lockedFilterSet(
	lockedFilterKeys: readonly LockedSttFilterFlag[] | undefined,
): ReadonlySet<LockedSttFilterFlag> {
	return new Set(lockedFilterKeys ?? []);
}

function applyLockedFilters(
	filters: SttFilterState,
	locked: ReadonlySet<LockedSttFilterFlag>,
): SttFilterState {
	let next = filters;
	for (const key of locked) {
		if (!next[key]) {
			next = { ...next, [key]: true };
		}
	}
	return next;
}

function lockedActiveFilterCount(
	filters: SttFilterState,
	locked: ReadonlySet<LockedSttFilterFlag>,
): number {
	return [...locked].filter((key) => filters[key]).length;
}

function languageOptionsFor(
	availableLanguages: string[],
	selected: string[],
): Array<{ badge: string; id: string; label: string }> {
	return [...new Set([...availableLanguages, ...selected])]
		.toSorted((a, b) => languageLabel(a).localeCompare(languageLabel(b)))
		.map((code) => ({
			badge: code.toUpperCase(),
			id: code,
			label: languageLabel(code),
		}));
}

export function SttFiltersMenu({
	filters,
	lockedFilterKeys,
	onFiltersChange,
	availableLanguages,
	showSuggestedFilter = false,
	sort,
	onSortChange,
}: SttFiltersMenuProps) {
	const t = useTranslations("modelPicker");
	const flags = showSuggestedFilter
		? FILTER_FLAGS
		: FILTER_FLAGS.filter((flag) => flag.key !== "suggestedOnly");
	const locked = lockedFilterSet(lockedFilterKeys);
	const effectiveFilters = applyLockedFilters(filters, locked);
	const activeFilters = activeFilterCount(effectiveFilters);
	// Locked-on flags (e.g. realtime in the realtime picker) can't be cleared.
	const clearableFilters =
		activeFilters - lockedActiveFilterCount(effectiveFilters, locked);
	const flagCount = flags.filter((flag) => effectiveFilters[flag.key]).length;
	const languageOptions = languageOptionsFor(
		availableLanguages,
		effectiveFilters.languages,
	);

	const setLanguages = (languages: string[]) => {
		onFiltersChange(
			applyLockedFilters({ ...effectiveFilters, languages }, locked),
		);
	};

	const sections: FilterNavSection[] = [
		{
			icon: ArrowUpDownIcon,
			id: "sort",
			label: t("sortBy"),
			render: () => (
				<SortChipsSection
					hint={t("flattenMakers")}
					icons={SORT_ICON}
					keys={STT_SORT_KEYS}
					labels={STT_SORT_CHIP_LABEL}
					onChange={onSortChange}
					value={sort}
				/>
			),
			value: sort === null ? null : STT_SORT_CHIP_LABEL[sort],
		},
		{
			badge: flagCount,
			icon: FilterIcon,
			id: "flags",
			label: t("filters"),
			render: () => (
				<FilterCheckboxSection
					filters={effectiveFilters}
					flags={flags}
					isDisabled={(flag) => locked.has(flag)}
					onToggle={(flag) => {
						if (locked.has(flag)) {
							return;
						}
						onFiltersChange(
							applyLockedFilters(
								{ ...effectiveFilters, [flag]: !effectiveFilters[flag] },
								locked,
							),
						);
					}}
				/>
			),
		},
	];

	if (languageOptions.length > 0) {
		sections.push({
			badge: effectiveFilters.languages.length,
			icon: LanguageSkillIcon,
			id: "language",
			label: t("language"),
			render: () => (
				<FilterMultiSelectView
					ariaLabel={t("languageFilter")}
					emptyLabel={t("noLanguagesFound")}
					hint={t("languageHint")}
					onChange={setLanguages}
					options={languageOptions}
					placeholder={t("selectLanguages")}
					removeLabel={(language) => t("removeLanguage", { language })}
					selected={effectiveFilters.languages}
					selectedCountLabel={(count) => t("languagesSelected", { count })}
					selectedHeading={t("selectedLanguages")}
				/>
			),
		});
	}

	return (
		<FilterNavMenu
			activeFilterCount={activeFilters + (sort === null ? 0 : 1)}
			canClear={clearableFilters > 0 || sort !== null}
			clearLabel={t("clearAll")}
			dataSlot="stt-filters-menu-content"
			label={t("sortAndFilter")}
			onClearAll={() => {
				onFiltersChange(applyLockedFilters(EMPTY_FILTER_STATE, locked));
				onSortChange(null);
			}}
			sections={sections}
		/>
	);
}
