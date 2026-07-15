"use client";

import { Button as BaseButton } from "@base-ui/react/button";
import { ArrowUpDownIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, surfaceHoverBg, useSurface } from "@/shared/lib/surface";
import { SectionHeader } from "./FilterSectionHeader";

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
