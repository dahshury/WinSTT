import { Button as BaseButton } from "@base-ui/react/button";
import type { ReactNode } from "react";
import type { DownloadAggregate } from "@/features/model-download";
import { surfaceHoverBg, useSurface } from "@/shared/lib/surface";
import { PulseDot } from "@/shared/ui/pulse-dot";
import { Tooltip } from "@/shared/ui/tooltip";
import {
	MODEL_PICKER_TRIGGER_SLOT,
	useModelPickerTrigger,
} from "./footer-model-picker-trigger";
import { FOOTER_TOOLTIP_DELAY } from "./FooterMenuChip";

interface ModelSwapChipProps {
	label: string;
	tooltip: string;
}

/** Read-only chip shown in place of the model chip while a swap is in
 *  flight. Same compact footprint so the bar doesn't shift. */
export function ModelSwapChip({
	label,
	tooltip,
}: ModelSwapChipProps): ReactNode {
	return (
		<Tooltip content={tooltip} delay={FOOTER_TOOLTIP_DELAY} side="top">
			<span
				aria-live="polite"
				className="flex max-w-full cursor-default select-none items-center gap-1 rounded-xs bg-transparent px-1 py-[1px] text-2xs text-foreground-secondary"
			>
				<PulseDot className="size-1.5 text-accent" />
				<span className="min-w-0 truncate">{label}</span>
			</span>
		</Tooltip>
	);
}

interface FooterDownloadChipProps {
	aggregate: DownloadAggregate;
	ariaLabel: string;
	primaryModelName: string;
	tooltip: string;
}

/** Footer chip variant rendered while at least one per-quant or whole-model
 *  download is streaming. Same clickable shape as ``FooterModelChip`` (so
 *  the user can pop the picker open to inspect per-quant detail) but with
 *  a pulsing download dot, the active model's name (or "N downloads" when
 *  parallel), and a tabular percent on the right.
 *
 *  Parallel-download UX: each badge inside the picker keeps its own
 *  progress fill; this chip is the at-a-glance summary for users who've
 *  dismissed the picker and want to see "how close are we" without
 *  re-opening it. ``aggregate.averagePercent`` is the mean across every
 *  known-percent download so a long-tail download doesn't drag the chip's
 *  reported progress backwards every time a new (small) download starts.
 *
 *  Clicking still routes through ``FooterModelChip`` semantics — sends the
 *  bounding rect to main, which positions the detached picker window
 *  above the chip. */
export function FooterDownloadChip({
	aggregate,
	ariaLabel,
	primaryModelName,
	tooltip,
}: FooterDownloadChipProps): ReactNode {
	const substrate = useSurface();
	const hoverLevel = Math.min(substrate + 2, 8);
	const open = useModelPickerTrigger();
	const multi = aggregate.count >= 2;
	const label = multi ? `${aggregate.count} downloads` : primaryModelName;
	const reportedPercent = multi
		? aggregate.averagePercent
		: aggregate.primary.percent;
	return (
		<Tooltip content={tooltip} delay={FOOTER_TOOLTIP_DELAY} side="top">
			<BaseButton
				aria-label={ariaLabel}
				aria-live="polite"
				className={`flex max-w-full cursor-pointer select-none items-center gap-1 rounded-xs bg-transparent px-1 py-[1px] text-2xs text-foreground-secondary outline-none transition-colors ${surfaceHoverBg(hoverLevel)} focus-visible:ring-1 focus-visible:ring-accent`}
				data-slot={MODEL_PICKER_TRIGGER_SLOT}
				onClick={open}
				type="button"
			>
				<PulseDot className="size-1.5 text-accent" />
				<span className="min-w-0 truncate">{label}</span>
				<span className="shrink-0 font-mono tabular-nums">
					{reportedPercent === null ? "…" : `${reportedPercent}%`}
				</span>
			</BaseButton>
		</Tooltip>
	);
}
