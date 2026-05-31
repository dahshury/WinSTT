"use client";

import { Popover } from "@base-ui/react/popover";
import {
	ArrowUpDownIcon,
	Atom01Icon,
	HardDriveIcon,
	TextFontIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ComponentPropsWithoutRef } from "react";
import { Z_INDEX } from "@/shared/config/z-index";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import {
	OLLAMA_SORT_CHIP_LABEL,
	OLLAMA_SORT_KEYS,
	type OllamaSortKey,
	type OllamaSortValue,
} from "../lib/sort-state";

export interface OllamaSortMenuProps {
	onSortChange: (next: OllamaSortValue) => void;
	/** Active global sort key, or ``null`` for the default grouped view. */
	sort: OllamaSortValue;
}

/** Icon per sort dimension — kept in the UI layer so {@link OLLAMA_SORT_KEYS}
 *  (the lib) stays presentation-free. */
const SORT_ICON: Record<OllamaSortKey, IconSvgElement> = {
	name: TextFontIcon,
	size: HardDriveIcon,
	params: Atom01Icon,
};

function SortSection({
	value,
	onChange,
}: {
	onChange: (next: OllamaSortValue) => void;
	value: OllamaSortValue;
}) {
	return (
		<div className="flex flex-col gap-1.5 p-2">
			<div className="flex items-center gap-1.5">
				<HugeiconsIcon className="size-4 shrink-0 text-foreground-muted" icon={ArrowUpDownIcon} />
				<span className="font-medium text-body-sm text-foreground">Sort by</span>
			</div>
			<p className="text-[11px] text-foreground-muted leading-snug">
				Flatten the installed models into one ordered list. Tap the active option again to go back
				to grouped.
			</p>
			<div className="flex flex-wrap gap-1 pt-0.5">
				{OLLAMA_SORT_KEYS.map((key) => {
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
							{OLLAMA_SORT_CHIP_LABEL[key]}
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
	const label = count > 0 ? "Sort (1 active)" : "Sort";
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
			<HugeiconsIcon className="size-4" icon={ArrowUpDownIcon} />
			{count > 0 ? (
				<span
					className={cn(
						"absolute -end-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full",
						"border border-accent/30 bg-accent/20 px-1 font-semibold text-[9px] text-accent tabular-nums leading-none"
					)}
				>
					{count}
				</span>
			) : null}
		</button>
	);
}

/**
 * Sort-only menu for the Ollama picker — a small button that opens a Popover
 * containing just the Sort chips. Models the {@link import("../../stt/ui/SttFiltersMenu").SttFiltersMenu}
 * SortSection + TriggerButton, but the Ollama picker has no filter rows so this
 * is sort-only. The trigger carries a count badge (1 when a sort is active).
 */
export function OllamaSortMenu({ sort, onSortChange }: OllamaSortMenuProps) {
	const level = Math.min(useSurface() + 1, 8);
	const count = sort === null ? 0 : 1;

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
							"select-popup w-[260px] origin-(--transform-origin) overflow-hidden rounded-md border border-border p-1 font-sans text-body text-foreground shadow-md transition-[transform,opacity] duration-150 ease-out data-[ending-style]:ease-in",
							surfaceBg(level)
						)}
						data-slot="ollama-sort-menu-content"
					>
						<div className="flex items-center justify-between px-2 py-1.5">
							<span className="font-semibold text-foreground-muted text-xs-tight uppercase tracking-wide">
								Sort
							</span>
							{count > 0 ? (
								<button
									className="text-[11px] text-foreground-secondary hover:text-foreground hover:underline"
									onClick={() => onSortChange(null)}
									type="button"
								>
									Clear
								</button>
							) : null}
						</div>
						<SortSection onChange={onSortChange} value={sort} />
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
