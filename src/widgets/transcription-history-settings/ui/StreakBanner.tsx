import { FireIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import type { StreakStats } from "../lib/streak";

interface StreakBannerProps {
	streak: StreakStats;
}

/**
 * The "N day streak / longest M days" banner above the activity heatmap. The
 * current streak is the focal number; the longest streak sits quietly to the
 * side as the personal best to beat.
 */
export function StreakBanner({ streak }: StreakBannerProps) {
	const t = useTranslations("history");

	return (
		<div className="flex items-end justify-between gap-3">
			<div className="flex items-center gap-2.5">
				<HugeiconsIcon
					aria-hidden
					className={
						streak.current > 0 ? "text-activity" : "text-foreground-muted"
					}
					icon={FireIcon}
					size={22}
					strokeWidth={1.75}
				/>
				<div className="flex items-baseline gap-1.5">
					<span className="font-mono font-semibold text-[24px] text-foreground tabular-nums leading-none">
						{streak.current.toLocaleString()}
					</span>
					<span className="text-body-sm text-foreground-secondary">
						{t("streakLabel")}
					</span>
				</div>
			</div>
			<div className="text-right">
				<div className="font-mono text-[9.5px] text-foreground-muted uppercase tracking-[0.09em]">
					{t("longestStreakLabel")}
				</div>
				<div className="mt-0.5 font-mono text-body-sm text-foreground">
					{t("streakDaysUnit", { count: streak.longest })}
				</div>
			</div>
		</div>
	);
}
