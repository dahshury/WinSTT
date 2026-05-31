import { Progress } from "@base-ui/react/progress";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";

/** "active" pulses the accent color; "paused" freezes a warning-tinted bar so
 *  a static fill can't be mistaken for an idle / finished one. */
type DownloadProgressVariant = "active" | "paused";

export interface DownloadProgressBarProps {
	/** Left-side caption, e.g. `"45% — Downloading"` or `"Paused at 60%"`.
	 *  Caller builds this so wording / i18n stays local. */
	label?: string;
	/** Integer 0–100, or null when the source can't report a percentage
	 *  yet (just-started downloads before HEAD lands). */
	percent: number | null;
	/** Right-side stats line, e.g. `"12 MB / 30 MB · 2 MB/s"`. Optional —
	 *  omit when the upstream protocol doesn't surface byte counters
	 *  (Ollama pulls don't). */
	statsLabel?: string;
	/** Optional override for the track background — defaults to
	 *  `bg-surface-tertiary` to match the Ollama list-row style. The
	 *  dictation modal passes a surface-elevation class so the bar
	 *  sits one level above the info card. */
	trackClassName?: string;
	variant: DownloadProgressVariant;
}

const FILL_CLASS: Record<DownloadProgressVariant, string> = {
	active: "h-full rounded-full bg-accent transition-[width] duration-150",
	paused: "h-full rounded-full bg-warning/60",
};

/** Track + fill + optional caption row. Purely presentational — callers
 *  pass pre-built strings; this component never decides labels itself. */
export function DownloadProgressBar({
	percent,
	label,
	statsLabel,
	variant,
	trackClassName,
}: DownloadProgressBarProps): ReactNode {
	const hasCaption = !!(label || statsLabel);
	// Substrate-aware default: track lifts one step above the surrounding
	// container so the bar reads as inset rather than blending in. Callers
	// can still override via `trackClassName` for special placements.
	const substrate = useSurface();
	const trackLevel = Math.min(substrate + 1, 8);
	return (
		<Progress.Root className="flex flex-col gap-1.5" value={percent}>
			<Progress.Track
				className={cn("h-2 overflow-hidden rounded-full", trackClassName ?? surfaceBg(trackLevel))}
			>
				<Progress.Indicator className={FILL_CLASS[variant]} />
			</Progress.Track>
			{hasCaption ? (
				<div className="flex items-center justify-between text-foreground-muted text-xs tabular-nums">
					<span>{label ?? ""}</span>
					{statsLabel ? <span className="font-mono">{statsLabel}</span> : null}
				</div>
			) : null}
		</Progress.Root>
	);
}
