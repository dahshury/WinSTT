"use client";

import { useTranslations } from "next-intl";
import { type AggregateStats, formatDuration, formatWpm } from "@/entities/transcription-history";

interface HistorySummaryProps {
	stats: AggregateStats;
}

interface Tile {
	label: string;
	value: string;
}

export function HistorySummary({ stats }: HistorySummaryProps) {
	const t = useTranslations("history");

	const tiles: Tile[] = [
		{ label: t("summaryTotalEntries"), value: stats.count.toLocaleString() },
		{ label: t("summaryTotalWords"), value: stats.totalWords.toLocaleString() },
		{ label: t("summarySpeakingTime"), value: formatDuration(stats.totalDurationMs) },
		{ label: t("summaryOverallWpm"), value: formatWpm(stats.wpm) },
	];

	return (
		<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
			{tiles.map((tile) => (
				<div
					className="rounded-md border border-border bg-surface-primary px-3 py-2"
					key={tile.label}
				>
					<div className="font-mono text-foreground-muted text-xs-tight uppercase tracking-wider">
						{tile.label}
					</div>
					<div className="mt-0.5 font-mono font-semibold text-foreground text-lg tabular-nums">
						{tile.value}
					</div>
				</div>
			))}
		</div>
	);
}
