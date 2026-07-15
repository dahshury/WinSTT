"use client";

import {
	BinaryCodeIcon,
	CheckmarkCircle02Icon,
	Copy01Icon,
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
import { LanguageMultiCombobox } from "@/shared/ui/language-multi-combobox";
import {
	FilterMenu,
	SectionDivider,
	SectionHeader,
	type FilterFlagConfig,
} from "@/shared/ui/model-picker/ui/FilterPopoverParts";
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

function MultiSelectSection({
	ariaLabel,
	emptyLabel,
	hint,
	icon,
	label,
	onChange,
	options,
	placeholder,
	selected,
	selectedHeading,
}: {
	ariaLabel: string;
	emptyLabel: string;
	hint: string;
	icon: IconSvgElement;
	label: string;
	onChange: (next: string[]) => void;
	options: Array<{ badge: string; id: string; label: string }>;
	placeholder: string;
	selected: string[];
	selectedHeading: string;
}) {
	if (options.length === 0) {
		return null;
	}
	return (
		<div className="flex flex-col gap-1.5 p-2">
			<SectionHeader icon={icon} label={label} />
			<p className="text-[11px] text-foreground-muted leading-snug">{hint}</p>
			<LanguageMultiCombobox
				ariaLabel={ariaLabel}
				emptyLabel={emptyLabel}
				onChange={onChange}
				options={options}
				placeholder={placeholder}
				removeLabel={(value) => `Remove ${value}`}
				selectedCountLabel={(count) => `${count} selected`}
				selectedHeading={selectedHeading}
				value={selected}
			/>
		</div>
	);
}

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
	const clear = () => {
		onFiltersChange(EMPTY_TTS_FILTER_STATE);
		onSortChange(null);
	};

	return (
		<FilterMenu
			activeFilterCount={activeTtsFilterCount(filters)}
			clearLabel="Clear all"
			dataSlot="tts-filters-menu-content"
			filters={filters}
			flags={flags}
			label="Sort & filter"
			onClearAll={clear}
			onToggleFlag={(flag) =>
				onFiltersChange({ ...filters, [flag]: !filters[flag] })
			}
			sort={{
				hint: "Show all makers in one ordered list.",
				icons: SORT_ICON,
				keys: TTS_SORT_KEYS,
				labels: TTS_SORT_CHIP_LABEL,
				onChange: onSortChange,
				sortByLabel: "Sort by",
				value: sort,
			}}
			widthClass="w-[320px]"
		>
			<SectionDivider />
			<MultiSelectSection
				ariaLabel="Filter by language"
				emptyLabel="No languages found"
				hint="Show models that support any selected language."
				icon={LanguageSkillIcon}
				label="Language"
				onChange={(languages) => onFiltersChange({ ...filters, languages })}
				options={languageOptions}
				placeholder="Select languages"
				selected={filters.languages}
				selectedHeading="Selected languages"
			/>
			<SectionDivider />
			<MultiSelectSection
				ariaLabel="Filter by quantization"
				emptyLabel="No precisions found"
				hint="Show models offering any selected precision."
				icon={BinaryCodeIcon}
				label="Precision"
				onChange={(quantizations) =>
					onFiltersChange({ ...filters, quantizations })
				}
				options={quantizationOptions}
				placeholder="Select precisions"
				selected={filters.quantizations}
				selectedHeading="Selected precisions"
			/>
		</FilterMenu>
	);
}
