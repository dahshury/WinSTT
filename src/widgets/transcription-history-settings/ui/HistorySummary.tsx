import {
	DashboardSpeed02Icon,
	SpeechToTextIcon,
	StopWatchIcon,
	TextFontIcon,
} from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import {
	type AggregateStats,
	formatDuration,
	formatWpm,
} from "../lib/word-stats";
import { StatTile, type StatTileData } from "./StatTile";

interface HistorySummaryProps {
	stats: AggregateStats;
}

/**
 * Four summary stat tiles (entries · words · speaking time · WPM). The tile
 * styling lives in the shared {@link StatTile} so this row and the "AI Impact"
 * row stay pixel-identical. A fixed four-column grid keeps all four on one row
 * inside the fixed-width settings window.
 */
export function HistorySummary({ stats }: HistorySummaryProps) {
	const t = useTranslations("history");
	const wpm = formatWpm(stats.wpm);
	const hasWpm = wpm !== "—";

	const tiles: StatTileData[] = [
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
				<StatTile key={tile.label} {...tile} index={i} />
			))}
		</div>
	);
}
