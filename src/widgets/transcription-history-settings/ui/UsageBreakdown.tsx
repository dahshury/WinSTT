import { AiCloud01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import type { UsageBucket } from "../lib/usage-breakdown";

interface UsageBarsProps {
	buckets: UsageBucket[];
	/** Optional leading icon per bucket, keyed by `UsageBucket.key`. */
	icons?: Record<string, IconSvgElement>;
}

/**
 * A bucket's leading mark: the model's uncolored maker logo (alpha-masked to the
 * muted foreground, mirroring the model chip) or the category icon, badged with
 * a small cloud sign when the model ran on a cloud provider. Cloud models with
 * no bundled maker logo fall back to a bare cloud glyph. Renders nothing when a
 * bucket has neither a logo, an icon, nor cloud provenance (e.g. "Other").
 */
function BucketGlyph({
	bucket,
	icon,
}: {
	bucket: UsageBucket;
	icon?: IconSvgElement | undefined;
}) {
	// Punch the cloud badge out with the surrounding surface so it notches
	// cleanly into the mark rather than muddying it.
	const badgeBg = surfaceBg(useSurface());
	let mark: ReactNode = null;
	if (bucket.logo) {
		mark = (
			<span
				aria-hidden="true"
				className="size-4 shrink-0 bg-foreground-muted [mask-image:var(--usage-logo)] [mask-position:center] [mask-repeat:no-repeat] [mask-size:contain] [-webkit-mask-image:var(--usage-logo)] [-webkit-mask-position:center] [-webkit-mask-repeat:no-repeat] [-webkit-mask-size:contain]"
				style={{ "--usage-logo": `url("${bucket.logo}")` } as CSSProperties}
			/>
		);
	} else if (icon) {
		mark = (
			<HugeiconsIcon
				className="shrink-0 text-foreground-muted"
				icon={icon}
				size={16}
			/>
		);
	} else if (bucket.cloud) {
		mark = (
			<HugeiconsIcon
				className="shrink-0 text-foreground-muted"
				icon={AiCloud01Icon}
				size={16}
			/>
		);
	}
	if (!mark) {
		return null;
	}
	// The bare cloud fallback already signals cloud — don't double-badge it.
	if (!(bucket.cloud && (bucket.logo || icon))) {
		return mark;
	}
	return (
		<span className="relative inline-flex shrink-0">
			{mark}
			<span
				aria-hidden="true"
				className={cn(
					"-right-1 -bottom-1 absolute inline-flex items-center justify-center rounded-full text-foreground-muted",
					badgeBg,
				)}
			>
				<HugeiconsIcon icon={AiCloud01Icon} size={9} />
			</span>
		</span>
	);
}

// The pill's share of its track. The floor keeps the "%" legible — and the
// pill visible — even at 0%.
const MIN_BAR_PCT = 12;

function barWidth(pct: number): string {
	return `${Math.max(MIN_BAR_PCT, pct)}%`;
}

// Rank-based teal fade: the leading bucket is the strongest, each row below it
// steps darker so the list reads as a gradient (matching the reference). Mixing
// the accent toward black keeps every fill dark enough for the white "%" to stay
// legible, while preserving the teal hue.
function barColor(index: number): string {
	const strength = Math.max(40, 70 - index * 7);
	return `color-mix(in oklch, var(--color-activity) ${strength}%, black)`;
}

/**
 * A Flow-style usage breakdown — one row per bucket: a teal pill sized to its
 * share of a full-width track (the "%" sits inside it), followed by the count
 * and an uppercased label. The shared track keeps every pill on one visual
 * scale and the labels in a tidy column. Renders nothing when there's no data,
 * so the caller can decide whether to show the surrounding section at all.
 */
export function UsageBars({ buckets, icons }: UsageBarsProps) {
	if (buckets.length === 0) {
		return null;
	}

	return (
		<div className="flex flex-col gap-2">
			{buckets.map((bucket, index) => {
				const icon = icons?.[bucket.key];
				return (
					<div className="flex items-center gap-3" key={bucket.key}>
						<BucketGlyph bucket={bucket} icon={icon} />
						<span className="relative h-6 w-[55%] shrink-0 overflow-hidden rounded-md bg-surface-elevated">
							<span
								className="absolute inset-y-0 start-0 flex items-center justify-center rounded-md px-2"
								style={{
									backgroundColor: barColor(index),
									width: barWidth(bucket.pct),
								}}
							>
								<span className="font-medium font-mono text-2xs text-on-activity tabular-nums">
									{bucket.pct}%
								</span>
							</span>
						</span>
						<span className="min-w-0 flex-1 truncate text-xs-tight uppercase tracking-wide">
							<span className="font-semibold text-foreground tabular-nums">
								{bucket.count}
							</span>{" "}
							<span className="text-foreground-secondary">{bucket.label}</span>
						</span>
					</div>
				);
			})}
		</div>
	);
}
