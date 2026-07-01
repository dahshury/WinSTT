"use client";

import { Button as BaseButton } from "@base-ui/react/button";
import { Popover } from "@base-ui/react/popover";
import { ArrowUpDownIcon, FilterIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { Z_INDEX } from "@/shared/config/z-index";
import { cn } from "@/shared/lib/cn";
import {
	SurfaceProvider,
	surfaceBg,
	surfaceHoverBg,
	useSurface,
} from "@/shared/lib/surface";
import { CheckboxGroup, CheckboxItem } from "@/shared/ui/checkbox-group";
import { FilterMenuTriggerButton } from "../core/FilterMenuTriggerButton";

export interface FilterFlagConfig<TFlag extends string> {
	icon: IconSvgElement;
	key: TFlag;
	label: string;
}

export function FilterMenuPopover({
	canClear,
	children,
	clearLabel,
	count,
	dataSlot,
	label,
	onClear,
	widthClass,
}: {
	canClear: boolean;
	children: ReactNode;
	clearLabel: string;
	count: number;
	dataSlot: string;
	label: string;
	onClear: () => void;
	widthClass: string;
}) {
	const level = Math.min(useSurface() + 1, 8);
	return (
		<Popover.Root>
			<Popover.Trigger
				nativeButton
				render={(props) => (
					<FilterMenuTriggerButton
						buttonProps={props as ComponentPropsWithoutRef<"button">}
						count={count}
						label={label}
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
							"select-popup origin-(--transform-origin) overflow-hidden rounded-md border border-border p-1 font-sans text-body text-foreground shadow-md transition-[transform,opacity] duration-150 ease-out data-[ending-style]:ease-in",
							widthClass,
							surfaceBg(level),
						)}
						data-slot={dataSlot}
					>
						<SurfaceProvider value={level}>
							<div className="flex items-center justify-between px-2 py-1.5">
								<span className="font-semibold text-foreground-muted text-xs-tight uppercase tracking-wide">
									{label}
								</span>
								{canClear ? (
									<BaseButton
										className="text-[11px] text-foreground-secondary hover:text-foreground hover:underline"
										onClick={onClear}
										type="button"
									>
										{clearLabel}
									</BaseButton>
								) : null}
							</div>
							{children}
						</SurfaceProvider>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}

export function SectionHeader({
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

export function SectionDivider() {
	return <div aria-hidden="true" className="mx-2 my-1 h-px bg-divider/70" />;
}

export function SortChipsSection<TSortKey extends string>({
	hint,
	icons,
	keys,
	labels,
	onChange,
	sortByLabel,
	value,
}: {
	hint: string;
	icons: Record<TSortKey, IconSvgElement>;
	keys: readonly TSortKey[];
	labels: Record<TSortKey, string>;
	onChange: (next: TSortKey | null) => void;
	sortByLabel: string;
	value: TSortKey | null;
}) {
	const level = useSurface();
	const idleChip = cn(
		surfaceBg(Math.min(level + 1, 8)),
		surfaceHoverBg(Math.min(level + 2, 8)),
		"text-foreground-secondary ring-divider hover:text-foreground hover:ring-border",
	);
	return (
		<div className="flex flex-col gap-2 p-2">
			<SectionHeader icon={ArrowUpDownIcon} label={sortByLabel} />
			<p className="text-[11px] text-foreground-muted leading-snug">{hint}</p>
			<div className="flex flex-wrap gap-1.5">
				{keys.map((key) => {
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
							<HugeiconsIcon className="size-3 shrink-0" icon={icons[key]} />
							{labels[key]}
						</BaseButton>
					);
				})}
			</div>
		</div>
	);
}

export function FilterCheckboxSection<
	TFlag extends string,
	TFilters extends Record<TFlag, boolean>,
>({
	filterLabel = "Filter",
	filters,
	flags,
	isDisabled,
	onToggle,
}: {
	filterLabel?: string;
	filters: TFilters;
	flags: readonly FilterFlagConfig<TFlag>[];
	isDisabled?: (flag: TFlag) => boolean;
	onToggle: (flag: TFlag) => void;
}) {
	const checkedIndices = new Set<number>(
		flags.flatMap((flag, i) => (filters[flag.key] ? [i] : [])),
	);
	return (
		<div className="flex flex-col gap-1.5 p-2">
			<SectionHeader icon={FilterIcon} label={filterLabel} />
			<CheckboxGroup checkedIndices={checkedIndices}>
				{flags.map((flag, i) => (
					<CheckboxItem
						checked={filters[flag.key]}
						disabled={isDisabled?.(flag.key) ?? false}
						index={i}
						key={flag.key}
						label={flag.label}
						leading={<HugeiconsIcon className="size-4" icon={flag.icon} />}
						onToggle={() => onToggle(flag.key)}
					/>
				))}
			</CheckboxGroup>
		</div>
	);
}
