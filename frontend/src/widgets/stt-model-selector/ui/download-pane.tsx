"use client";

import {
	CloudDownloadIcon,
	Delete02Icon,
	PlayIcon,
	StopCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/shared/lib/cn";
import { Tooltip } from "@/shared/ui/tooltip";

/**
 * Tri-state phase of a model row's download UI. ``active`` lights up while
 * the server is actively pulling bytes; ``paused`` covers a partial cache
 * (download interrupted or stopped); ``idle`` is the default — nothing on
 * disk yet, no live transfer in flight.
 */
export type DownloadPhase = "active" | "paused" | "idle";

interface DownloadProgressBarProps {
	className?: string;
	/** Short caption rendered above the bar, e.g. ``"45% — Downloading"``. */
	label: string;
	/** 0–100, integer percent. ``null`` renders an indeterminate bar. */
	percent: number | null;
	variant?: "active" | "paused";
}

/**
 * Thin progress bar + caption row. Used inline on a model card while a
 * download is in flight, and on the same card when a partial cache is
 * waiting to be resumed.
 */
export function DownloadProgressBar({
	label,
	percent,
	variant = "active",
	className,
}: DownloadProgressBarProps) {
	const trackClass = variant === "paused" ? "bg-amber-500/15" : "bg-accent/15";
	const fillClass = variant === "paused" ? "bg-amber-500" : "bg-accent";
	const indeterminate = percent === null;
	const width = indeterminate ? 100 : Math.max(0, Math.min(100, percent));
	return (
		<div className={cn("flex flex-col gap-1", className)}>
			<div className="flex items-center justify-between gap-2 font-medium text-[10.5px] text-foreground-secondary tabular-nums leading-none">
				<span className="truncate">{label}</span>
			</div>
			<div className={cn("relative h-1 overflow-hidden rounded-full", trackClass)}>
				<span
					className={cn(
						"absolute inset-y-0 left-0 block rounded-full transition-[width] duration-300 ease-out",
						fillClass,
						indeterminate && "animate-pulse"
					)}
					style={{ width: `${width}%` }}
				/>
			</div>
		</div>
	);
}

interface DownloadActionsProps {
	onDiscard: () => void;
	onDownload: () => void;
	onResume: () => void;
	onStop: () => void;
	phase: DownloadPhase;
}

const ACTION_BUTTON_BASE = cn(
	"inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border px-2",
	"font-medium text-[10.5px] leading-none transition-colors",
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
);

const PRIMARY = "border-accent/40 bg-accent/15 text-accent hover:bg-accent/25";
const NEUTRAL =
	"border-border bg-surface-secondary/60 text-foreground-secondary hover:bg-surface-hover";
const DANGER = "border-error/40 bg-error/10 text-error hover:bg-error/20";

/**
 * Stop / Resume / Discard / Download button cluster — what shows depends
 * on ``phase``. Buttons stop propagation so the card's ``onClick`` (which
 * selects the model) doesn't fire when the user taps the action row.
 */
export function DownloadActions({
	phase,
	onDownload,
	onStop,
	onResume,
	onDiscard,
}: DownloadActionsProps) {
	const stop = (e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
	};
	if (phase === "active") {
		return (
			<div className="flex shrink-0 items-center gap-1.5">
				<Tooltip content="Stop the download" side="top">
					<button
						className={cn(ACTION_BUTTON_BASE, DANGER)}
						onClick={(e) => {
							stop(e);
							onStop();
						}}
						type="button"
					>
						<HugeiconsIcon className="size-3" icon={StopCircleIcon} />
						Stop
					</button>
				</Tooltip>
			</div>
		);
	}
	if (phase === "paused") {
		return (
			<div className="flex shrink-0 items-center gap-1.5">
				<Tooltip content="Resume from where the download left off" side="top">
					<button
						className={cn(ACTION_BUTTON_BASE, PRIMARY)}
						onClick={(e) => {
							stop(e);
							onResume();
						}}
						type="button"
					>
						<HugeiconsIcon className="size-3" icon={PlayIcon} />
						Resume
					</button>
				</Tooltip>
				<Tooltip content="Delete the partial download from disk" side="top">
					<button
						className={cn(ACTION_BUTTON_BASE, NEUTRAL)}
						onClick={(e) => {
							stop(e);
							onDiscard();
						}}
						type="button"
					>
						<HugeiconsIcon className="size-3" icon={Delete02Icon} />
						Discard
					</button>
				</Tooltip>
			</div>
		);
	}
	return (
		<div className="flex shrink-0 items-center gap-1.5">
			<Tooltip content="Download this model" side="top">
				<button
					className={cn(ACTION_BUTTON_BASE, PRIMARY)}
					onClick={(e) => {
						stop(e);
						onDownload();
					}}
					type="button"
				>
					<HugeiconsIcon className="size-3" icon={CloudDownloadIcon} />
					Download
				</button>
			</Tooltip>
		</div>
	);
}
