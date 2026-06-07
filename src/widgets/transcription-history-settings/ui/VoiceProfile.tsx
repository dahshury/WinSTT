import {
	CalendarClockIcon,
	PencilEdit01Icon,
	TextFontIcon,
	VoiceIcon,
} from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import { useLocaleStore } from "@/shared/i18n";
import type { PeakTime, VoiceProfileStats, WordCount } from "../lib/voice-profile";
import { StatTile, type StatTileData } from "./StatTile";

interface VoiceProfileProps {
	stats: VoiceProfileStats;
}

const EMPTY = "—";

// 2024-01-07 is a Sunday, so adding `dayOfWeek` (0=Sun) lands on the right
// weekday — a stable reference week for formatting a (weekday, hour) bucket.
function formatPeakTime(peak: PeakTime | null, locale: string): string {
	if (peak === null) {
		return EMPTY;
	}
	const date = new Date(2024, 0, 7 + peak.dayOfWeek, peak.hour);
	return new Intl.DateTimeFormat(locale, { hour: "numeric", weekday: "short" }).format(date);
}

/**
 * "Voice Profile" — a personality snapshot of the selected history, computed
 * entirely on the client: the word you lean on, your distinctive catchphrase,
 * the word the AI most often fixes for you, and when you dictate most. Reuses
 * {@link StatTile} so it sits flush with the stat rows above; a two-column grid
 * gives the word/time values room to breathe.
 */
export function VoiceProfile({ stats }: VoiceProfileProps) {
	const t = useTranslations("history");
	const locale = useLocaleStore((s) => s.locale);

	const wordTile = (word: WordCount | null): Pick<StatTileData, "unit" | "value"> =>
		word === null
			? { value: EMPTY }
			: { unit: `${word.count.toLocaleString()}×`, value: word.word };

	const tiles: StatTileData[] = [
		{ icon: TextFontIcon, label: t("profileMostUsedWord"), ...wordTile(stats.mostUsedWord) },
		{ icon: VoiceIcon, label: t("profileCatchphrase"), ...wordTile(stats.catchphrase) },
		{
			icon: PencilEdit01Icon,
			label: t("profileMostCorrectedWord"),
			...wordTile(stats.mostCorrectedWord),
		},
		{
			icon: CalendarClockIcon,
			label: t("profilePeakTime"),
			value: formatPeakTime(stats.peakTime, locale),
		},
	];

	return (
		<div className="grid grid-cols-2 gap-2">
			{tiles.map((tile, i) => (
				<StatTile key={tile.label} {...tile} index={i} />
			))}
		</div>
	);
}
