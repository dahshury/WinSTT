"use client";

import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { Tooltip } from "@/shared/ui/tooltip";

/** One discrete fact in a card's metadata line (params / size / language /
 *  context / price / a warning, etc.). Shared across all pickers. */
export interface MetaEntry {
	/** Tone override — e.g. a hardware-fit warning sets this to `text-error`. */
	className?: string;
	icon: IconSvgElement;
	key: string;
	tooltip: string;
	value: string;
}

/** The metadata-line container classes — shared so a picker composing a
 *  heterogeneous meta row (e.g. OpenRouter's variant badge + chips) matches the
 *  homogeneous {@link CardMetaRow} exactly. */
export const META_ROW_CLASSES =
	"flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-foreground-muted leading-tight";

/** The faint middot that separates facts in a metadata line. */
export function MetaSeparator() {
	return (
		<span aria-hidden="true" className="text-foreground-dim/40">
			·
		</span>
	);
}

/** A single fact: a dim leading glyph + value, full detail in the tooltip. A
 *  warning entry colours itself via `className`. */
export function MetaItem({
	className,
	icon,
	value,
	tooltip,
}: {
	className?: string | undefined;
	icon: IconSvgElement;
	tooltip: string;
	value: string;
}) {
	return (
		<Tooltip content={tooltip} side="top">
			<span className={cn("inline-flex shrink-0 items-center gap-1 tabular-nums", className)}>
				<HugeiconsIcon className="size-3 opacity-70" icon={icon} />
				{value}
			</span>
		</Tooltip>
	);
}

/**
 * The metadata line under a model name. Facts are middot-separated so the row
 * reads as one calm, scannable strip instead of a cluster of competing badges.
 * Subordinate to the name by size (11px) and tone (muted).
 */
export function CardMetaRow({ entries }: { entries: MetaEntry[] }) {
	const nodes: ReactNode[] = [];
	for (const [i, entry] of entries.entries()) {
		if (i > 0) {
			nodes.push(<MetaSeparator key={`sep-${entry.key}`} />);
		}
		nodes.push(
			<MetaItem
				className={entry.className}
				icon={entry.icon}
				key={entry.key}
				tooltip={entry.tooltip}
				value={entry.value}
			/>
		);
	}
	return <div className={META_ROW_CLASSES}>{nodes}</div>;
}
