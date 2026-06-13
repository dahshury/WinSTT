import type { UsageBucket } from "../lib/usage-breakdown";

interface UsageBarsProps {
	buckets: UsageBucket[];
}

/**
 * A Flow-style horizontal-bar breakdown — one labeled track per bucket, filled
 * to its share of the total. Renders nothing when there's no data, so the
 * caller can decide whether to show the surrounding section at all.
 */
export function UsageBars({ buckets }: UsageBarsProps) {
	if (buckets.length === 0) {
		return null;
	}

	return (
		<div className="flex flex-col gap-2">
			{buckets.map((bucket) => (
				<div className="flex items-center gap-3" key={bucket.key}>
					<span className="w-32 shrink-0 truncate text-foreground-secondary text-xs-tight">
						{bucket.label}
					</span>
					<span className="relative h-2 flex-1 overflow-hidden rounded-full bg-surface-elevated">
						<span
							className="absolute inset-y-0 left-0 rounded-full bg-teal"
							style={{ width: `${bucket.pct}%` }}
						/>
					</span>
					<span className="w-9 shrink-0 text-right font-mono text-foreground-muted text-xs-tight tabular-nums">
						{bucket.pct}%
					</span>
				</div>
			))}
		</div>
	);
}
