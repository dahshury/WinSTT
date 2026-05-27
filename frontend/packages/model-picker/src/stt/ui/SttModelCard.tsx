"use client";

import { Combobox } from "@base-ui/react/combobox";
import { Slider } from "@base-ui/react/slider";
import {
	AlertCircleIcon,
	BinaryCodeIcon,
	CancelCircleIcon,
	CheckmarkCircle02Icon,
	CloudDownloadIcon,
	Delete02Icon,
	GlobeIcon,
	HardDriveDownloadIcon,
	LiveStreaming02Icon,
	NeuralNetworkIcon,
	PauseIcon,
	PlayIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ModelInfo } from "@/entities/model-catalog";
import type { ModelStateEntry, SystemInfoEntry } from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";
import { cn } from "@/shared/lib/cn";
import { formatBytes } from "@/shared/lib/format-bytes";
import { ButtonGroup } from "@/shared/ui/button-group";
import { Tooltip } from "@/shared/ui/tooltip";
import { resolveQuantCache } from "../lib/cache-helpers";
import { getFamilyConfig } from "../lib/family-helpers";
import { isUncomfortable } from "../lib/hardware-fit";
import { quantCacheStatus } from "../lib/pill-helpers";
import { getQuantizationOptions } from "../lib/quantization-helpers";
import { variantMeta } from "../lib/variant-helpers";
import { QuantCacheDot } from "./pills";

/** "Whisper Large v3" → "Large v3" (the group header already says Whisper). */
function variantLabel(model: ModelInfo): string {
	const familyLabel = getFamilyConfig(model.family).label;
	const stripped = model.displayName.replace(new RegExp(`^${familyLabel}\\s+`), "");
	return stripped.length > 0 ? stripped : model.displayName;
}

interface AttributeSegment {
	className: string;
	icon?: IconSvgElement;
	label: string;
	tooltip: string;
}

function buildAttributeSegments(
	model: ModelInfo,
	state: ModelStateEntry | undefined,
	systemInfo: SystemInfoEntry | null
): AttributeSegment[] {
	const { multilingual, englishOnly, realtime } = variantMeta(model);
	const segments: AttributeSegment[] = [];
	if (multilingual) {
		segments.push({
			label: "Multilingual",
			icon: GlobeIcon,
			className: "text-sky-600 dark:text-sky-400",
			tooltip: "Transcribes many languages",
		});
	} else if (englishOnly) {
		segments.push({
			label: "EN only",
			className: "text-foreground-secondary",
			tooltip: "English only — no multilingual support",
		});
	} else {
		segments.push({
			label: model.languages.map((l) => l.toUpperCase()).join("/"),
			className: "text-foreground-secondary",
			tooltip: `Supports: ${model.languages.map((l) => l.toUpperCase()).join(", ")}`,
		});
	}
	if (realtime) {
		segments.push({
			label: "Realtime",
			icon: LiveStreaming02Icon,
			className: "text-violet-600 dark:text-violet-400",
			tooltip: "Light enough to drive the live-preview (realtime) transcription",
		});
	}
	if (isUncomfortable(state, systemInfo)) {
		segments.push({
			label: "Won't fit",
			icon: AlertCircleIcon,
			className: "text-error",
			tooltip: "May not fit comfortably on your hardware",
		});
	}
	return segments;
}

/** Read-only segmented control of the variant's attributes. */
function AttributeGroup({ segments }: { segments: AttributeSegment[] }) {
	if (segments.length === 0) {
		return null;
	}
	return (
		<ButtonGroup
			aria-label="Model attributes"
			className="shrink-0 rounded-md ring-1 ring-border ring-inset"
		>
			{segments.map((seg, i) => (
				<Tooltip content={seg.tooltip} key={seg.label} side="top">
					<span
						className={cn(
							"inline-flex h-5 items-center gap-1 bg-surface-secondary/40 px-1.5 font-medium text-[10px] leading-none",
							"first:rounded-l-[5px] last:rounded-r-[5px]",
							i > 0 && "border-border border-l",
							seg.className
						)}
					>
						{seg.icon ? <HugeiconsIcon className="size-3" icon={seg.icon} /> : null}
						{seg.label}
					</span>
				</Tooltip>
			))}
		</ButtonGroup>
	);
}

interface PerfBarsProps {
	accuracyScore: number;
	speedScore: number;
}

/**
 * Map a 0..1 score to a Tekken/Mortal-Kombat-style health-bar colour —
 * red (worst) → amber (mid) → blue (best). Deliberately skips green so
 * "neutral / average" doesn't accidentally read as "passing".
 *
 * Piecewise RGB interpolation through two anchor stops keeps the
 * transition perceptually monotonic on dark surfaces and avoids the
 * grey-mud that a single linear yellow→blue mix would land on.
 */
function scoreColor(score: number): string {
	const t = Math.max(0, Math.min(1, score));
	// Anchor colours, tuned to read on the surface-secondary track:
	//   t=0.0  → red  (220, 60, 60)
	//   t=0.5  → amber-yellow (230, 180, 50)
	//   t=1.0  → blue (60, 130, 230)
	const mix = (a: number, b: number, k: number): number => Math.round(a + (b - a) * k);
	if (t < 0.5) {
		const k = t * 2;
		return `rgb(${mix(220, 230, k)}, ${mix(60, 180, k)}, ${mix(60, 50, k)})`;
	}
	const k = (t - 0.5) * 2;
	return `rgb(${mix(230, 60, k)}, ${mix(180, 130, k)}, ${mix(50, 230, k)})`;
}

interface PerfBarProps {
	label: string;
	score: number;
	tooltip: string;
}

/**
 * One disabled Base UI Slider acting as a coloured progress bar. Mirrors
 * the "comfortable disabled" pattern shown on the Fluid Functionalism
 * Slider docs — small, thumb hidden, indicator filled to the score, no
 * pointer interaction. Same primitive as the other Sliders in the app
 * (``@base-ui/react/slider``), kept compact via ``Slider.Root`` controlled
 * by the percent value and a fixed max of 100.
 */
function PerfBar({ label, score, tooltip }: PerfBarProps) {
	const pct = Math.round(score * 100);
	return (
		<Tooltip content={tooltip} side="top">
			<div className="flex items-center gap-1.5">
				<span className="w-14 text-end font-medium text-[9px] text-foreground-muted uppercase tracking-wide">
					{label}
				</span>
				<Slider.Root disabled max={100} value={pct}>
					<Slider.Control className="flex h-1.5 w-16 select-none items-center">
						<Slider.Track className="relative h-1.5 w-full overflow-hidden rounded-full bg-surface-secondary">
							<Slider.Indicator
								className="rounded-full"
								style={{ backgroundColor: scoreColor(score) }}
							/>
							{/* Thumb is required by Base UI's Slider for keyboard
							    a11y registration but hidden visually — these
							    bars are read-only "score" displays, not
							    interactive sliders. */}
							<Slider.Thumb className="sr-only" />
						</Slider.Track>
					</Slider.Control>
				</Slider.Root>
			</div>
		</Tooltip>
	);
}

/**
 * Two stacked progress bars showing relative speed and accuracy. Hidden
 * when the catalog reports the unknown-default 0.5/0.5 — drawing two
 * half-full bars on every variant would teach the user to ignore them.
 */
function PerfBars({ speedScore, accuracyScore }: PerfBarsProps) {
	const hasSignal = speedScore !== 0.5 || accuracyScore !== 0.5;
	if (!hasSignal) {
		return null;
	}
	const speedPct = Math.round(speedScore * 100);
	const accPct = Math.round(accuracyScore * 100);
	return (
		<div className="hidden shrink-0 flex-col gap-1 sm:flex">
			<PerfBar label="Accuracy" score={accuracyScore} tooltip={`Accuracy ${accPct}%`} />
			<PerfBar label="Speed" score={speedScore} tooltip={`Speed ${speedPct}%`} />
		</div>
	);
}

/** Per-(modelId, quant) live download snapshot the badge reads to flip
 *  into "downloading" / "paused" chrome. Lives in the renderer's
 *  download store (see ``features/model-download/model/download-store.ts``)
 *  but the picker is self-contained so the consumer hands it in. ``null``
 *  means no active download for this badge. */
export interface QuantDownloadSnapshot {
	downloadedBytes: number;
	paused: boolean;
	progress: number | null;
	totalBytes: number;
}

export type QuantDownloadAction = "start" | "pause" | "resume" | "cancel";

interface PrecisionGroupProps {
	currentQuantization: OnnxQuantization;
	/** Lookup ``(modelId, quantization) -> snapshot`` for the active
	 *  download (if any) on this card's variants. Empty / missing entry
	 *  means the badge renders its idle state. */
	getDownloadSnapshot?:
		| ((modelId: string, quantization: OnnxQuantization) => QuantDownloadSnapshot | undefined)
		| undefined;
	isSelectedModel: boolean;
	model: ModelInfo;
	/** Single dispatch for the four download actions. Selector wires
	 *  this to ``useDownloadStore.{predownloadQuant,pauseQuantDownload,
	 *  resumeQuantDownload,cancelQuantDownload}``. */
	onDownloadAction?:
		| ((action: QuantDownloadAction, modelId: string, quantization: OnnxQuantization) => void)
		| undefined;
	onRequestDeleteQuant?:
		| ((
				modelId: string,
				quantization: OnnxQuantization,
				displayName: string,
				quantLabel: string
		  ) => void)
		| undefined;
	onSelect: (modelId: string, quantization: OnnxQuantization) => void;
	state: ModelStateEntry | undefined;
}

/** Inline icon button used for every per-badge download-control action
 *  (Download, Pause, Resume, Cancel, Delete). Same height + border-l
 *  treatment as the trash icon so the four controls compose into a
 *  single ButtonGroup chip. */
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
	tone?: "neutral" | "danger" | "primary";
	tooltip: string;
}) {
	const toneClass =
		tone === "danger"
			? "bg-surface-secondary/40 text-foreground-muted hover:bg-error/15 hover:text-error"
			: tone === "primary"
				? "bg-surface-secondary/40 text-accent hover:bg-accent/20"
				: "bg-surface-secondary/40 text-foreground-muted hover:bg-surface-hover hover:text-foreground";
	return (
		<Tooltip content={tooltip} side="top">
			<button
				aria-label={ariaLabel}
				className={cn(
					"inline-flex h-6 cursor-pointer items-center justify-center border-border border-l px-1.5 leading-none transition-colors",
					"last:rounded-r-[5px]",
					toneClass
				)}
				onClick={(e) => {
					e.preventDefault();
					e.stopPropagation();
					onClick();
				}}
				type="button"
			>
				<HugeiconsIcon className="size-3" icon={icon} />
			</button>
		</Tooltip>
	);
}

function PrecisionGroup({
	model,
	state,
	currentQuantization,
	isSelectedModel,
	onSelect,
	onRequestDeleteQuant,
	getDownloadSnapshot,
	onDownloadAction,
}: PrecisionGroupProps) {
	const options = getQuantizationOptions(model);
	if (options.length === 0) {
		return null;
	}
	return (
		<div className="flex flex-wrap items-center gap-2">
			<Tooltip
				content="Precision — the numeric format of the model's weights. Lower precision (q4 / int8) makes the model load and run faster and take less disk/RAM, at the cost of a small drop in transcription accuracy. Higher precision (fp32 / fp16) is the most accurate but slowest."
				side="top"
			>
				<span className="inline-flex shrink-0 items-center font-medium text-[10px] text-foreground-muted uppercase tracking-wide">
					<HugeiconsIcon className="size-3" icon={BinaryCodeIcon} />
				</span>
			</Tooltip>
			{options.map((opt) => {
				const isActive = isSelectedModel && opt.value === currentQuantization;
				const cache = resolveQuantCache(state, opt.value);
				const download = getDownloadSnapshot?.(model.id, opt.value);
				const isDownloading = download !== undefined;
				const isOnDisk = cache?.state === "cached" || cache?.state === "partial";
				const isPartial = cache?.state === "partial" && !isDownloading;
				const canDelete = onRequestDeleteQuant !== undefined && isOnDisk;
				const canDownload = onDownloadAction !== undefined;

				// Per-badge button-group composition:
				//   * Always: the precision label button itself.
				//   * Active download: progress label + Pause/Resume + Cancel.
				//   * Partial, idle: Resume + Delete.
				//   * Cached, idle: Delete.
				//   * Not cached, idle: Download.
				// Matches the user spec: "All model quantizations that are
				// partially downloaded should have their badge as resume
				// or delete. All models that are already downloaded should
				// have delete as a button group beside their badge."
				return (
					<ButtonGroup
						aria-label={`Precision ${opt.label} for ${model.displayName}`}
						className="rounded-md ring-1 ring-border ring-inset"
						key={opt.value || "default"}
					>
						<Tooltip
							content={`${opt.label} — ${quantCacheStatus(cache)}. ${opt.tooltip}`}
							side="top"
						>
							<button
								className={cn(
									"inline-flex h-6 cursor-pointer items-center gap-1.5 px-2 font-medium text-[10.5px] leading-none transition-colors",
									"rounded-l-[5px]",
									isActive
										? "bg-accent/20 text-accent"
										: "bg-surface-secondary/40 text-foreground-secondary hover:bg-surface-hover"
								)}
								onClick={(e) => {
									e.preventDefault();
									e.stopPropagation();
									onSelect(model.id, opt.value);
								}}
								type="button"
							>
								<QuantCacheDot cache={cache} />
								{opt.label}
								{isDownloading ? (
									<span className="ms-1 font-mono text-[9.5px] text-foreground-muted tabular-nums">
										{download.progress === null ? "…" : `${download.progress}%`}
									</span>
								) : null}
							</button>
						</Tooltip>
						{/* Active download → Pause/Resume + Cancel. */}
						{isDownloading && canDownload && download.paused ? (
							<BadgeIconButton
								ariaLabel={`Resume ${opt.label} download`}
								icon={PlayIcon}
								onClick={() => onDownloadAction("resume", model.id, opt.value)}
								tone="primary"
								tooltip="Resume download"
							/>
						) : null}
						{isDownloading && canDownload && !download.paused ? (
							<BadgeIconButton
								ariaLabel={`Pause ${opt.label} download`}
								icon={PauseIcon}
								onClick={() => onDownloadAction("pause", model.id, opt.value)}
								tooltip="Pause download (resumable mid-file)"
							/>
						) : null}
						{isDownloading && canDownload ? (
							<BadgeIconButton
								ariaLabel={`Cancel ${opt.label} download`}
								icon={CancelCircleIcon}
								onClick={() => onDownloadAction("cancel", model.id, opt.value)}
								tone="danger"
								tooltip="Cancel download"
							/>
						) : null}
						{/* Idle + partial → Resume button to restart. */}
						{!isDownloading && isPartial && canDownload ? (
							<BadgeIconButton
								ariaLabel={`Resume ${opt.label} download`}
								icon={PlayIcon}
								onClick={() => onDownloadAction("start", model.id, opt.value)}
								tone="primary"
								tooltip="Resume partial download from where it stopped"
							/>
						) : null}
						{/* Idle + not cached → start download from the badge. */}
						{!(isDownloading || isOnDisk) && canDownload ? (
							<BadgeIconButton
								ariaLabel={`Download ${opt.label} weights`}
								icon={CloudDownloadIcon}
								onClick={() => onDownloadAction("start", model.id, opt.value)}
								tooltip="Download (resumable mid-file)"
							/>
						) : null}
						{canDelete && !isDownloading ? (
							<BadgeIconButton
								ariaLabel={`Delete ${opt.label} weights for ${model.displayName}`}
								icon={Delete02Icon}
								onClick={() =>
									onRequestDeleteQuant(model.id, opt.value, model.displayName, opt.label)
								}
								tone="danger"
								tooltip={
									cache?.state === "partial"
										? `Delete partial ${opt.label} download`
										: `Delete cached ${opt.label} weights`
								}
							/>
						) : null}
					</ButtonGroup>
				);
			})}
		</div>
	);
}

export interface SttModelCardProps {
	/**
	 * Optional content rendered in the card's header right column, after
	 * the read-only attribute group. Used by ``SttVariantBundle`` to slot
	 * in the expand/collapse chevron without overlapping the "Realtime" /
	 * "Multilingual" badges (the chevron used to be absolutely positioned
	 * and would collide with the right-edge AttributeGroup when both were
	 * present).
	 */
	actions?: import("react").ReactNode;
	currentQuantization: OnnxQuantization;
	/** Lookup for the active download snapshot per (modelId, quant). The
	 *  picker is self-contained so the consumer wires it; ``undefined``
	 *  return = no active download for that variant. */
	getDownloadSnapshot?:
		| ((modelId: string, quantization: OnnxQuantization) => QuantDownloadSnapshot | undefined)
		| undefined;
	/**
	 * Set on a bundle primary card whose currently-selected model is one of
	 * its hidden siblings (e.g. a ``.en`` or lite-whisper variant). Renders
	 * a softer "indirect" highlight so the user can spot the family at a
	 * glance without it competing visually with the actually-selected
	 * sibling card below.
	 */
	hasSelectedVariant?: boolean;
	model: ModelInfo;
	/** Single dispatch for the four download actions emitted by the
	 *  badge controls (Download / Pause / Resume / Cancel). */
	onDownloadAction?:
		| ((action: QuantDownloadAction, modelId: string, quantization: OnnxQuantization) => void)
		| undefined;
	/**
	 * Optional handler invoked when the user clicks the trash icon next
	 * to a cached/partial quant badge. Receives `(modelId, quantization,
	 * displayName, quantLabel)` so the consumer can render its own
	 * confirmation dialog. When omitted, no trash icon is rendered (the
	 * card stays read-only as it was before).
	 */
	onRequestDeleteQuant?:
		| ((
				modelId: string,
				quantization: OnnxQuantization,
				displayName: string,
				quantLabel: string
		  ) => void)
		| undefined;
	onSelect: (modelId: string, quantization?: OnnxQuantization) => void;
	selectedId: string | undefined;
	state: ModelStateEntry | undefined;
	systemInfo: SystemInfoEntry | null;
}

const CARD_BASE = cn(
	"mx-2 my-1 flex cursor-pointer flex-col gap-2 rounded-md border px-3 py-2.5 outline-none transition-colors",
	"border-border bg-surface-secondary/50",
	"hover:border-border-hover hover:bg-surface-hover/50",
	"data-[highlighted]:border-border-hover data-[highlighted]:bg-surface-hover/50"
);
const CARD_SELECTED = "border-accent/50 bg-accent/[0.08] ring-1 ring-accent/25";
/** Softer variant: the primary's bundle owns the selected variant but the
 *  primary itself isn't the active id. Lighter than ``CARD_SELECTED`` so the
 *  actually-selected sibling still wins the eye. */
const CARD_SELECTED_VARIANT = "border-accent/30 bg-accent/[0.04]";

/** Class fragment that desaturates a broken custom-model card without
 *  changing the dimensions — keeps the picker layout stable while making
 *  the unavailable state obvious. */
const CARD_UNAVAILABLE = "cursor-not-allowed opacity-60 hover:bg-surface-secondary/50";

export function SttModelCard({
	model,
	state,
	systemInfo,
	selectedId,
	currentQuantization,
	onSelect,
	onRequestDeleteQuant,
	getDownloadSnapshot,
	onDownloadAction,
	actions,
	hasSelectedVariant = false,
}: SttModelCardProps) {
	const isSelected = model.id === selectedId;
	const isIndirectlySelected = !isSelected && hasSelectedVariant;
	const isUnavailable = model.available === false;
	const bytes = formatBytes(state?.estimated_bytes ?? 0);
	const segments = buildAttributeSegments(model, state, systemInfo);
	// Broken custom drops surface the scanner's error verbatim — much more
	// useful than a generic "couldn't load" toast. The label itself is
	// already shown; the tooltip explains *why* the card is greyed out.
	const title =
		isUnavailable && model.errorMessage ? `Unavailable: ${model.errorMessage}` : undefined;
	return (
		<Combobox.Item
			className={cn(
				CARD_BASE,
				isSelected && CARD_SELECTED,
				isIndirectlySelected && CARD_SELECTED_VARIANT,
				isUnavailable && CARD_UNAVAILABLE
			)}
			data-model-id={model.id}
			disabled={isUnavailable}
			title={title}
			value={model}
		>
			<div className="flex items-center justify-between gap-2.5">
				<div className="flex min-w-0 items-center gap-2">
					{/* Combobox.ItemIndicator renders only when the Item's value
					    matches the root's selected value (resolved via
					    isItemEqualToValue) — no manual `isSelected` guard
					    needed, and it automatically picks up the canonical
					    `data-selected` state Base UI maintains. */}
					<Combobox.ItemIndicator className="flex shrink-0 items-center">
						<HugeiconsIcon className="size-3.5 text-accent" icon={CheckmarkCircle02Icon} />
					</Combobox.ItemIndicator>
					<span className="truncate font-semibold text-body-sm leading-tight">
						{variantLabel(model)}
					</span>
					{model.sizeLabel ? (
						<Tooltip content={`${model.sizeLabel} parameters`} side="top">
							<span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-foreground-muted tabular-nums">
								<HugeiconsIcon className="size-3" icon={NeuralNetworkIcon} />
								{model.sizeLabel}
							</span>
						</Tooltip>
					) : null}
					{bytes ? (
						<Tooltip content={`Download size: ${bytes}`} side="top">
							<span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-foreground-dim tabular-nums">
								<HugeiconsIcon className="size-3" icon={HardDriveDownloadIcon} />
								{bytes}
							</span>
						</Tooltip>
					) : null}
					{isUnavailable ? (
						<Tooltip content={model.errorMessage || "Unavailable"} side="top">
							<span className="inline-flex shrink-0 items-center gap-1 rounded bg-error/15 px-1.5 py-0.5 font-medium text-[10px] text-error">
								<HugeiconsIcon className="size-3" icon={AlertCircleIcon} />
								Broken
							</span>
						</Tooltip>
					) : null}
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<PerfBars accuracyScore={model.accuracyScore} speedScore={model.speedScore} />
					<AttributeGroup segments={segments} />
					{actions}
				</div>
			</div>
			{isUnavailable ? null : (
				<PrecisionGroup
					currentQuantization={currentQuantization}
					getDownloadSnapshot={getDownloadSnapshot}
					isSelectedModel={isSelected}
					model={model}
					onDownloadAction={onDownloadAction}
					onRequestDeleteQuant={onRequestDeleteQuant}
					onSelect={onSelect}
					state={state}
				/>
			)}
		</Combobox.Item>
	);
}
