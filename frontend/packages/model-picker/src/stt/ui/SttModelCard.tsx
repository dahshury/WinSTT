"use client";

import { Combobox } from "@base-ui/react/combobox";
import {
	AlertCircleIcon,
	Atom01Icon,
	BinaryCodeIcon,
	CheckmarkCircle02Icon,
	GlobeIcon,
	HardDriveDownloadIcon,
	LiveStreaming02Icon,
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
import { getQuantizationOptions } from "../lib/quantization-helpers";
import { variantMeta } from "../lib/variant-helpers";
import { QuantCacheDot, quantCacheStatus } from "./pills";

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

// Map a 0..1 score to a hue: 0 = red (bad), 1 = blue (good). The midpoint
// lands in green — intuitive for "neutral / average". Saturation and
// lightness are tuned to read well on both light and dark surfaces.
function scoreColor(score: number): string {
	const clamped = Math.max(0, Math.min(1, score));
	const hue = clamped * 220;
	return `hsl(${hue}, 72%, 52%)`;
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
			<Tooltip content={`Accuracy ${accPct}%`} side="top">
				<div className="flex items-center gap-1.5">
					<span className="w-14 text-end font-medium text-[9px] text-foreground-muted uppercase tracking-wide">
						Accuracy
					</span>
					<div className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-secondary">
						<div
							className="h-full rounded-full"
							style={{ backgroundColor: scoreColor(accuracyScore), width: `${accPct}%` }}
						/>
					</div>
				</div>
			</Tooltip>
			<Tooltip content={`Speed ${speedPct}%`} side="top">
				<div className="flex items-center gap-1.5">
					<span className="w-14 text-end font-medium text-[9px] text-foreground-muted uppercase tracking-wide">
						Speed
					</span>
					<div className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-secondary">
						<div
							className="h-full rounded-full"
							style={{ backgroundColor: scoreColor(speedScore), width: `${speedPct}%` }}
						/>
					</div>
				</div>
			</Tooltip>
		</div>
	);
}

interface PrecisionGroupProps {
	currentQuantization: OnnxQuantization;
	isSelectedModel: boolean;
	model: ModelInfo;
	onSelect: (modelId: string, quantization: OnnxQuantization) => void;
	state: ModelStateEntry | undefined;
}

function PrecisionGroup({
	model,
	state,
	currentQuantization,
	isSelectedModel,
	onSelect,
}: PrecisionGroupProps) {
	const options = getQuantizationOptions(model);
	if (options.length === 0) {
		return null;
	}
	return (
		<div className="flex items-center gap-2">
			<Tooltip
				content="Precision — the numeric format of the model's weights. Lower precision (q4 / int8) makes the model load and run faster and take less disk/RAM, at the cost of a small drop in transcription accuracy. Higher precision (fp32 / fp16) is the most accurate but slowest."
				side="top"
			>
				<span className="inline-flex shrink-0 items-center font-medium text-[10px] text-foreground-muted uppercase tracking-wide">
					<HugeiconsIcon className="size-3" icon={BinaryCodeIcon} />
				</span>
			</Tooltip>
			<ButtonGroup
				aria-label={`Precision for ${model.displayName}`}
				className="flex-wrap rounded-md ring-1 ring-border ring-inset"
			>
				{options.map((opt, i) => {
					const isActive = isSelectedModel && opt.value === currentQuantization;
					const cache = resolveQuantCache(state, opt.value);
					return (
						<Tooltip
							content={`${opt.label} — ${quantCacheStatus(cache)}. ${opt.tooltip}`}
							key={opt.value || "default"}
							side="top"
						>
							<button
								className={cn(
									"inline-flex h-6 cursor-pointer items-center gap-1.5 px-2 font-medium text-[10.5px] leading-none transition-colors",
									i > 0 && "border-border border-l",
									"first:rounded-l-[5px] last:rounded-r-[5px]",
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
							</button>
						</Tooltip>
					);
				})}
			</ButtonGroup>
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
	/**
	 * Set on a bundle primary card whose currently-selected model is one of
	 * its hidden siblings (e.g. a ``.en`` or lite-whisper variant). Renders
	 * a softer "indirect" highlight so the user can spot the family at a
	 * glance without it competing visually with the actually-selected
	 * sibling card below.
	 */
	hasSelectedVariant?: boolean;
	model: ModelInfo;
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
								<HugeiconsIcon className="size-3" icon={Atom01Icon} />
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
					isSelectedModel={isSelected}
					model={model}
					onSelect={onSelect}
					state={state}
				/>
			)}
		</Combobox.Item>
	);
}
