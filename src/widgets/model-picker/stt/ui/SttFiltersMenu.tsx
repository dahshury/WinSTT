"use client";

import {
	CheckmarkCircle02Icon,
	CpuIcon,
	FlashIcon,
	HardDriveIcon,
	LanguageSkillIcon,
	LiveStreaming02Icon,
	Target01Icon,
	TextFontIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import { LanguageMultiCombobox } from "@/shared/ui/language-multi-combobox";
import {
	FilterCheckboxSection,
	FilterMenuPopover,
	SectionDivider,
	SectionHeader,
	SortChipsSection,
	type FilterFlagConfig,
} from "../../ui/FilterPopoverParts";
import {
	activeFilterCount,
	EMPTY_FILTER_STATE,
	type SttFilterState,
} from "../lib/filter-state";
import { languageLabel } from "../lib/language-names";
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

/** The three boolean catalog filters, rendered as a fluidfunctionalism
 *  checkbox group (the descriptions the old toggle rows carried are dropped in
 *  favour of a tighter, more minimal list — the labels are self-explanatory). */
type SttFilterFlag = "cachedOnly" | "realtimeOnly" | "fitsHardwareOnly";
export type LockedSttFilterFlag = SttFilterFlag;
const FILTER_FLAGS: ReadonlyArray<FilterFlagConfig<SttFilterFlag>> = [
	{ key: "cachedOnly", icon: CheckmarkCircle02Icon, label: "Cached only" },
	{ key: "realtimeOnly", icon: LiveStreaming02Icon, label: "Streaming" },
	{ key: "fitsHardwareOnly", icon: CpuIcon, label: "Fits hardware" },
];

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

function LanguageFilterSection({
	availableLanguages,
	selected,
	onChange,
}: {
	availableLanguages: string[];
	onChange: (next: string[]) => void;
	selected: string[];
}) {
	const options = [...new Set([...availableLanguages, ...selected])]
		.toSorted((a, b) => languageLabel(a).localeCompare(languageLabel(b)))
		.map((code) => ({
			badge: code.toUpperCase(),
			id: code,
			label: languageLabel(code),
		}));
	const t = useTranslations("modelPicker");
	if (options.length === 0) {
		return null;
	}
	return (
		<div className="flex flex-col gap-1.5 p-2">
			<SectionHeader icon={LanguageSkillIcon} label={t("language")} />
			<p className="text-[11px] text-foreground-muted leading-snug">
				{t("languageHint")}
			</p>
			<div className="w-full">
				<LanguageMultiCombobox
					ariaLabel={t("languageFilter")}
					emptyLabel={t("noLanguagesFound")}
					onChange={onChange}
					options={options}
					placeholder={t("selectLanguages")}
					removeLabel={(language) => t("removeLanguage", { language })}
					selectedCountLabel={(count) => t("languagesSelected", { count })}
					selectedHeading={t("selectedLanguages")}
					value={selected}
				/>
			</div>
		</div>
	);
}

export function SttFiltersMenu({
	filters,
	lockedFilterKeys,
	onFiltersChange,
	availableLanguages,
	sort,
	onSortChange,
}: SttFiltersMenuProps) {
	const t = useTranslations("modelPicker");
	const locked = lockedFilterSet(lockedFilterKeys);
	const effectiveFilters = applyLockedFilters(filters, locked);
	// The trigger badge counts filters + the active sort as one combined signal.
	const activeFilters = activeFilterCount(effectiveFilters);
	const count = activeFilters + (sort === null ? 0 : 1);
	const hasLanguageFilterOptions =
		availableLanguages.length > 0 || effectiveFilters.languages.length > 0;
	const canClear =
		activeFilters > lockedActiveFilterCount(effectiveFilters, locked) ||
		sort !== null;
	const setLanguages = (languages: string[]) => {
		onFiltersChange(
			applyLockedFilters({ ...effectiveFilters, languages }, locked),
		);
	};
	const clear = () => {
		onFiltersChange(applyLockedFilters(EMPTY_FILTER_STATE, locked));
		onSortChange(null);
	};

	return (
		<FilterMenuPopover
			canClear={canClear}
			clearLabel={t("clearAll")}
			count={count}
			dataSlot="stt-filters-menu-content"
			label={t("sortAndFilter")}
			onClear={clear}
			widthClass="w-[300px]"
		>
			<SortChipsSection
				hint={t("flattenMakers")}
				icons={SORT_ICON}
				keys={STT_SORT_KEYS}
				labels={STT_SORT_CHIP_LABEL}
				onChange={onSortChange}
				sortByLabel={t("sortBy")}
				value={sort}
			/>
			<SectionDivider />
			<FilterCheckboxSection
				filters={effectiveFilters}
				flags={FILTER_FLAGS}
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
			{hasLanguageFilterOptions ? <SectionDivider /> : null}
			{hasLanguageFilterOptions ? (
				<LanguageFilterSection
					availableLanguages={availableLanguages}
					onChange={setLanguages}
					selected={effectiveFilters.languages}
				/>
			) : null}
		</FilterMenuPopover>
	);
}
