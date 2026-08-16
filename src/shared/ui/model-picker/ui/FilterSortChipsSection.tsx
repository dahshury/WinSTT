"use client";

import { Button as BaseButton } from "@base-ui/react/button";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, surfaceHoverBg, useSurface } from "@/shared/lib/surface";

/**
 * The "Sort by" view of a filter menu: the hint, then one chip per dimension.
 * Single-select and nullable — pressing the active chip returns to the picker's
 * default grouped ordering, which is what the hint spells out.
 *
 * The active chip (or the first, when sorting is off) carries the view's
 * initial focus so arriving here by keyboard lands on the current value rather
 * than the back button.
 */
export function SortChipsSection<TSortKey extends string>({
	hint,
	icons,
	keys,
	labels,
	onChange,
	value,
}: {
	hint: string;
	icons: Record<TSortKey, IconSvgElement>;
	keys: readonly TSortKey[];
	labels: Record<TSortKey, string>;
	onChange: (next: TSortKey | null) => void;
	value: TSortKey | null;
}) {
	const level = useSurface();
	const idleChip = cn(
		surfaceBg(Math.min(level + 1, 8)),
		surfaceHoverBg(Math.min(level + 2, 8)),
		"text-foreground-secondary ring-divider hover:text-foreground hover:ring-border",
	);
	const focusKey = value ?? keys[0];
	return (
		<div className="flex flex-col gap-2 p-2 pt-1">
			<p className="text-[11px] text-foreground-muted leading-snug">{hint}</p>
			<div className="flex flex-wrap gap-1.5">
				{keys.map((key) => {
					const isOn = value === key;
					return (
						<BaseButton
							aria-pressed={isOn}
							className={cn(
								"inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 font-medium text-[11px] leading-none outline-none ring-1 transition-colors focus-visible:ring-2 focus-visible:ring-accent",
								isOn ? "bg-accent/15 text-accent ring-accent/40" : idleChip,
							)}
							data-nav-initial-focus={key === focusKey ? "" : undefined}
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
