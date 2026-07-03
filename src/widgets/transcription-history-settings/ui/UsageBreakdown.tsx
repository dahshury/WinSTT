import {
	Briefcase01Icon,
	File01Icon,
	InfinityIcon,
	AiMagicIcon,
	BubbleChatIcon,
	Mail01Icon,
	Note01Icon,
	SourceCodeIcon,
	TaskDone01Icon,
	UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { UsageBucket } from "../lib/usage-breakdown";

/**
 * Leading glyph per content category, keyed by the history-tag id (see
 * `historyTagLabel`). Pass to `UsageBars` for the categories breakdown; the
 * models breakdown leaves it off (model ids have no fixed icon). The rolled-up
 * "Other" row reuses the infinity glyph.
 */
export const CATEGORY_ICONS: Record<string, IconSvgElement> = {
	ai_prompt: AiMagicIcon,
	code: SourceCodeIcon,
	document: File01Icon,
	email: Mail01Icon,
	meeting: UserGroupIcon,
	note: Note01Icon,
	other: InfinityIcon,
	personal_message: BubbleChatIcon,
	task: TaskDone01Icon,
	work_message: Briefcase01Icon,
	__other__: InfinityIcon,
};

interface UsageBarsProps {
	buckets: UsageBucket[];
	/** Optional leading icon per bucket, keyed by `UsageBucket.key`. */
	icons?: Record<string, IconSvgElement>;
}

// Bar geometry: a full-share bucket (pct = 100) fills this fraction of the row,
// leaving the rest for the count + label. The floor keeps the "%" legible — and
// the pill visible — even at 0%.
const BAR_ZONE_PCT = 60;
const MIN_BAR_PCT = 9;

function barWidth(pct: number): string {
	return `${Math.max(MIN_BAR_PCT, (pct / 100) * BAR_ZONE_PCT)}%`;
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
 * A Flow-style usage breakdown — one row per bucket: a teal pill whose width is
 * its share of the total (the "%" sits inside it), followed by the count and an
 * uppercased label. Renders nothing when there's no data, so the caller can
 * decide whether to show the surrounding section at all.
 */
export function UsageBars({ buckets, icons }: UsageBarsProps) {
	if (buckets.length === 0) {
		return null;
	}

	return (
		<div className="flex flex-col gap-1.5">
			{buckets.map((bucket, index) => {
				const icon = icons?.[bucket.key];
				return (
					<div className="flex items-center gap-3" key={bucket.key}>
						{icon ? (
							<HugeiconsIcon
								className="shrink-0 text-foreground-muted"
								icon={icon}
								size={16}
							/>
						) : null}
						<span
							className="flex h-6 shrink-0 items-center justify-center overflow-hidden rounded-md px-2"
							style={{
								backgroundColor: barColor(index),
								width: barWidth(bucket.pct),
							}}
						>
							<span className="font-medium font-mono text-2xs text-on-activity tabular-nums">
								{bucket.pct}%
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
