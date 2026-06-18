"use client";

import { Button as BaseButton } from "@base-ui/react/button";
import {
	BinaryCodeIcon,
	CancelCircleIcon,
	CloudDownloadIcon,
	Delete02Icon,
	PauseIcon,
	PlayIcon,
	SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { cn } from "@/shared/lib/cn";
import { ButtonGroup } from "@/shared/ui/button-group";
import { PulseDot } from "@/shared/ui/pulse-dot";
import { Tooltip } from "@/shared/ui/tooltip";
import {
	buildQuantTooltipContent,
	clampPercent,
} from "./quant-shelf-state";

/**
 * The recessed precision/quantization shelf shared by every model picker (STT,
 * TTS, …). It is the single source of visual identity AND download-control
 * behavior for the per-quant badges: click an uncached badge to start a
 * background download, watch live progress, pause/resume/cancel, delete cached
 * weights, or select a cached precision.
 *
 * Each picker normalizes its own catalog + cache-state shape into a list of
 * {@link QuantShelfEntry} (the STT card adds the RAM-aware "recommended" mark;
 * the TTS card routes its "Auto" sentinel to the server's effective precision)
 * and hands them to {@link QuantShelf} — so the chrome and the four download
 * actions are literally one implementation, never copy-pasted per picker.
 */

/** On-disk cache state of a single quantization (mirrors the server `CacheState`). */
export type QuantCacheState = "cached" | "partial" | "not_cached";

/** Per-(modelId, quant) live download snapshot a badge reads to flip into
 *  "downloading" / "paused" chrome. The picker is self-contained, so the
 *  consumer hands it in from the renderer's download store; `undefined` = no
 *  active download for this badge. */
export interface QuantDownloadSnapshot {
	downloadedBytes: number;
	paused: boolean;
	progress: number | null;
	totalBytes: number;
}

export type QuantDownloadAction = "start" | "pause" | "resume" | "cancel";

/** Backend cache snapshots are snake_case for STT and camelCase for TTS.
 *  Normalize both shapes here so every picker derives badge status, progress,
 *  and action availability from one implementation. */
export interface QuantCacheSnapshot {
	downloadedBytes?: number | null;
	downloaded_bytes?: number | null;
	progress?: number | null;
	state?: QuantCacheState | string | null;
	totalBytes?: number | null;
	total_bytes?: number | null;
}

export interface ResolvedQuantDownloadState {
	cacheProgress: number | null;
	cacheState: QuantCacheState | undefined;
	cacheStatusLabel: string;
	canResumeDownload: boolean;
	canStartDownload: boolean;
	downloadSizeBytes: number | null;
	isCached: boolean;
	isPartial: boolean;
}

/**
 * One precision badge, fully normalized by the picker adapter so the shelf
 * stays state-shape agnostic. `value` is the badge's own precision id (the
 * select / start-download target); `actionQuant` is the concrete precision the
 * pause/resume/cancel/delete controls act on (they diverge only for a router
 * badge like TTS "Auto", whose actions target the server's effective quant).
 */
export interface QuantShelfEntry {
	/** Concrete precision the trailing pause/resume/cancel/delete controls act on. */
	actionQuant: string;
	/** Partial-download fraction (0..1) for the amber background fill, or null. */
	cacheProgress: number | null;
	/** On-disk state of `actionQuant`. */
	cacheState: QuantCacheState | undefined;
	/** Human status phrase for the tooltip ("Downloaded" / "47% downloaded" / …). */
	cacheStatusLabel: string;
	/** Body-click starts a background download (uncached concrete badge + dispatcher present). */
	canStartDownload: boolean;
	/** Show the trailing delete control (on disk + deleter present + not a router badge). */
	canDelete: boolean;
	/** Show resume/cancel controls for a paused resumable download. */
	canResumeDownload?: boolean;
	/** Live download snapshot for `actionQuant`, if any. */
	download: QuantDownloadSnapshot | undefined;
	/** Download size for this exact precision, when the catalog exposes it. */
	downloadSizeBytes?: number | null;
	/** Preformatted download size label, used when a backend already scraped one. */
	downloadSizeLabel?: string | null;
	/** This badge is the active / selected precision. */
	isActive: boolean;
	/** Mark with the sparkle + "(recommended for your hardware)" aria suffix. */
	isRecommended: boolean;
	/** Human label ("fp16" / "fp32" / "Auto"). */
	label: string;
	/** Render label in monospace for backend tag ids such as `q4_K_M`. */
	mono?: boolean;
	/** Full precision-explanation tooltip text. */
	tooltip: string;
	/** Badge precision id — the select / start-download value. `""` is allowed. */
	value: string;
	/** Optional backing model id when one visible card fronts multiple repos. */
	modelId?: string;
}

export interface QuantShelfProps {
	entries: readonly QuantShelfEntry[];
	modelDisplayName: string;
	modelId: string;
	/** Single dispatch for the four per-quant download actions. */
	onDownloadAction?:
		| ((
				action: QuantDownloadAction,
				modelId: string,
				quantization: string,
		  ) => void)
		| undefined;
	/** Trash-icon handler — when omitted, no delete control is rendered. */
	onRequestDeleteQuant?:
		| ((
				modelId: string,
				quantization: string,
				displayName: string,
				quantLabel: string,
		  ) => void)
		| undefined;
	onSelect: (modelId: string, quantization: string) => void;
	showIcon?: boolean;
}

type BadgeIconButtonTone = "neutral" | "danger" | "primary";

/** Maps a {@link BadgeIconButtonTone} to its Tailwind class string. */
function toneClassName(tone: BadgeIconButtonTone): string {
	const map: Record<BadgeIconButtonTone, string> = {
		danger:
			"bg-foreground/[0.04] text-foreground-muted hover:bg-error/15 hover:text-error",
		primary: "bg-foreground/[0.04] text-accent hover:bg-accent/15",
		neutral:
			"bg-foreground/[0.04] text-foreground-muted hover:bg-foreground/[0.10] hover:text-foreground",
	};
	return map[tone];
}

/** Inline icon button for each per-badge download-control action (Pause /
 *  Resume / Cancel / Delete) — same height + border-l treatment so the controls
 *  compose into a single ButtonGroup chip. Exported so the Ollama picker's
 *  tag/pull shelf composes the IDENTICAL control chip. */
function BadgeIconButton({
	ariaLabel,
	icon,
	onClick,
	tone = "neutral",
	tooltip,
}: {
	ariaLabel: string;
	icon: IconSvgElement;
	onClick: () => void;
	tone?: BadgeIconButtonTone;
	tooltip: string;
}) {
	return (
		<Tooltip content={tooltip} side="top">
			<BaseButton
				aria-label={ariaLabel}
				className={cn(
					"inline-flex h-6 cursor-pointer items-center justify-center border-border border-l px-1.5 leading-none transition-colors",
					"last:rounded-r-[5px]",
					toneClassName(tone),
				)}
				// Base UI's Combobox.Item starts selection on pointerdown, BEFORE click —
				// so an onClick-only stop lets the card select first (the action gets lost).
				// Stop the pointer events too so Delete / Cancel / Pause / Resume act on the
				// quant without selecting the whole card.
				onClick={(e) => {
					e.preventDefault();
					e.stopPropagation();
					onClick();
				}}
				onMouseDown={(e) => e.stopPropagation()}
				onPointerDown={(e) => e.stopPropagation()}
				type="button"
			>
				<HugeiconsIcon className="size-3" icon={icon} />
			</BaseButton>
		</Tooltip>
	);
}

/** Idle (non-selected) precision-badge tint, by on-disk state. Muted-semantic
 *  tints (emerald = on disk, amber = partial, neutral = not cached). Exported so
 *  every picker's quant shelf reads with the same palette. */
function badgeToneForCache(state: QuantCacheState | undefined): string {
	if (state === "cached") {
		return "bg-emerald-500/[0.08] text-emerald-300/80 hover:bg-emerald-500/[0.14]";
	}
	if (state === "partial") {
		return "bg-amber-500/[0.08] text-amber-300/80 hover:bg-amber-500/[0.14]";
	}
	return "bg-foreground/[0.04] text-foreground-muted hover:bg-foreground/[0.08]";
}

/** Percentage [0..100] to amber-fill the badge for an in-progress / partly-cached
 *  quant, or `null` to skip the overlay. Active downloads win over the on-disk
 *  snapshot so the bar ticks live. */
function resolveProgressFillPct(
	cacheState: QuantCacheState | undefined,
	cacheProgress: number | null,
	download: QuantDownloadSnapshot | undefined,
): number | null {
	if (download && typeof download.progress === "number") {
		return clampPercent(download.progress);
	}
	if (cacheState === "partial") {
		return Math.min(99, clampPercent(Math.round((cacheProgress ?? 0) * 100)));
	}
	return null;
}

/** Inner content of the precision-label button — downloading (glyph + live %),
 *  idle-not-cached (label crossfading to a download glyph on hover), or the bare
 *  label. Exported so other pickers' shelves render the IDENTICAL badge content.
 *  `mono` renders the label in the mono font (Ollama tags like `q4_K_M`). */
function QuantBadgeLabel({
	canStartDownload,
	isDownloading,
	label,
	mono = false,
	paused,
	progress,
}: {
	canStartDownload: boolean;
	isDownloading: boolean;
	label: string;
	mono?: boolean;
	paused: boolean;
	progress: number | null;
}) {
	if (isDownloading) {
		return (
			<span className="relative inline-flex items-center gap-1.5">
				{paused ? (
					// Paused: a STATIC dot — a live pulse would imply bytes are still
					// flowing. The frozen amber fill + the trailing resume/cancel
					// controls already read as "stopped, resumable".
					<span
						aria-hidden="true"
						className="size-1.5 rounded-full bg-current opacity-60"
						data-slot="paused-dot"
					/>
				) : (
					<PulseDot className="size-1.5" />
				)}
				<span className="font-mono text-[9.5px] tabular-nums">
					{progress === null ? "..." : `${progress}%`}
				</span>
			</span>
		);
	}
	if (progress !== null) {
		return (
			<span className="font-mono text-[9.5px] tabular-nums">
				{`${progress}%`}
			</span>
		);
	}
	if (canStartDownload) {
		return (
			<span className="relative inline-flex items-center justify-center">
				<span
					className={cn(
						"transition-opacity duration-150 group-hover/badge:opacity-0 motion-reduce:transition-none",
						mono && "font-mono",
					)}
				>
					{label}
				</span>
				<HugeiconsIcon
					aria-hidden="true"
					className="absolute inset-0 m-auto size-3 opacity-0 transition-opacity duration-150 group-hover/badge:opacity-100 motion-reduce:transition-none"
					icon={CloudDownloadIcon}
				/>
			</span>
		);
	}
	return (
		<span
			className={cn("relative inline-flex items-center", mono && "font-mono")}
		>
			{label}
		</span>
	);
}

/** The 0..2 trailing action buttons appended to a precision badge in the same
 *  ButtonGroup (pause / resume / cancel for an active download; delete for an
 *  on-disk idle badge). Actions target `entry.actionQuant`. */
function QuantActionButtons({
	entry,
	modelDisplayName,
	modelId,
	onDownloadAction,
	onRequestDeleteQuant,
}: {
	entry: QuantShelfEntry;
	modelDisplayName: string;
	modelId: string;
	onDownloadAction: QuantShelfProps["onDownloadAction"];
	onRequestDeleteQuant: QuantShelfProps["onRequestDeleteQuant"];
}) {
	const { actionQuant, cacheState, download, label } = entry;
	const actionModelId = entry.modelId ?? modelId;
	const isDownloading = download !== undefined;
	const canDownload = onDownloadAction !== undefined;
	const deleteTooltip =
		cacheState === "partial"
			? `Delete partial ${label} download`
			: `Delete cached ${label} weights`;
	return (
		<>
			{isDownloading && canDownload && download.paused ? (
				<BadgeIconButton
					ariaLabel={`Resume ${label} download`}
					icon={PlayIcon}
					onClick={() => onDownloadAction("resume", actionModelId, actionQuant)}
					tone="primary"
					tooltip="Resume download"
				/>
			) : null}
			{isDownloading && canDownload && !download.paused ? (
				<BadgeIconButton
					ariaLabel={`Pause ${label} download`}
					icon={PauseIcon}
					onClick={() => onDownloadAction("pause", actionModelId, actionQuant)}
					tooltip="Pause download (resumable mid-file)"
				/>
			) : null}
			{isDownloading && canDownload ? (
				<BadgeIconButton
					ariaLabel={`Cancel ${label} download`}
					icon={CancelCircleIcon}
					onClick={() => onDownloadAction("cancel", actionModelId, actionQuant)}
					tone="danger"
					tooltip="Cancel download"
				/>
			) : null}
			{entry.canResumeDownload && !isDownloading && canDownload ? (
				<BadgeIconButton
					ariaLabel={`Resume ${label} download`}
					icon={PlayIcon}
					onClick={() => onDownloadAction("resume", actionModelId, actionQuant)}
					tone="primary"
					tooltip="Resume download"
				/>
			) : null}
			{entry.canResumeDownload && !isDownloading && canDownload ? (
				<BadgeIconButton
					ariaLabel={`Cancel ${label} download`}
					icon={CancelCircleIcon}
					onClick={() => onDownloadAction("cancel", actionModelId, actionQuant)}
					tone="danger"
					tooltip="Cancel download"
				/>
			) : null}
			{entry.canDelete && !isDownloading && onRequestDeleteQuant ? (
				<BadgeIconButton
					ariaLabel={`Delete ${label} weights for ${modelDisplayName}`}
					icon={Delete02Icon}
					onClick={() =>
						onRequestDeleteQuant(
							actionModelId,
							actionQuant,
							modelDisplayName,
							label,
						)
					}
					tone="danger"
					tooltip={deleteTooltip}
				/>
			) : null}
		</>
	);
}

/** One precision-badge ButtonGroup: the precision label button followed by
 *  0..2 contextual action buttons. */
function QuantBadge({
	entry,
	modelDisplayName,
	modelId,
	onDownloadAction,
	onRequestDeleteQuant,
	onSelect,
}: {
	entry: QuantShelfEntry;
	modelDisplayName: string;
	modelId: string;
	onDownloadAction: QuantShelfProps["onDownloadAction"];
	onRequestDeleteQuant: QuantShelfProps["onRequestDeleteQuant"];
	onSelect: QuantShelfProps["onSelect"];
}) {
	const {
		canResumeDownload,
		canStartDownload,
		download,
		isActive,
		isRecommended,
		label,
		mono,
		value,
	} = entry;
	const actionModelId = entry.modelId ?? modelId;
	const isDownloading = download !== undefined;
	const cacheToneClass = badgeToneForCache(entry.cacheState);
	const progressFillPct = resolveProgressFillPct(
		entry.cacheState,
		entry.cacheProgress,
		download,
	);
	const hasTrailingActions =
		(isDownloading && onDownloadAction !== undefined) ||
		(canResumeDownload === true && onDownloadAction !== undefined) ||
		(entry.canDelete && !isDownloading);
	const actionHint = canStartDownload
		? "Click to download."
		: canResumeDownload
			? "Click to resume."
			: null;
	let badgeAriaLabel = `Select ${label} precision`;
	if (canStartDownload) {
		badgeAriaLabel = `Download ${label} weights`;
	} else if (canResumeDownload) {
		badgeAriaLabel = `Resume ${label} weights download`;
	} else if (isDownloading) {
		badgeAriaLabel =
			download?.paused === true
				? `${label} download paused`
				: `${label} downloading`;
	}
	if (isRecommended) {
		badgeAriaLabel += " (recommended for your hardware)";
	}
	return (
		<ButtonGroup
			aria-label={`Precision ${label} for ${modelDisplayName}`}
			className={cn(
				"rounded-md ring-1 ring-inset",
				isRecommended ? "ring-accent/60" : "ring-border",
			)}
		>
			<Tooltip content={buildQuantTooltipContent(entry, actionHint)} side="top">
				<BaseButton
					aria-disabled={isDownloading}
					aria-label={badgeAriaLabel}
					className={cn(
						"group/badge relative inline-flex h-6 items-center gap-1.5 overflow-hidden px-2 font-medium text-[10.5px] leading-none transition-colors",
						isDownloading ? "cursor-default" : "cursor-pointer",
						hasTrailingActions ? "rounded-l-[5px]" : "rounded-[5px]",
						isActive ? "bg-accent/20 text-accent" : cacheToneClass,
					)}
					onClick={(e) => {
						e.preventDefault();
						e.stopPropagation();
						if (isDownloading) {
							return;
						}
						if (canStartDownload) {
							onDownloadAction?.("start", actionModelId, value);
						} else if (canResumeDownload) {
							onDownloadAction?.("resume", actionModelId, entry.actionQuant);
						} else {
							onSelect(actionModelId, value);
						}
					}}
					onMouseDown={(e) => e.stopPropagation()}
					onPointerDown={(e) => e.stopPropagation()}
					type="button"
				>
					{progressFillPct !== null && !isActive ? (
						<span
							aria-hidden="true"
							className="pointer-events-none absolute inset-y-0 left-0 bg-amber-500/20 transition-[width] duration-200 ease-out motion-reduce:transition-none"
							style={{ width: `${progressFillPct}%` }}
						/>
					) : null}
					{isRecommended ? (
						<HugeiconsIcon
							aria-hidden="true"
							className="size-3 shrink-0 text-accent"
							icon={SparklesIcon}
						/>
					) : null}
					<QuantBadgeLabel
						canStartDownload={canStartDownload}
						isDownloading={isDownloading}
						label={label}
						mono={mono === true}
						paused={download?.paused === true}
						progress={progressFillPct}
					/>
				</BaseButton>
			</Tooltip>
			<QuantActionButtons
				entry={entry}
				modelDisplayName={modelDisplayName}
				modelId={modelId}
				onDownloadAction={onDownloadAction}
				onRequestDeleteQuant={onRequestDeleteQuant}
			/>
		</ButtonGroup>
	);
}

/**
 * The recessed precision shelf — a `BinaryCode` glyph header followed by one
 * {@link QuantBadge} per entry. Renders nothing when there are no entries (a
 * model that ships a single precision still gets its one badge, so it stays
 * downloadable / selectable).
 */
export function QuantShelf({
	entries,
	modelDisplayName,
	modelId,
	onDownloadAction,
	onRequestDeleteQuant,
	onSelect,
	showIcon = true,
}: QuantShelfProps) {
	if (entries.length === 0) {
		return null;
	}
	return (
		<div className="flex flex-wrap items-center gap-2">
			{showIcon ? (
				<Tooltip
					content="Precision — the numeric format of the model's weights. Lower precision (q4 / int8) loads + runs faster and takes less disk/RAM, at a small quality cost. Higher precision (fp32 / fp16) is the most faithful but heaviest."
					side="top"
				>
					<span className="inline-flex shrink-0 items-center font-medium text-[10px] text-foreground-muted uppercase tracking-wide">
						<HugeiconsIcon className="size-3" icon={BinaryCodeIcon} />
					</span>
				</Tooltip>
			) : null}
			{entries.map((entry) => (
				<QuantBadge
					entry={entry}
					key={entry.value || "default"}
					modelDisplayName={modelDisplayName}
					modelId={modelId}
					onDownloadAction={onDownloadAction}
					onRequestDeleteQuant={onRequestDeleteQuant}
					onSelect={onSelect}
				/>
			))}
		</div>
	);
}
