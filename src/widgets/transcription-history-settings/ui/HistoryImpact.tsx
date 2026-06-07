import {
	AiMagicIcon,
	BookOpen01Icon,
	PencilEdit01Icon,
} from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import type { AggregateStats } from "../lib/word-stats";
import { StatTile, type StatTileData } from "./StatTile";

interface HistoryImpactProps {
	stats: AggregateStats;
}

/**
 * "AI Impact" stat tiles — what the cleanup pass actually did across the
 * selected history: transcriptions it fixed, words it corrected, and
 * dictionary replacement-pair substitutions it applied. Reuses {@link StatTile}
 * so it sits flush with the "Overall Stats" row above it; a three-column grid
 * keeps all three on one line in the fixed-width settings window.
 */
export function HistoryImpact({ stats }: HistoryImpactProps) {
	const t = useTranslations("history");

	const tiles: StatTileData[] = [
		{
			icon: AiMagicIcon,
			label: t("impactAiFixes"),
			value: stats.aiFixes.toLocaleString(),
		},
		{
			icon: PencilEdit01Icon,
			label: t("impactWordsCorrected"),
			value: stats.wordsCorrected.toLocaleString(),
		},
		{
			icon: BookOpen01Icon,
			label: t("impactDictionaryFixes"),
			value: stats.dictionaryFixes.toLocaleString(),
		},
	];

	return (
		<div className="grid grid-cols-3 gap-2">
			{tiles.map((tile, i) => (
				<StatTile key={tile.label} {...tile} index={i} />
			))}
		</div>
	);
}
