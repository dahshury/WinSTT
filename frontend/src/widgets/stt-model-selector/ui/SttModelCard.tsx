"use client";

import { Combobox } from "@base-ui/react/combobox";
import {
	AlertCircleIcon,
	CheckmarkCircle02Icon,
	GlobeIcon,
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
			<span className="shrink-0 font-medium text-[10px] text-foreground-muted uppercase tracking-wide">
				Precision
			</span>
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
	currentQuantization: OnnxQuantization;
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

export function SttModelCard({
	model,
	state,
	systemInfo,
	selectedId,
	currentQuantization,
	onSelect,
}: SttModelCardProps) {
	const isSelected = model.id === selectedId;
	const bytes = formatBytes(state?.estimated_bytes ?? 0);
	const segments = buildAttributeSegments(model, state, systemInfo);
	return (
		<Combobox.Item className={cn(CARD_BASE, isSelected && CARD_SELECTED)} value={model}>
			<div className="flex items-center justify-between gap-2.5">
				<div className="flex min-w-0 items-center gap-2">
					{isSelected ? (
						<HugeiconsIcon className="size-3.5 shrink-0 text-accent" icon={CheckmarkCircle02Icon} />
					) : null}
					<span className="truncate font-semibold text-body-sm leading-tight">
						{variantLabel(model)}
					</span>
					<span className="shrink-0 text-[11px] text-foreground-muted tabular-nums">
						{model.sizeLabel}
						{bytes ? ` · ${bytes}` : ""}
					</span>
				</div>
				<AttributeGroup segments={segments} />
			</div>
			<PrecisionGroup
				currentQuantization={currentQuantization}
				isSelectedModel={isSelected}
				model={model}
				onSelect={onSelect}
				state={state}
			/>
		</Combobox.Item>
	);
}
