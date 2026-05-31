"use client";

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
import { Z_INDEX } from "@/shared/config/z-index";
import { cn } from "@/shared/lib/cn";
import { SurfaceProvider, surfaceBg, surfaceHoverBg, useSurface } from "@/shared/lib/surface";
import { ButtonGroup } from "@/shared/ui/button-group";
import { CheckboxGroup, CheckboxItem } from "@/shared/ui/checkbox-group";
import { activeFilterCount, EMPTY_FILTER_STATE, type SttFilterState } from "../lib/filter-state";
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
const FILTER_FLAGS: ReadonlyArray<{ icon: IconSvgElement; key: SttFilterFlag; label: string }> = [
	{ key: "cachedOnly", icon: CheckmarkCircle02Icon, label: "Cached only" },
	{ key: "realtimeOnly", icon: LiveStreaming02Icon, label: "Realtime capable" },
	{ key: "fitsHardwareOnly", icon: CpuIcon, label: "Fits hardware" },
];

/** Shared section heading — one icon + label, so every section reads the same. */
function SectionHeader({ icon, label }: { icon: IconSvgElement; label: string }) {
	return (
		<div className="flex items-center gap-1.5">
			<HugeiconsIcon className="size-4 shrink-0 text-foreground-muted" icon={icon} />
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
	const level = useSurface();
	const idleChip = cn(
		surfaceBg(Math.min(level + 1, 8)),
		surfaceHoverBg(Math.min(level + 2, 8)),
		"text-foreground-secondary ring-divider hover:text-foreground hover:ring-border"
	);
	return (
		<div className="flex flex-col gap-2 p-2">
			<SectionHeader icon={ArrowUpDownIcon} label="Sort by" />
			<p className="text-[11px] text-foreground-muted leading-snug">
				Flatten the makers into one ordered list. Tap the active option again to go back to grouped.
			</p>
			<div className="flex flex-wrap gap-1.5">
				{STT_SORT_KEYS.map((key) => {
					const isOn = value === key;
					return (
						<button
							className={cn(
								"inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 font-medium text-[11px] leading-none ring-1 transition-colors",
								isOn ? "bg-accent/15 text-accent ring-accent/40" : idleChip
							)}
							key={key}
							onClick={() => onChange(isOn ? null : key)}
							type="button"
						>
							<HugeiconsIcon className="size-3 shrink-0" icon={SORT_ICON[key]} />
							{STT_SORT_CHIP_LABEL[key]}
						</button>
					);
				})}
			</div>
		</div>
	);
}

function FilterSection({
	filters,
	onFiltersChange,
}: {
	filters: SttFilterState;
	onFiltersChange: (next: SttFilterState) => void;
}) {
	const checkedIndices = new Set<number>(
		FILTER_FLAGS.flatMap((flag, i) => (filters[flag.key] ? [i] : []))
	);
	return (
		<div className="flex flex-col gap-1.5 p-2">
			<SectionHeader icon={FilterIcon} label="Filter" />
			<CheckboxGroup checkedIndices={checkedIndices}>
				{FILTER_FLAGS.map((flag, i) => (
					<CheckboxItem
						checked={filters[flag.key]}
						index={i}
						key={flag.key}
						label={flag.label}
						leading={<HugeiconsIcon className="size-4" icon={flag.icon} />}
						onToggle={() => onFiltersChange({ ...filters, [flag.key]: !filters[flag.key] })}
					/>
				))}
			</CheckboxGroup>
		</div>
	);
}

function LanguageFilterSection({
	availableLanguages,
	selected,
	onToggle,
}: {
	availableLanguages: string[];
	onToggle: (code: string) => void;
	selected: string[];
}) {
	const level = useSurface();
	if (availableLanguages.length === 0) {
		return null;
	}
	// Order by the *displayed* name, not the raw ISO code, so the grid reads
	// alphabetically (Arabic, Chinese, French…). Then pack into fixed rows of
	// three so each row is a full-width joined segment control — every row's
	// edges line up instead of the old ragged wrap.
	const sorted = [...availableLanguages].sort((a, b) =>
		languageLabel(a).localeCompare(languageLabel(b))
	);
	const rows: string[][] = [];
	for (let i = 0; i < sorted.length; i += 3) {
		rows.push(sorted.slice(i, i + 3));
	}
	return (
		<div className="flex flex-col gap-1.5 p-2">
			<SectionHeader icon={LanguageSkillIcon} label="Language" />
			<p className="text-[11px] text-foreground-muted leading-snug">
				Show models that can transcribe a language (multilingual models always match).
			</p>
			<div className="flex flex-col gap-1">
				{rows.map((row) => (
					<ButtonGroup className="w-full" connected key={row.join("-")}>
						{row.map((code) => {
							const isOn = selected.includes(code);
							return (
								<button
									className={cn(
										"inline-flex h-7 min-w-0 flex-1 cursor-pointer items-center justify-center px-2 font-medium text-[11px] leading-none transition-colors",
										isOn
											? "bg-accent text-white"
											: cn(
													surfaceHoverBg(Math.min(level + 1, 8)),
													"text-foreground-secondary hover:text-foreground"
												)
									)}
									key={code}
									onClick={() => onToggle(code)}
									title={languageLabel(code)}
									type="button"
								>
									<span className="truncate">{languageLabel(code)}</span>
								</button>
							);
						})}
					</ButtonGroup>
				))}
			</div>
		</div>
	);
}

function TriggerButton({
	count,
	buttonProps,
}: {
	buttonProps: ComponentPropsWithoutRef<"button">;
	count: number;
}) {
	const isActive = count > 0;
	const label = count > 0 ? `Sort & filter (${count} active)` : "Sort & filter";
	return (
		<button
			{...buttonProps}
			aria-label={label}
			className={cn(
				"relative inline-flex size-7 items-center justify-center rounded-sm border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
				isActive
					? "border-accent/40 bg-accent/10 text-accent hover:bg-accent/15"
					: "border-transparent bg-transparent text-foreground-secondary hover:bg-surface-hover"
			)}
			title={label}
			type="button"
		>
			<HugeiconsIcon className="size-4" icon={FilterIcon} />
			{count > 0 ? (
				<span
					className={cn(
						"absolute -end-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full",
						"border border-divider bg-accent px-1 font-semibold text-[9px] text-white tabular-nums leading-none"
					)}
				>
					{count}
				</span>
			) : null}
		</button>
	);
}

export function SttFiltersMenu({
	filters,
	onFiltersChange,
	availableLanguages,
	sort,
	onSortChange,
}: SttFiltersMenuProps) {
	const level = Math.min(useSurface() + 1, 8);
	// The trigger badge counts filters + the active sort as one combined signal.
	const count = activeFilterCount(filters) + (sort === null ? 0 : 1);
	const toggleLanguage = (code: string) => {
		const next = filters.languages.includes(code)
			? filters.languages.filter((c) => c !== code)
			: [...filters.languages, code];
		onFiltersChange({ ...filters, languages: next });
	};
	const clear = () => {
		onFiltersChange(EMPTY_FILTER_STATE);
		onSortChange(null);
	};

	return (
		<Popover.Root>
			<Popover.Trigger
				nativeButton
				render={(props) => (
					<TriggerButton buttonProps={props as ComponentPropsWithoutRef<"button">} count={count} />
				)}
			/>
			<Popover.Portal>
				<Popover.Positioner align="end" sideOffset={6} style={{ zIndex: Z_INDEX.popover }}>
					<Popover.Popup
						className={cn(
							"select-popup w-[300px] origin-(--transform-origin) overflow-hidden rounded-md border border-border p-1 font-sans text-body text-foreground shadow-md transition-[transform,opacity] duration-150 ease-out data-[ending-style]:ease-in",
							surfaceBg(level)
						)}
						data-slot="stt-filters-menu-content"
					>
						{/* Re-provide the popup's own surface level downward so every chip,
						    checkbox row and language button lifts relative to it. */}
						<SurfaceProvider value={level}>
							<div className="flex items-center justify-between px-2 py-1.5">
								<span className="font-semibold text-foreground-muted text-xs-tight uppercase tracking-wide">
									Sort &amp; filter
								</span>
								{count > 0 ? (
									<button
										className="text-[11px] text-foreground-secondary hover:text-foreground hover:underline"
										onClick={clear}
										type="button"
									>
										Clear all
									</button>
								) : null}
							</div>
							<SortSection onChange={onSortChange} value={sort} />
							<SectionDivider />
							<FilterSection filters={filters} onFiltersChange={onFiltersChange} />
							{availableLanguages.length > 0 ? <SectionDivider /> : null}
							<LanguageFilterSection
								availableLanguages={availableLanguages}
								onToggle={toggleLanguage}
								selected={filters.languages}
							/>
						</SurfaceProvider>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
