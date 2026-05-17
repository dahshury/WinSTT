"use client";

import { Cancel01Icon, CloudDownloadIcon, PauseIcon, PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Tooltip } from "@/shared/ui/tooltip";

/** Phase of the download workflow as seen by the action row.
 *  - `idle`   nothing on disk, nothing in flight → primary "Download"
 *  - `active` bytes are flowing right now        → "Stop"
 *  - `paused` partial bytes on disk, no flow     → "Discard" + "Resume" */
export type DownloadPhase = "idle" | "active" | "paused";

export interface DownloadActionLabels {
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

const NEUTRAL_BASE =
	"inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-secondary text-foreground-secondary transition-colors hover:bg-surface-hover";
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
	if (phase === "active") {
		return (
			<Button className={cn(NEUTRAL_BASE, sizeCls)} onClick={onStop}>
				<HugeiconsIcon icon={PauseIcon} size={iconSize} />
				<span>{labels.stop}</span>
			</Button>
		);
	}
	if (phase === "paused") {
		const discardButton = (
			<Button className={cn(NEUTRAL_BASE, sizeCls)} onClick={onDiscard}>
				<HugeiconsIcon icon={Cancel01Icon} size={iconSize} />
				<span>{labels.discard}</span>
			</Button>
		);
		return (
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
	}
	return (
		<Button className={cn(ACCENT_BASE, sizeCls)} onClick={onDownload}>
			<HugeiconsIcon icon={CloudDownloadIcon} size={iconSize} />
			<span>{labels.download}</span>
		</Button>
	);
}
