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
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { ButtonGroup } from "@/shared/ui/button-group";
import { Toggle } from "@/shared/ui/toggle";
import { activeFilterCount, EMPTY_FILTER_STATE, type SttFilterState } from "../lib/filter-state";
import { languageLabel } from "../lib/language-names";
import {
	STT_SORT_CHIP_LABEL,
	STT_SORT_KEYS,
	type SttSortKey,
	type SttSortValue,
} from "../lib/sort-state";

interface FilterRowProps {
	checked: boolean;
	description: string;
	icon: IconSvgElement;
	label: string;
	onChange: (next: boolean) => void;
}

function FilterRow({ icon, label, description, checked, onChange }: FilterRowProps) {
	return (
		<div className="flex items-start gap-3 rounded-sm p-2 hover:bg-surface-hover">
			<HugeiconsIcon className="mt-0.5 size-4 shrink-0 text-foreground-muted" icon={icon} />
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="font-medium text-body-sm text-foreground">{label}</span>
				<span className="text-[11px] text-foreground-muted leading-snug">{description}</span>
			</div>
			<Toggle aria-label={label} checked={checked} onCheckedChange={onChange} />
		</div>
	);
}

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

function SortSection({
	value,
	onChange,
}: {
	onChange: (next: SttSortValue) => void;
	value: SttSortValue;
}) {
	return (
		<div className="flex flex-col gap-1.5 p-2">
			<div className="flex items-center gap-1.5">
				<HugeiconsIcon className="size-4 shrink-0 text-foreground-muted" icon={ArrowUpDownIcon} />
				<span className="font-medium text-body-sm text-foreground">Sort by</span>
			</div>
			<p className="text-[11px] text-foreground-muted leading-snug">
				Flatten the makers into one ordered list. Tap the active option again to go back to grouped.
			</p>
			<div className="flex flex-wrap gap-1 pt-0.5">
				{STT_SORT_KEYS.map((key) => {
					const isOn = value === key;
					return (
						<button
							className={cn(
								"inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border px-2 font-medium text-[11px] leading-none transition-colors",
								isOn
									? "border-accent/50 bg-accent/15 text-accent"
									: "border-border bg-surface-secondary/60 text-foreground-secondary hover:border-border-hover hover:bg-surface-hover"
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

function LanguageFilterSection({
	availableLanguages,
	selected,
	onToggle,
}: {
	availableLanguages: string[];
	onToggle: (code: string) => void;
	selected: string[];
}) {
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
			<div className="flex items-center gap-1.5">
				<HugeiconsIcon className="size-4 shrink-0 text-foreground-muted" icon={LanguageSkillIcon} />
				<span className="font-medium text-body-sm text-foreground">Language</span>
			</div>
			<p className="text-[11px] text-foreground-muted leading-snug">
				Show models that can transcribe a language (multilingual models always match).
			</p>
			<div className="flex flex-col gap-1 pt-0.5">
				{rows.map((row) => (
					<ButtonGroup className="w-full" connected key={row.join("-")}>
						{row.map((code) => {
							const isOn = selected.includes(code);
							return (
								<button
									className={cn(
										"inline-flex h-6 min-w-0 flex-1 cursor-pointer items-center justify-center px-2 font-medium text-[11px] leading-none transition-colors",
										isOn
											? "bg-accent text-white"
											: "text-foreground-secondary hover:bg-surface-hover hover:text-foreground"
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
	const setFlag = (key: "cachedOnly" | "realtimeOnly" | "fitsHardwareOnly") => (next: boolean) =>
		onFiltersChange({ ...filters, [key]: next });
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
						<div className="mx-2 my-1 h-px bg-border/60" />
						<FilterRow
							checked={filters.cachedOnly}
							description="Only show models already downloaded to disk."
							icon={CheckmarkCircle02Icon}
							label="Cached only"
							onChange={setFlag("cachedOnly")}
						/>
						<FilterRow
							checked={filters.realtimeOnly}
							description="Only models usable for the live-preview transcription."
							icon={LiveStreaming02Icon}
							label="Realtime capable"
							onChange={setFlag("realtimeOnly")}
						/>
						<FilterRow
							checked={filters.fitsHardwareOnly}
							description="Only models that comfortably fit on your CPU/GPU memory."
							icon={CpuIcon}
							label="Fits hardware"
							onChange={setFlag("fitsHardwareOnly")}
						/>
						<LanguageFilterSection
							availableLanguages={availableLanguages}
							onToggle={toggleLanguage}
							selected={filters.languages}
						/>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
