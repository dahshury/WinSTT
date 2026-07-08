import type { CostBar } from "../lib/cost-analytics";
import { formatUsd } from "../lib/word-stats";

interface CostBarsProps {
	bars: CostBar[];
	/** Label for the rolled-up tail row (its key is `__other__`). */
	otherLabel: string;
}

// The pill's minimum share of its track, so the cheapest model still shows a
// sliver and its `$` stays legible.
const MIN_BAR_PCT = 10;

const OTHER_KEY = "__other__";

function barWidth(pct: number): string {
	return `${Math.max(MIN_BAR_PCT, pct)}%`;
}

// Rank-based teal fade, identical to `UsageBars`: the priciest model leads with
// the strongest fill and each row steps darker, so cost and usage bars read on
// one visual scale.
function barColor(index: number): string {
	const strength = Math.max(40, 70 - index * 7);
	return `color-mix(in oklch, var(--color-activity) ${strength}%, black)`;
}

/**
 * Spend-per-model bars — one row per model: a teal pill sized to its share of
 * the total spend (the `$` sits inside it) followed by the model id. Mirrors
 * {@link UsageBars} so the "which model cost more" view reads exactly like the
 * "which model was used more" view beside it. Renders nothing without data.
 */
export function CostBars({ bars, otherLabel }: CostBarsProps) {
	if (bars.length === 0) {
		return null;
	}

	return (
		<div className="flex flex-col gap-2">
			{bars.map((bar, index) => {
				const label = bar.key === OTHER_KEY ? otherLabel : bar.label;
				return (
					<div className="flex items-center gap-3" key={bar.key}>
						<span className="relative h-6 w-[55%] shrink-0 overflow-hidden rounded-md bg-surface-elevated">
							<span
								className="absolute inset-y-0 start-0 flex items-center rounded-md px-2"
								style={{
									backgroundColor: barColor(index),
									width: barWidth(bar.pct),
								}}
							>
								<span className="whitespace-nowrap font-medium font-mono text-2xs text-on-activity tabular-nums">
									{bar.estimate ? "~" : ""}
									{formatUsd(bar.cost)}
								</span>
							</span>
						</span>
						<span className="min-w-0 flex-1 truncate text-xs-tight">
							<span className="font-mono text-foreground-muted tabular-nums">
								{bar.pct}%
							</span>{" "}
							<span className="text-foreground-secondary">{label}</span>
						</span>
					</div>
				);
			})}
		</div>
	);
}
