"use client";

import { DashboardSpeed02Icon, Target02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { performanceScoreColor } from "@/shared/lib/performance-color";
import { Tooltip } from "@/shared/ui/tooltip";

interface PerfBarsProps {
	accuracyScore: number;
	speedScore: number;
}

interface PerfBarProps {
	icon: IconSvgElement;
	label: string;
	score: number;
}

/**
 * One read-only metric as a compact horizontal module: a dim metaphor glyph, a
 * muted-coloured fill bar, and the percentage echoed in the bar's own colour.
 * Uses horizontal space instead of stacking another full-width row.
 */
function PerfBar({ icon, label, score }: PerfBarProps) {
	const pct = Math.round(score * 100);
	const color = performanceScoreColor(score);
	return (
		<Tooltip content={`${label} ${pct}%`} side="top">
			<div
				aria-label={`${label} ${pct}%`}
				className="flex items-center gap-1.5"
			>
				<HugeiconsIcon
					aria-hidden="true"
					className="size-3 shrink-0 text-foreground-dim"
					icon={icon}
				/>
				<div className="relative h-1 w-14 overflow-hidden rounded-full bg-foreground/[0.08]">
					<span
						aria-hidden="true"
						className="absolute inset-y-0 left-0 rounded-full"
						style={{ width: `${pct}%`, backgroundColor: color }}
					/>
				</div>
				<span
					className="w-8 shrink-0 text-end font-semibold text-[10px] tabular-nums"
					style={{ color }}
				>
					{pct}%
				</span>
			</div>
		</Tooltip>
	);
}

/**
 * The speed + accuracy module pinned to a card's top-right. Hidden when the
 * catalog reports the unknown-default 0.5/0.5 because two half-full bars on
 * every variant would teach the user to ignore them.
 */
export function PerfBars({ speedScore, accuracyScore }: PerfBarsProps) {
	const hasSignal = speedScore !== 0.5 || accuracyScore !== 0.5;
	if (!hasSignal) {
		return null;
	}
	return (
		<div className="flex shrink-0 flex-col gap-1">
			<PerfBar icon={Target02Icon} label="Accuracy" score={accuracyScore} />
			<PerfBar icon={DashboardSpeed02Icon} label="Speed" score={speedScore} />
		</div>
	);
}
