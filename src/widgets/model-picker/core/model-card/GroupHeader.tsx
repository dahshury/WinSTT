"use client";

import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { GROUP_HEADER_CLASSES } from "./card-constants";

export interface GroupHeaderProps {
	className?: string | undefined;
	"data-rail-section"?: string | undefined;
	/** Fully-styled leading icon — a logo `<img>`, a {@link NeutralHeaderIcon}
	 *  gray chip, or the amber favourites chip. */
	icon: ReactNode;
	label: string;
	/** Optional dim middot suffix, e.g. `· Whisper` or `· 3 models`. */
	subtitle?: ReactNode;
}

/**
 * The sticky section/group header — shared across every picker so the headers
 * dock identically while scrolling. The caller supplies the leading `icon`
 * (logo / neutral chip / amber favourites chip); this renders the bar + the
 * uppercase tracked label + a dim middot subtitle.
 */
export function GroupHeader({
	className,
	"data-rail-section": railSection,
	icon,
	label,
	subtitle,
}: GroupHeaderProps) {
	return (
		<div
			className={cn(GROUP_HEADER_CLASSES, className)}
			data-rail-section={railSection}
		>
			{icon}
			<span className="font-semibold text-[10px] text-foreground-muted uppercase tracking-[0.12em]">
				{label}
			</span>
			{subtitle ? (
				<span className="text-[10px] text-foreground-dim">{subtitle}</span>
			) : null}
		</div>
	);
}

/** The neutral gray icon chip used for maker/section headers without a brand
 *  logo (and the lone-tint amber variant via `tone="favorites"`). */
export function NeutralHeaderIcon({
	icon,
	tone = "neutral",
}: {
	icon: IconSvgElement;
	tone?: "neutral" | "favorites";
}) {
	return (
		<span
			className={cn(
				"flex size-4 items-center justify-center rounded",
				tone === "favorites"
					? "bg-amber-400/[0.12] text-amber-400"
					: "bg-foreground/[0.06] text-foreground-muted",
			)}
		>
			<HugeiconsIcon
				className={cn("size-3", tone === "favorites" && "fill-amber-400")}
				icon={icon}
			/>
		</span>
	);
}
