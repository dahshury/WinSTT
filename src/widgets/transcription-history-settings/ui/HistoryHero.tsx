import {
	AiMagicIcon,
	DashboardSpeed02Icon,
	TextFontIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { type AggregateStats, formatDuration } from "../lib/word-stats";
import { Sparkline } from "./Sparkline";
import { WpmGauge } from "./WpmGauge";

interface HistoryHeroProps {
	stats: AggregateStats;
	/** Recent daily word totals (oldest → newest) for the total-words sparkline. */
	dailyWords: number[];
}

interface HeroCardProps {
	icon: IconSvgElement;
	label: string;
	children: ReactNode;
	/** Stagger ordinal — drives the fade-in delay so cards cascade in. */
	index: number;
}

/**
 * Shared chrome for a hero card: a neutral surface lifted one step above the
 * section with the icon chip lifted one step further, matching {@link StatTile}
 * so the hero row and the compact tile rows share one visual language.
 */
function HeroCard({ icon, label, children, index }: HeroCardProps) {
	const substrate = useSurface();
	const cardBg = surfaceBg(Math.min(substrate + 1, 8));
	const chipBg = surfaceBg(Math.min(substrate + 2, 8));

	return (
		<div
			className={`flex flex-col gap-2.5 overflow-hidden rounded-lg border border-divider ${cardBg} p-3 opacity-0 shadow-surface-2`}
			style={{ animation: `fade-in 320ms ease-out ${index * 70}ms forwards` }}
		>
			<div className="flex items-center gap-2">
				<div
					className={`flex size-[22px] shrink-0 items-center justify-center rounded-md ring-1 ring-inset ring-divider ${chipBg}`}
				>
					<HugeiconsIcon
						aria-hidden
						className="text-foreground-muted"
						icon={icon}
						size={12}
						strokeWidth={1.75}
					/>
				</div>
				<div className="line-clamp-1 min-w-0 font-mono text-[9.5px] text-foreground-muted uppercase leading-[1.25] tracking-[0.08em]">
					{label}
				</div>
			</div>
			{children}
		</div>
	);
}

function MiniRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-center justify-between gap-2 text-xs-tight">
			<span className="min-w-0 truncate text-foreground-muted">{label}</span>
			<span className="shrink-0 font-mono text-foreground-secondary tabular-nums">
				{value}
			</span>
		</div>
	);
}

const BIG_VALUE =
	"font-mono font-semibold text-[26px] text-foreground tabular-nums leading-none tracking-tight";

/**
 * The History dashboard hero: a words-per-minute gauge, an AI-impact card, and
 * a total-words card with a recent-trend sparkline. Together these surface the
 * seven headline numbers the old "Overall Stats" + "AI Impact" tile rows showed,
 * but with room to breathe and a visual focal point.
 */
export function HistoryHero({ stats, dailyWords }: HistoryHeroProps) {
	const t = useTranslations("history");

	return (
		<div className="grid grid-cols-3 gap-2">
			<HeroCard
				icon={DashboardSpeed02Icon}
				index={0}
				label={t("summaryOverallWpm")}
			>
				<div className="flex flex-1 items-center justify-center pt-1">
					<WpmGauge value={stats.wpm} />
				</div>
			</HeroCard>

			<HeroCard icon={AiMagicIcon} index={1} label={t("impactTitle")}>
				<div>
					<div className={BIG_VALUE}>{stats.aiFixes.toLocaleString()}</div>
					<div className="mt-1 text-foreground-secondary text-xs-tight">
						{t("impactAiFixes")}
					</div>
				</div>
				<div className="mt-auto flex flex-col gap-1.5 border-divider border-t pt-2.5">
					<MiniRow
						label={t("impactWordsCorrected")}
						value={stats.wordsCorrected.toLocaleString()}
					/>
					<MiniRow
						label={t("impactDictionaryFixes")}
						value={stats.dictionaryFixes.toLocaleString()}
					/>
				</div>
			</HeroCard>

			<HeroCard icon={TextFontIcon} index={2} label={t("summaryTotalWords")}>
				<div>
					<div className={BIG_VALUE}>{stats.totalWords.toLocaleString()}</div>
				</div>
				<Sparkline className="mt-auto h-7 w-full" values={dailyWords} />
				<div className="flex flex-col gap-1.5">
					<MiniRow
						label={t("summaryTotalEntries")}
						value={stats.count.toLocaleString()}
					/>
					<MiniRow
						label={t("summarySpeakingTime")}
						value={formatDuration(stats.totalDurationMs)}
					/>
				</div>
			</HeroCard>
		</div>
	);
}
