import {
	DashboardSpeed02Icon,
	SpeechToTextIcon,
	StopWatchIcon,
	TextFontIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { type AggregateStats, formatDuration, formatWpm } from "../lib/word-stats";

interface HistorySummaryProps {
	stats: AggregateStats;
}

interface Tile {
	icon: IconSvgElement;
	label: string;
	unit?: string | undefined;
	value: string;
}

/**
 * Four summary stat tiles. Deliberately muted, fluidfunctionalism-grayscale:
 * no per-tile hues, no coloured left rail, no gradient glow wash. Each tile is
 * one neutral surface lifted a single step above the section it sits in, and
 * the icon chip lifts one step further so it reads as its own surface (the
 * surfaces concept) rather than a tinted badge floating on the card. A fixed
 * four-column grid keeps all four on one row inside the fixed-width settings
 * window — the old `grid-cols-2 sm:grid-cols-4` wrapped to a 2×2 block on the
 * narrow panel.
 */
export function HistorySummary({ stats }: HistorySummaryProps) {
	const t = useTranslations("history");
	const wpm = formatWpm(stats.wpm);
	const hasWpm = wpm !== "—";
	const substrate = useSurface();
	const tileBg = surfaceBg(Math.min(substrate + 1, 8));
	const chipBg = surfaceBg(Math.min(substrate + 2, 8));

	const tiles: Tile[] = [
		{
			icon: SpeechToTextIcon,
			label: t("summaryTotalEntries"),
			value: stats.count.toLocaleString(),
		},
		{
			icon: TextFontIcon,
			label: t("summaryTotalWords"),
			value: stats.totalWords.toLocaleString(),
		},
		{
			icon: StopWatchIcon,
			label: t("summarySpeakingTime"),
			value: formatDuration(stats.totalDurationMs),
		},
		{
			icon: DashboardSpeed02Icon,
			label: t("summaryOverallWpm"),
			value: wpm,
			unit: hasWpm ? "wpm" : undefined,
		},
	];

	return (
		<div className="grid grid-cols-4 gap-2">
			{tiles.map((tile, i) => (
				<div
					className={`group relative overflow-hidden rounded-lg border border-divider ${tileBg} opacity-0 shadow-surface-2 transition-[border-color,transform,box-shadow] duration-200 hover:-translate-y-px hover:border-border-hover hover:shadow-md`}
					key={tile.label}
					style={{ animation: `fade-in 320ms ease-out ${i * 70}ms forwards` }}
				>
					<div className="flex flex-col gap-2 px-2.5 py-2.5">
						<div className="flex items-center gap-2">
							<div
								className={`flex size-[22px] shrink-0 items-center justify-center rounded-md ring-1 ring-inset ring-divider ${chipBg}`}
							>
								<HugeiconsIcon
									aria-hidden
									className="text-foreground-muted"
									icon={tile.icon}
									size={12}
									strokeWidth={1.75}
								/>
							</div>
							<div className="line-clamp-2 min-w-0 break-words font-mono text-[9.5px] text-foreground-muted uppercase leading-[1.25] tracking-[0.08em]">
								{tile.label}
							</div>
						</div>
						<div className="flex items-baseline gap-1">
							<span className="font-mono font-semibold text-[18px] text-foreground tabular-nums leading-none tracking-tight">
								{tile.value}
							</span>
							{tile.unit ? (
								<span className="font-mono text-[9.5px] text-foreground-muted uppercase tracking-[0.1em]">
									{tile.unit}
								</span>
							) : null}
						</div>
					</div>
				</div>
			))}
		</div>
	);
}
