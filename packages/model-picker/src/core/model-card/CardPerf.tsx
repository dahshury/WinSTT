"use client";

import { DashboardSpeed02Icon, Target02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Tooltip } from "@/shared/ui/tooltip";

interface PerfBarsProps {
	accuracyScore: number;
	speedScore: number;
}

/**
 * Map a 0..1 score to a MUTED health-bar colour — soft rose (worst) → soft
 * amber (mid) → soft sage (best). Each channel is pulled toward a mid-grey so
 * the bars read as gently-tinted signals inside the otherwise-grayscale card
 * rather than a neon rainbow. Higher is better, so a fast-but-sloppy model
 * shows a sage speed bar over a rose accuracy bar at a glance.
 */
function scoreColor(score: number): string {
	const t = Math.max(0, Math.min(1, score));
	const mix = (a: number, b: number, k: number): number => Math.round(a + (b - a) * k);
	if (t < 0.5) {
		// rose (188,108,108) → amber (190,162,104)
		const k = t * 2;
		return `rgb(${mix(188, 190, k)}, ${mix(108, 162, k)}, ${mix(108, 104, k)})`;
	}
	// amber (190,162,104) → sage (120,176,138)
	const k = (t - 0.5) * 2;
	return `rgb(${mix(190, 120, k)}, ${mix(162, 176, k)}, ${mix(104, 138, k)})`;
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
	const color = scoreColor(score);
	return (
		<Tooltip content={`${label} ${pct}%`} side="top">
			<div aria-label={`${label} ${pct}%`} className="flex items-center gap-1.5" role="img">
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
 * catalog reports the unknown-default 0.5/0.5 — two half-full bars on every
 * variant would just teach the user to ignore them.
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
