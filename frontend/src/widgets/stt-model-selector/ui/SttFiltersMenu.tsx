"use client";

import { Popover } from "@base-ui/react/popover";
import {
	CheckmarkCircle02Icon,
	CpuIcon,
	FilterIcon,
	LanguageSkillIcon,
	LiveStreaming02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ComponentPropsWithoutRef } from "react";
import { LANGUAGES } from "@/shared/config/defaults";
import { cn } from "@/shared/lib/cn";
import { Z_INDEX } from "@/shared/lib/z-index";
import { Toggle } from "@/shared/ui/toggle";
import {
	activeFilterCount,
	EMPTY_FILTER_STATE,
	hasActiveFilters,
	type SttFilterState,
} from "../lib/filter-state";

const LANGUAGE_NAMES: Record<string, string> = Object.fromEntries(
	LANGUAGES.map((l) => [l.code, l.name])
);

function languageLabel(code: string): string {
	return LANGUAGE_NAMES[code] ?? code.toUpperCase();
}

interface FilterRowProps {
	checked: boolean;
	description: string;
	icon: IconSvgElement;
	label: string;
	onChange: (next: boolean) => void;
}

function FilterRow({ icon, label, description, checked, onChange }: FilterRowProps) {
	return (
		<div className="flex items-start gap-3 rounded-sm px-2 py-2 hover:bg-surface-hover">
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
	return (
		<div className="flex flex-col gap-1.5 px-2 py-2">
			<div className="flex items-center gap-1.5">
				<HugeiconsIcon className="size-4 shrink-0 text-foreground-muted" icon={LanguageSkillIcon} />
				<span className="font-medium text-body-sm text-foreground">Language</span>
			</div>
			<p className="text-[11px] text-foreground-muted leading-snug">
				Show models that can transcribe a language (multilingual models always match).
			</p>
			<div className="flex flex-wrap gap-1 pt-0.5">
				{availableLanguages.map((code) => {
					const isOn = selected.includes(code);
					return (
						<button
							className={cn(
								"inline-flex h-6 cursor-pointer items-center rounded-md border px-2 font-medium text-[11px] leading-none transition-colors",
								isOn
									? "border-accent/50 bg-accent/15 text-accent"
									: "border-border bg-surface-secondary/60 text-foreground-secondary hover:border-border-hover hover:bg-surface-hover"
							)}
							key={code}
							onClick={() => onToggle(code)}
							type="button"
						>
							{languageLabel(code)}
						</button>
					);
				})}
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
	return (
		<button
			{...buttonProps}
			aria-label="Filters"
			className={cn(
				"inline-flex h-7 items-center gap-1 rounded-sm border px-2 text-[11px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
				isActive
					? "border-accent/40 bg-accent/10 text-accent hover:bg-accent/15"
					: "border-transparent bg-transparent text-foreground-secondary hover:bg-surface-hover"
			)}
			type="button"
		>
			<HugeiconsIcon className="size-3.5" icon={FilterIcon} />
			{count > 0 ? <span className="tabular-nums">{count}</span> : "Filter"}
		</button>
	);
}

export function SttFiltersMenu({
	filters,
	onFiltersChange,
	availableLanguages,
}: SttFiltersMenuProps) {
	const count = activeFilterCount(filters);
	const setFlag = (key: "cachedOnly" | "realtimeOnly" | "fitsHardwareOnly") => (next: boolean) =>
		onFiltersChange({ ...filters, [key]: next });
	const toggleLanguage = (code: string) => {
		const next = filters.languages.includes(code)
			? filters.languages.filter((c) => c !== code)
			: [...filters.languages, code];
		onFiltersChange({ ...filters, languages: next });
	};
	const clear = () => onFiltersChange(EMPTY_FILTER_STATE);

	return (
		<Popover.Root>
			<Popover.Trigger
				nativeButton
				render={(props) => (
					<TriggerButton buttonProps={props as ComponentPropsWithoutRef<"button">} count={count} />
				)}
			/>
			<Popover.Portal>
				<Popover.Positioner align="end" sideOffset={6} style={{ zIndex: Z_INDEX.dropdown }}>
					<Popover.Popup
						className="select-popup w-[300px] origin-(--transform-origin) overflow-hidden rounded-md border border-border bg-surface-elevated p-1 font-sans text-body text-foreground shadow-md transition-[transform,opacity] duration-150 ease-out data-[ending-style]:ease-in"
						data-slot="stt-filters-menu-content"
					>
						<div className="flex items-center justify-between px-2 py-1.5">
							<span className="font-semibold text-foreground-muted text-xs-tight uppercase tracking-wide">
								Filters
							</span>
							{hasActiveFilters(filters) ? (
								<button
									className="text-[11px] text-foreground-secondary hover:text-foreground hover:underline"
									onClick={clear}
									type="button"
								>
									Clear all
								</button>
							) : null}
						</div>
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
