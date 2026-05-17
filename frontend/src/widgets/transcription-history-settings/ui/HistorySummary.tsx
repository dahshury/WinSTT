"use client";

import {
	DashboardSpeed02Icon,
	SpeechToTextIcon,
	StopWatchIcon,
	TextFontIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "next-intl";
import { type AggregateStats, formatDuration, formatWpm } from "@/entities/transcription-history";

interface HistorySummaryProps {
	stats: AggregateStats;
}

type Accent = "accent" | "purple" | "teal" | "success";

interface Tile {
	accent: Accent;
	icon: IconSvgElement;
	label: string;
	unit?: string;
	value: string;
}

interface AccentStyle {
	chipBg: string;
	chipRing: string;
	glow: string;
	hoverBorder: string;
	iconColor: string;
	rail: string;
}

const ACCENT_STYLES: Record<Accent, AccentStyle> = {
	accent: {
		rail: "bg-accent",
		chipBg: "bg-accent/12",
		chipRing: "ring-accent/35",
		iconColor: "text-accent",
		glow: "from-accent/12 via-accent/4 to-transparent",
		hoverBorder: "group-hover:border-accent/40",
	},
	purple: {
		rail: "bg-purple",
		chipBg: "bg-purple/12",
		chipRing: "ring-purple/35",
		iconColor: "text-purple",
		glow: "from-purple/12 via-purple/4 to-transparent",
		hoverBorder: "group-hover:border-purple/40",
	},
	teal: {
		rail: "bg-teal",
		chipBg: "bg-teal/15",
		chipRing: "ring-teal/35",
		iconColor: "text-teal",
		glow: "from-teal/12 via-teal/4 to-transparent",
		hoverBorder: "group-hover:border-teal/40",
	},
	success: {
		rail: "bg-success",
		chipBg: "bg-success/12",
		chipRing: "ring-success/35",
		iconColor: "text-success",
		glow: "from-success/12 via-success/4 to-transparent",
		hoverBorder: "group-hover:border-success/40",
	},
};

export function HistorySummary({ stats }: HistorySummaryProps) {
	const t = useTranslations("history");
	const wpm = formatWpm(stats.wpm);
	const hasWpm = wpm !== "—";

	const tiles: Tile[] = [
		{
			icon: SpeechToTextIcon,
			label: t("summaryTotalEntries"),
			value: stats.count.toLocaleString(),
			accent: "accent",
		},
		{
			icon: TextFontIcon,
			label: t("summaryTotalWords"),
			value: stats.totalWords.toLocaleString(),
			accent: "purple",
		},
		{
			icon: StopWatchIcon,
			label: t("summarySpeakingTime"),
			value: formatDuration(stats.totalDurationMs),
			accent: "teal",
		},
		{
			icon: DashboardSpeed02Icon,
			label: t("summaryOverallWpm"),
			value: wpm,
			unit: hasWpm ? "wpm" : undefined,
			accent: "success",
		},
	];

	return (
		<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
			{tiles.map((tile, i) => {
				const a = ACCENT_STYLES[tile.accent];
				return (
					<div
						className={`group relative overflow-hidden rounded-md border border-border bg-surface-primary opacity-0 shadow-surface-3 transition-[border-color,transform,box-shadow] duration-200 hover:-translate-y-px hover:shadow-md ${a.hoverBorder}`}
						key={tile.label}
						style={{ animation: `fade-in 320ms ease-out ${i * 70}ms forwards` }}
					>
						<div
							aria-hidden
							className={`pointer-events-none absolute inset-0 bg-gradient-to-br opacity-70 transition-opacity duration-300 group-hover:opacity-100 ${a.glow}`}
						/>
						<div aria-hidden className={`absolute top-0 bottom-0 left-0 w-[2px] ${a.rail}`} />
						<div className="relative flex flex-col gap-2.5 px-3 py-2.5 pl-[14px]">
							<div className="flex items-start gap-2">
								<div
									className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[5px] ring-1 ring-inset ${a.chipBg} ${a.chipRing}`}
								>
									<HugeiconsIcon
										aria-hidden
										className={a.iconColor}
										icon={tile.icon}
										size={12}
										strokeWidth={1.75}
									/>
								</div>
								<div className="line-clamp-2 min-w-0 break-words font-mono text-[10px] text-foreground-muted uppercase leading-[1.25] tracking-[0.1em]">
									{tile.label}
								</div>
							</div>
							<div className="flex items-baseline gap-1.5">
								<span className="font-mono font-semibold text-[22px] text-foreground tabular-nums leading-none tracking-tight">
									{tile.value}
								</span>
								{tile.unit ? (
									<span className="font-mono text-[10px] text-foreground-muted uppercase tracking-[0.12em]">
										{tile.unit}
									</span>
								) : null}
							</div>
						</div>
					</div>
				);
			})}
		</div>
	);
}
