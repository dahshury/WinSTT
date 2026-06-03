import { Cancel01Icon, CloudDownloadIcon, PauseIcon, PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, surfaceHoverBg, useSurface } from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";
import { Tooltip } from "@/shared/ui/tooltip";

/** Phase of the download workflow as seen by the action row.
 *  - `idle`   nothing on disk, nothing in flight → primary "Download"
 *  - `active` bytes are flowing right now        → "Stop"
 *  - `paused` partial bytes on disk, no flow     → "Discard" + "Resume" */
export type DownloadPhase = "idle" | "active" | "paused";

interface DownloadActionLabels {
	discard: string;
	download: string;
	resume: string;
	stop: string;
}

export interface DownloadActionsProps {
	/** Tooltip shown when hovering the destructive "Discard" button. Optional
	 *  because the dictation modal already has the explanation in the modal
	 *  body, but Ollama's list rows benefit from a hover hint. */
	discardTooltip?: string;
	labels: DownloadActionLabels;
	onDiscard: () => void;
	onDownload: () => void;
	onResume: () => void;
	onStop: () => void;
	phase: DownloadPhase;
	/** "sm" fits inside list rows (Ollama); "md" reads as a modal CTA. */
	size?: "sm" | "md";
}

const SIZE_CLASS: Record<NonNullable<DownloadActionsProps["size"]>, string> = {
	sm: "h-7 px-2.5 text-xs",
	md: "h-8 px-3 text-sm",
};

// Static part of the neutral button shell. The substrate-aware bg + hover-bg
// are composed in at render time via `useSurface()` so the button lifts
// correctly inside ElevatedSurface / nested containers.
const NEUTRAL_STATIC =
	"inline-flex items-center gap-1.5 rounded-md border border-border text-foreground-secondary transition-colors";
const ACCENT_BASE =
	"inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent font-medium text-white transition-colors hover:bg-accent-dim";

function actionIconSize(size: NonNullable<DownloadActionsProps["size"]>): number {
	return size === "sm" ? 13 : 14;
}

/** Tri-state action row. Renders only the phase-specific primary (+
 *  destructive) buttons — any modal-level dismiss button ("Cancel",
 *  "Close", "Hide") stays at the caller because it isn't a download
 *  concern. */
export function DownloadActions({
	phase,
	labels,
	discardTooltip,
	onDownload,
	onStop,
	onDiscard,
	onResume,
	size = "md",
}: DownloadActionsProps): ReactNode {
	const sizeCls = SIZE_CLASS[size];
	const iconSize = actionIconSize(size);
	const substrate = useSurface();
	const buttonLevel = Math.min(substrate + 1, 8);
	const buttonHover = Math.min(substrate + 2, 8);
	const neutralCls = cn(NEUTRAL_STATIC, surfaceBg(buttonLevel), surfaceHoverBg(buttonHover));
	const reduceMotion = useReducedMotion();
	let content: ReactNode;
	if (phase === "active") {
		content = (
			<Button className={cn(neutralCls, sizeCls)} onClick={onStop}>
				<HugeiconsIcon icon={PauseIcon} size={iconSize} />
				<span>{labels.stop}</span>
			</Button>
		);
	} else if (phase === "paused") {
		const discardButton = (
			<Button className={cn(neutralCls, sizeCls)} onClick={onDiscard}>
				<HugeiconsIcon icon={Cancel01Icon} size={iconSize} />
				<span>{labels.discard}</span>
			</Button>
		);
		content = (
			<div className="flex items-center gap-1.5">
				{discardTooltip ? (
					<Tooltip content={discardTooltip} side="top">
						{discardButton}
					</Tooltip>
				) : (
					discardButton
				)}
				<Button className={cn(ACCENT_BASE, sizeCls)} onClick={onResume}>
					<HugeiconsIcon icon={PlayIcon} size={iconSize} />
					<span>{labels.resume}</span>
				</Button>
			</div>
		);
	} else {
		content = (
			<Button className={cn(ACCENT_BASE, sizeCls)} onClick={onDownload}>
				<HugeiconsIcon icon={CloudDownloadIcon} size={iconSize} />
				<span>{labels.download}</span>
			</Button>
		);
	}
	return (
		<LazyMotion features={domAnimation} strict>
			<AnimatePresence initial={false} mode="wait">
				<m.div
					animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
					className="inline-flex items-center"
					exit={
						reduceMotion
							? { opacity: 1, transition: { duration: 0 } }
							: { opacity: 0, y: -3, filter: "blur(2px)", transition: { duration: 0.12 } }
					}
					initial={reduceMotion ? false : { opacity: 0, y: 3, filter: "blur(2px)" }}
					key={phase}
					transition={
						reduceMotion ? { duration: 0 } : { duration: 0.16, ease: [0.22, 1, 0.36, 1] }
					}
				>
					{content}
				</m.div>
			</AnimatePresence>
		</LazyMotion>
	);
}
