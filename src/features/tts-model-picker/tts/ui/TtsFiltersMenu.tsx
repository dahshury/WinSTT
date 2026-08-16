"use client";

import {
	ArrowUpDownIcon,
	BinaryCodeIcon,
	CheckmarkCircle02Icon,
	Copy01Icon,
	FilterIcon,
	FlashIcon,
	GlobeIcon,
	HardDriveIcon,
	LanguageSkillIcon,
	SparklesIcon,
	Target01Icon,
	TextFontIcon,
	UserMultiple02Icon,
	VoiceIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
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
	activeTtsFilterCount,
	EMPTY_TTS_FILTER_STATE,
	type TtsFilterState,
} from "../lib/filter-state";
import {
	TTS_SORT_CHIP_LABEL,
	TTS_SORT_KEYS,
	type TtsSortKey,
	type TtsSortValue,
} from "../lib/sort-state";

export interface TtsFiltersMenuProps {
	availableLanguages: string[];
	availableQuantizations: string[];
	filters: TtsFilterState;
	onFiltersChange: (next: TtsFilterState) => void;
	onSortChange: (next: TtsSortValue) => void;
	/** Whether the host wired a Suggested verdict — hides the (inert)
	 *  "Suggested" checkbox when there is nothing to filter by. Mirrors the
	 *  STT menu's `showSuggestedFilter`. */
	showSuggestedFilter?: boolean | undefined;
	sort: TtsSortValue;
}

type TtsFilterFlag =
	| "availableOnly"
	| "cachedOnly"
	| "cloningOnly"
	| "multilingualOnly"
	| "suggestedOnly"
	| "voiceDesignOnly";

const FILTER_FLAGS: readonly FilterFlagConfig<TtsFilterFlag>[] = [
	{ key: "suggestedOnly", icon: SparklesIcon, label: "Suggested" },
	{
		key: "availableOnly",
		icon: CheckmarkCircle02Icon,
		label: "Available on this system",
	},
	{ key: "cachedOnly", icon: HardDriveIcon, label: "Downloaded" },
	{ key: "multilingualOnly", icon: GlobeIcon, label: "Multilingual" },
	{ key: "cloningOnly", icon: Copy01Icon, label: "Voice cloning" },
	{ key: "voiceDesignOnly", icon: VoiceIcon, label: "Voice design" },
];

const SORT_ICON: Record<TtsSortKey, IconSvgElement> = {
	speed: FlashIcon,
	quality: Target01Icon,
	size: HardDriveIcon,
	voices: UserMultiple02Icon,
	name: TextFontIcon,
};

export function TtsFiltersMenu({
	availableLanguages,
	availableQuantizations,
	filters,
	onFiltersChange,
	onSortChange,
	showSuggestedFilter = false,
	sort,
}: TtsFiltersMenuProps) {
	const flags = showSuggestedFilter
		? FILTER_FLAGS
		: FILTER_FLAGS.filter((flag) => flag.key !== "suggestedOnly");
	const languageOptions = [
		...new Set([...availableLanguages, ...filters.languages]),
	]
		.toSorted((a, b) => languageLabel(a).localeCompare(languageLabel(b)))
		.map((code) => ({
			badge: code.toUpperCase(),
			id: code,
			label: languageLabel(code),
		}));
	const quantizationOptions = [
		...new Set([...availableQuantizations, ...filters.quantizations]),
	].map((quantization) => ({
		badge: quantization === "" ? "AUTO" : quantization.toUpperCase(),
		id: quantization,
		label:
			quantization === "" ? "Default precision" : quantization.toUpperCase(),
	}));
	const activeFilters = activeTtsFilterCount(filters);

	const sections: FilterNavSection[] = [
		{
			icon: ArrowUpDownIcon,
			id: "sort",
			label: "Sort by",
			render: () => (
				<SortChipsSection
					hint="Show all makers in one ordered list."
					icons={SORT_ICON}
					keys={TTS_SORT_KEYS}
					labels={TTS_SORT_CHIP_LABEL}
					onChange={onSortChange}
					value={sort}
				/>
			),
			value: sort === null ? null : TTS_SORT_CHIP_LABEL[sort],
		},
		{
			badge: flags.filter((flag) => filters[flag.key]).length,
			icon: FilterIcon,
			id: "flags",
			label: "Filters",
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

	if (languageOptions.length > 0) {
		sections.push({
			badge: filters.languages.length,
			icon: LanguageSkillIcon,
			id: "language",
			label: "Language",
			render: () => (
				<FilterMultiSelectView
					ariaLabel="Filter by language"
					emptyLabel="No languages found"
					hint="Show models that support any selected language."
					onChange={(languages) => onFiltersChange({ ...filters, languages })}
					options={languageOptions}
					placeholder="Select languages"
					removeLabel={(value) => `Remove ${value}`}
					selected={filters.languages}
					selectedCountLabel={(count) => `${count} selected`}
					selectedHeading="Selected languages"
				/>
			),
		});
	}

	if (quantizationOptions.length > 0) {
		sections.push({
			badge: filters.quantizations.length,
			icon: BinaryCodeIcon,
			id: "precision",
			label: "Precision",
			render: () => (
				<FilterMultiSelectView
					ariaLabel="Filter by quantization"
					emptyLabel="No precisions found"
					hint="Show models offering any selected precision."
					onChange={(quantizations) =>
						onFiltersChange({ ...filters, quantizations })
					}
					options={quantizationOptions}
					placeholder="Select precisions"
					removeLabel={(value) => `Remove ${value}`}
					selected={filters.quantizations}
					selectedCountLabel={(count) => `${count} selected`}
					selectedHeading="Selected precisions"
				/>
			),
		});
	}

	return (
		<FilterNavMenu
			activeFilterCount={activeFilters + (sort === null ? 0 : 1)}
			canClear={activeFilters > 0 || sort !== null}
			clearLabel="Clear all"
			dataSlot="tts-filters-menu-content"
			label="Sort & filter"
			onClearAll={() => {
				onFiltersChange(EMPTY_TTS_FILTER_STATE);
				onSortChange(null);
			}}
			sections={sections}
			widthPx={320}
		/>
	);
}
