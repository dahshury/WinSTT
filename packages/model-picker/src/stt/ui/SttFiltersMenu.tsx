"use client";

import { Button as BaseButton } from "@base-ui/react/button";
import { Popover } from "@base-ui/react/popover";
import {
	ArrowUpDownIcon,
	CheckmarkCircle02Icon,
	CpuIcon,
	FilterIcon,
	FlashIcon,
	HardDriveIcon,
	LanguageSkillIcon,
	LiveStreaming02Icon,
	Target01Icon,
	TextFontIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ComponentPropsWithoutRef } from "react";
import { useTranslations } from "use-intl";
import { Z_INDEX } from "@/shared/config/z-index";
import { cn } from "@/shared/lib/cn";
import {
	SurfaceProvider,
	surfaceBg,
	surfaceHoverBg,
	useSurface,
} from "@/shared/lib/surface";
import { CheckboxGroup, CheckboxItem } from "@/shared/ui/checkbox-group";
import { LanguageMultiCombobox } from "@/shared/ui/language-multi-combobox";
import { FilterMenuTriggerButton } from "../../core/FilterMenuTriggerButton";
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
const FILTER_FLAGS: ReadonlyArray<{
	icon: IconSvgElement;
	key: SttFilterFlag;
	label: string;
}> = [
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

/** Shared section heading — one icon + label, so every section reads the same. */
function SectionHeader({
	icon,
	label,
}: {
	icon: IconSvgElement;
	label: string;
}) {
	return (
		<div className="flex items-center gap-1.5">
			<HugeiconsIcon
				className="size-4 shrink-0 text-foreground-muted"
				icon={icon}
			/>
			<span className="font-medium text-body-sm text-foreground">{label}</span>
		</div>
	);
}

/** Hairline section divider — the only separator between sections. */
function SectionDivider() {
	return <div aria-hidden="true" className="mx-2 my-1 h-px bg-divider/70" />;
}

function SortSection({
	value,
	onChange,
}: {
	onChange: (next: SttSortValue) => void;
	value: SttSortValue;
}) {
	// Chips lift relative to the popup substrate (provided below) so each reads
	// as its own minimal surface instead of a hard-coded flat token; the active
	// chip is the single app accent.
	const t = useTranslations("modelPicker");
	const level = useSurface();
	const idleChip = cn(
		surfaceBg(Math.min(level + 1, 8)),
		surfaceHoverBg(Math.min(level + 2, 8)),
		"text-foreground-secondary ring-divider hover:text-foreground hover:ring-border",
	);
	return (
		<div className="flex flex-col gap-2 p-2">
			<SectionHeader icon={ArrowUpDownIcon} label={t("sortBy")} />
			<p className="text-[11px] text-foreground-muted leading-snug">
				{t("flattenMakers")}
			</p>
			<div className="flex flex-wrap gap-1.5">
				{STT_SORT_KEYS.map((key) => {
					const isOn = value === key;
					return (
						<BaseButton
							className={cn(
								"inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 font-medium text-[11px] leading-none ring-1 transition-colors",
								isOn ? "bg-accent/15 text-accent ring-accent/40" : idleChip,
							)}
							key={key}
							onClick={() => onChange(isOn ? null : key)}
							type="button"
						>
							<HugeiconsIcon
								className="size-3 shrink-0"
								icon={SORT_ICON[key]}
							/>
							{STT_SORT_CHIP_LABEL[key]}
						</BaseButton>
					);
				})}
			</div>
		</div>
	);
}

function FilterSection({
	filters,
	locked,
	onFiltersChange,
}: {
	filters: SttFilterState;
	locked: ReadonlySet<LockedSttFilterFlag>;
	onFiltersChange: (next: SttFilterState) => void;
}) {
	const checkedIndices = new Set<number>(
		FILTER_FLAGS.flatMap((flag, i) => (filters[flag.key] ? [i] : [])),
	);
	return (
		<div className="flex flex-col gap-1.5 p-2">
			<SectionHeader icon={FilterIcon} label="Filter" />
			<CheckboxGroup checkedIndices={checkedIndices}>
				{FILTER_FLAGS.map((flag, i) => (
					<CheckboxItem
						checked={filters[flag.key]}
						disabled={locked.has(flag.key)}
						index={i}
						key={flag.key}
						label={flag.label}
						leading={<HugeiconsIcon className="size-4" icon={flag.icon} />}
						onToggle={() => {
							if (locked.has(flag.key)) {
								return;
							}
							onFiltersChange(
								applyLockedFilters(
									{ ...filters, [flag.key]: !filters[flag.key] },
									locked,
								),
							);
						}}
					/>
				))}
			</CheckboxGroup>
		</div>
	);
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
		.sort((a, b) => languageLabel(a).localeCompare(languageLabel(b)))
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
	const level = Math.min(useSurface() + 1, 8);
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
		<Popover.Root>
			<Popover.Trigger
				nativeButton
				render={(props) => (
					<FilterMenuTriggerButton
						buttonProps={props as ComponentPropsWithoutRef<"button">}
						count={count}
						label={t("sortAndFilter")}
					/>
				)}
			/>
			<Popover.Portal>
				<Popover.Positioner
					align="end"
					sideOffset={6}
					style={{ zIndex: Z_INDEX.popover }}
				>
					<Popover.Popup
						className={cn(
							"select-popup w-[300px] origin-(--transform-origin) overflow-hidden rounded-md border border-border p-1 font-sans text-body text-foreground shadow-md transition-[transform,opacity] duration-150 ease-out data-[ending-style]:ease-in",
							surfaceBg(level),
						)}
						data-slot="stt-filters-menu-content"
					>
						{/* Re-provide the popup's own surface level downward so chips,
						    checkbox rows and the language combobox lift relative to it. */}
						<SurfaceProvider value={level}>
							<div className="flex items-center justify-between px-2 py-1.5">
								<span className="font-semibold text-foreground-muted text-xs-tight uppercase tracking-wide">
									{t("sortAndFilter")}
								</span>
								{canClear ? (
									<BaseButton
										className="text-[11px] text-foreground-secondary hover:text-foreground hover:underline"
										onClick={clear}
										type="button"
									>
										{t("clearAll")}
									</BaseButton>
								) : null}
							</div>
							<SortSection onChange={onSortChange} value={sort} />
							<SectionDivider />
							<FilterSection
								filters={effectiveFilters}
								locked={locked}
								onFiltersChange={onFiltersChange}
							/>
							{hasLanguageFilterOptions ? <SectionDivider /> : null}
							{hasLanguageFilterOptions ? (
								<LanguageFilterSection
									availableLanguages={availableLanguages}
									onChange={setLanguages}
									selected={effectiveFilters.languages}
								/>
							) : null}
						</SurfaceProvider>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
