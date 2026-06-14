"use client";

import { Button as BaseButton } from "@base-ui/react/button";
import {
	AlertCircleIcon,
	Clock01Icon,
	CloudDownloadIcon,
	GlobeIcon,
	HardDriveDownloadIcon,
	LiveStreaming02Icon,
	NeuralNetworkIcon,
	SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ModelInfo } from "@/entities/model-catalog";
import type {
	FitAssessmentEntry,
	FitSeverity,
	FitTarget,
	ModelStateEntry,
	SystemInfoEntry,
} from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";
import { cn } from "@/shared/lib/cn";
import { formatBytes } from "@/shared/lib/format-bytes";
import { ButtonGroup } from "@/shared/ui/button-group";
import { Tooltip } from "@/shared/ui/tooltip";
import {
	type MetaEntry,
	ModelCard,
	type QuantDownloadAction,
	type QuantDownloadSnapshot,
	QuantShelf,
	type QuantShelfEntry,
	resolveQuantDownloadState,
} from "../../core/model-card";
import { resolveQuantCache } from "../lib/cache-helpers";
import { variantDisplayName } from "../lib/family-helpers";
import { severityFor } from "../lib/hardware-fit";
import { formatLanguages } from "../lib/language-names";
import { getQuantizationOptions } from "../lib/quantization-helpers";
import { variantMeta } from "../lib/variant-helpers";
import {
	activeLatencyModel,
	backingModelIdForQuant,
	isSelectedSttModel,
	latencyVariantsForModel,
	nativeStreamingLatencyMs,
	type PrecisionRoutedSttModel,
} from "../lib/streaming-precision-merge";

// Re-export the shelf download types from their canonical home so existing
// importers of `./SttModelCard` (selector, list, variant bundle, tests) keep
// working unchanged after the shelf moved into the shared core.
export type {
	QuantDownloadAction,
	QuantDownloadSnapshot,
} from "../../core/model-card";

/**
 * The model's language support as a SINGLE meta fact — collapsing the old split
 * between a "Multilingual" badge and a separate language list. Shows the word
 * for the two common buckets and the explicit codes otherwise; the full roster
 * lives in the tooltip.
 */
function languageMeta(model: ModelInfo): { label: string; tooltip: string } {
	const { multilingual, englishOnly } = variantMeta(model);
	if (multilingual) {
		return {
			label: "Multilingual",
			// The catalog fills `languages` with the full list (Whisper ~99,
			// Canary/Parakeet ~25); fall back to the generic blurb only when the
			// list hasn't been populated yet.
			tooltip:
				model.languages.length > 0
					? `Supports ${model.languages.length} languages: ${formatLanguages(model.languages)}`
					: "Transcribes many languages",
		};
	}
	if (englishOnly) {
		return {
			label: "English",
			tooltip: "English only — no multilingual support",
		};
	}
	const codes = model.languages.map((l) => l.toUpperCase());
	return { label: codes.join("/"), tooltip: `Supports: ${codes.join(", ")}` };
}

const FIT_LABEL_BY_SEVERITY: Record<Exclude<FitSeverity, "ok">, string> = {
	warning: "Tight fit",
	critical: "Won't fit",
};

const FIT_CLASS_BY_SEVERITY: Record<Exclude<FitSeverity, "ok">, string> = {
	warning: "text-warning",
	critical: "text-error",
};

function fitTargetName(target: FitTarget): string {
	if (target === "gpu") {
		return "VRAM";
	}
	if (target === "cpu") {
		return "RAM";
	}
	return "RAM or VRAM";
}

function fitTooltip(
	severity: Exclude<FitSeverity, "ok">,
	assessment: FitAssessmentEntry | null | undefined,
): string {
	const target = assessment
		? fitTargetName(assessment.target)
		: "hardware memory";
	return severity === "warning"
		? `May leave little ${target} free`
		: `May exceed available ${target}`;
}

function formatNativeStreamingLatency(ms: number): string {
	if (ms >= 1000) {
		const seconds = (ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 2);
		return `${seconds.replace(/\.?0+$/, "")} s`;
	}
	return `${ms} ms`;
}

/** The ordered facts shown under the model name: parameters, download size,
 *  language support, and (only when relevant) the hardware-fit warning. */
function buildMetaEntries(
	model: ModelInfo,
	bytes: string | null,
	state: ModelStateEntry | undefined,
	systemInfo: SystemInfoEntry | null,
	fitAssessment: FitAssessmentEntry | null | undefined,
): MetaEntry[] {
	const entries: MetaEntry[] = [];
	if (model.sizeLabel) {
		entries.push({
			key: "params",
			icon: NeuralNetworkIcon,
			value: model.sizeLabel,
			tooltip: `${model.sizeLabel} parameters`,
		});
	}
	if (bytes) {
		entries.push({
			key: "size",
			icon: HardDriveDownloadIcon,
			value: bytes,
			tooltip: `Download size: ${bytes}`,
		});
	}
	const lang = languageMeta(model);
	entries.push({
		key: "lang",
		icon: GlobeIcon,
		value: lang.label,
		tooltip: lang.tooltip,
	});
	if (model.nativeStreaming) {
		const latencyMs = nativeStreamingLatencyMs(model);
		const latency =
			latencyMs === null ? null : formatNativeStreamingLatency(latencyMs);
		entries.push({
			key: "streaming",
			icon: LiveStreaming02Icon,
			value: latency === null ? "Native stream" : `Native stream · ${latency}`,
			tooltip:
				latency === null
					? "Feeds new audio into a stateful streaming decoder"
					: `Feeds new audio into a stateful streaming decoder with ${latency} chunk latency`,
		});
	}
	const fitSeverity = severityFor(state, systemInfo, fitAssessment);
	if (fitSeverity !== "ok") {
		entries.push({
			key: "fit",
			icon: AlertCircleIcon,
			value: FIT_LABEL_BY_SEVERITY[fitSeverity],
			tooltip: fitTooltip(fitSeverity, fitAssessment),
			className: FIT_CLASS_BY_SEVERITY[fitSeverity],
		});
	}
	return entries;
}

interface PrecisionGroupProps {
	currentQuantization: OnnxQuantization;
	/** Lookup ``(modelId, quantization) -> snapshot`` for the active
	 *  download (if any) on this card's variants. Empty / missing entry
	 *  means the badge renders its idle state. */
	getDownloadSnapshot?:
		| ((
				modelId: string,
				quantization: OnnxQuantization,
		  ) => QuantDownloadSnapshot | undefined)
		| undefined;
	isSelectedModel: boolean;
	model: PrecisionRoutedSttModel;
	/** Single dispatch for the four download actions. Selector wires
	 *  this to ``useDownloadStore.{predownloadQuant,pauseQuantDownload,
	 *  resumeQuantDownload,cancelQuantDownload}``. */
	onDownloadAction?:
		| ((
				action: QuantDownloadAction,
				modelId: string,
				quantization: OnnxQuantization,
		  ) => void)
		| undefined;
	onRequestDeleteQuant?:
		| ((
				modelId: string,
				quantization: OnnxQuantization,
				displayName: string,
				quantLabel: string,
		  ) => void)
		| undefined;
	canDeleteQuant?:
		| ((modelId: string, quantization: OnnxQuantization) => boolean)
		| undefined;
	onSelect: (modelId: string, quantization: OnnxQuantization) => void;
	state: ModelStateEntry | undefined;
}

/**
 * Normalize each published precision into a {@link QuantShelfEntry} for the
 * shared {@link QuantShelf}. STT specifics live here: every badge is a concrete
 * precision (incl ``""`` = fp32, the full base export), the RAM/VRAM-aware pick
 * (the model state's ``effective_quantization``) is MARKED recommended, and the
 * active highlight follows the user's pick — falling back to the recommended
 * precision while the selection is still the ``"auto"`` sentinel.
 */
function buildSttQuantEntries({
	model,
	state,
	currentQuantization,
	isSelectedModel,
	getDownloadSnapshot,
	onDownloadAction,
	onRequestDeleteQuant,
	canDeleteQuant,
}: PrecisionGroupProps): QuantShelfEntry[] {
	const recommended = (state?.effective_quantization ??
		null) as OnnxQuantization | null;
	const activeQuant: OnnxQuantization =
		(currentQuantization as string) === "auto"
			? (recommended ?? "")
			: currentQuantization;
	return getQuantizationOptions(model).map((opt) => {
		const backingModelId = backingModelIdForQuant(model, opt.value);
		const cache = resolveQuantCache(state, opt.value);
		const download = getDownloadSnapshot?.(backingModelId, opt.value);
		const downloadState = resolveQuantDownloadState({
			cache,
			download,
			fallbackSizeBytes: [model.sizeBytesByQuantization[opt.value]],
			hasDownloadAction: onDownloadAction !== undefined,
		});
		return {
			value: opt.value,
			modelId: backingModelId,
			label: opt.label,
			tooltip: opt.tooltip,
			actionQuant: opt.value,
			cacheState: downloadState.cacheState,
			cacheProgress: downloadState.cacheProgress,
			cacheStatusLabel: downloadState.cacheStatusLabel,
			download,
			downloadSizeBytes: downloadState.downloadSizeBytes,
			isActive: isSelectedModel && opt.value === activeQuant,
			isRecommended: recommended !== null && opt.value === recommended,
			canResumeDownload: downloadState.canResumeDownload,
			canStartDownload: downloadState.canStartDownload,
			canDelete:
				onRequestDeleteQuant !== undefined &&
				downloadState.isCached &&
				(canDeleteQuant?.(backingModelId, opt.value) ?? true),
		};
	});
}

function resolveActiveSttQuant(
	currentQuantization: OnnxQuantization,
	state: ModelStateEntry | undefined,
): OnnxQuantization {
	const recommended = (state?.effective_quantization ??
		null) as OnnxQuantization | null;
	return (currentQuantization as string) === "auto"
		? (recommended ?? "")
		: currentQuantization;
}

function resolveSttDownloadSizeBytes({
	currentQuantization,
	getDownloadSnapshot,
	model,
	state,
}: {
	currentQuantization: OnnxQuantization;
	getDownloadSnapshot: SttModelCardProps["getDownloadSnapshot"];
	model: PrecisionRoutedSttModel;
	state: ModelStateEntry | undefined;
}): number | null {
	const quant = resolveActiveSttQuant(currentQuantization, state);
	const backingModelId = backingModelIdForQuant(model, quant);
	const download = getDownloadSnapshot?.(backingModelId, quant);
	if (download && download.totalBytes > 0) {
		return Math.max(download.totalBytes, download.downloadedBytes);
	}
	const cache = resolveQuantCache(state, quant);
	if (cache && cache.total_bytes > 0) {
		return Math.max(cache.total_bytes, cache.downloaded_bytes);
	}
	return model.sizeBytesByQuantization[quant] ?? null;
}

/** STT precision shelf — builds the normalized entries and renders the shared
 *  {@link QuantShelf}. The string ⇄ OnnxQuantization casts happen at this
 *  boundary so the shared core stays quant-type agnostic. */
function PrecisionGroup(props: PrecisionGroupProps) {
	const { model, onSelect, onDownloadAction, onRequestDeleteQuant } = props;
	return (
		<QuantShelf
			entries={buildSttQuantEntries(props)}
			modelDisplayName={model.displayName}
			modelId={model.id}
			onDownloadAction={
				onDownloadAction
					? (action, id, q) =>
							onDownloadAction(action, id, q as OnnxQuantization)
					: undefined
			}
			onRequestDeleteQuant={
				onRequestDeleteQuant
					? (id, q, dn, ql) =>
							onRequestDeleteQuant(id, q as OnnxQuantization, dn, ql)
					: undefined
			}
			onSelect={(id, q) => onSelect(id, q as OnnxQuantization)}
		/>
	);
}

function quantForLatencyVariant(
	model: PrecisionRoutedSttModel,
	state: ModelStateEntry | undefined,
	currentQuantization: OnnxQuantization,
): OnnxQuantization {
	if (
		(currentQuantization as string) !== "auto" &&
		model.availableQuantizations.includes(currentQuantization)
	) {
		return currentQuantization;
	}
	const recommended = state?.effective_quantization;
	if (
		typeof recommended === "string" &&
		model.availableQuantizations.includes(recommended)
	) {
		return recommended as OnnxQuantization;
	}
	return (model.availableQuantizations[0] ?? "") as OnnxQuantization;
}

function latencyToneClass(
	active: boolean,
	cacheState: string | undefined,
): string {
	if (active) {
		return "bg-accent/20 text-accent ring-accent/50";
	}
	if (cacheState === "cached") {
		return "bg-emerald-500/[0.08] text-emerald-300/80 ring-border hover:bg-emerald-500/[0.14]";
	}
	if (cacheState === "partial") {
		return "bg-amber-500/[0.08] text-amber-300/80 ring-border hover:bg-amber-500/[0.14]";
	}
	return "bg-foreground/[0.04] text-foreground-muted ring-border hover:bg-foreground/[0.08]";
}

function latencyCacheLabel(
	cache: ModelStateEntry["cache"] | undefined,
	download: QuantDownloadSnapshot | undefined,
): string {
	if (download) {
		return download.progress === null ? "Downloading" : `${download.progress}%`;
	}
	if (cache?.state === "cached") {
		return "Downloaded";
	}
	if (cache?.state === "partial") {
		return `${Math.round(cache.progress * 100)}% downloaded`;
	}
	return "Not downloaded";
}

function latencyTooltip({
	cacheLabel,
	isRecommended,
	latencyLabel,
}: {
	cacheLabel: string;
	isRecommended: boolean;
	latencyLabel: string;
}): string {
	const detail =
		"Lower latency appears sooner but has less right-context. Higher latency waits longer and is usually more accurate/stable.";
	return [
		`${latencyLabel}${isRecommended ? " (accuracy-first)" : ""}`,
		`Status: ${cacheLabel}`,
		detail,
	].join("\n");
}

interface LatencyShelfProps {
	currentQuantization: OnnxQuantization;
	getDownloadSnapshot: SttModelCardProps["getDownloadSnapshot"];
	model: PrecisionRoutedSttModel;
	onDownloadAction: SttModelCardProps["onDownloadAction"];
	onSelect: (modelId: string, quantization: OnnxQuantization) => void;
	selectedId: string | undefined;
	statesById: Record<string, ModelStateEntry>;
}

function LatencyShelf({
	currentQuantization,
	getDownloadSnapshot,
	model,
	onDownloadAction,
	onSelect,
	selectedId,
	statesById,
}: LatencyShelfProps) {
	const variants = latencyVariantsForModel(model);
	if (variants.length <= 1) {
		return null;
	}
	const maxLatencyMs = Math.max(...variants.map((v) => v.latencyMs));
	return (
		<div className="flex flex-wrap items-center gap-2">
			<Tooltip
				content="Streaming latency. Pick lower latency for faster on-screen text, or higher latency for more right-context and steadier accuracy."
				side="top"
			>
				<span className="inline-flex shrink-0 items-center font-medium text-[10px] text-foreground-muted uppercase tracking-wide">
					<HugeiconsIcon className="size-3" icon={Clock01Icon} />
				</span>
			</Tooltip>
			{variants.map((variant) => {
				const variantState = statesById[variant.model.id];
				const quantization = quantForLatencyVariant(
					variant.model,
					variantState,
					currentQuantization,
				);
				const backingModelId = backingModelIdForQuant(
					variant.model,
					quantization,
				);
				const cache = resolveQuantCache(variantState, quantization);
				const download = getDownloadSnapshot?.(backingModelId, quantization);
				const isDownloading = download !== undefined;
				const isActive = isSelectedSttModel(variant.model, selectedId);
				const isRecommended = variant.latencyMs === maxLatencyMs;
				const latencyLabel = formatNativeStreamingLatency(variant.latencyMs);
				const cacheLabel = latencyCacheLabel(cache, download);
				const canStartDownload =
					onDownloadAction !== undefined &&
					!isDownloading &&
					cache?.state !== "cached" &&
					cache?.state !== "partial";
				const canResumeDownload =
					onDownloadAction !== undefined &&
					!isDownloading &&
					cache?.state === "partial";
				return (
					<ButtonGroup
						aria-label={`Streaming latency ${latencyLabel} for ${model.displayName}`}
						className={cn(
							"rounded-md ring-1 ring-inset",
							isRecommended ? "ring-accent/60" : "ring-border",
						)}
						key={`${variant.latencyMs}:${variant.model.id}`}
					>
						<Tooltip
							content={latencyTooltip({
								cacheLabel,
								isRecommended,
								latencyLabel,
							})}
							side="top"
						>
							<BaseButton
								aria-disabled={isDownloading}
								aria-label={`Use ${latencyLabel} streaming latency`}
								className={cn(
									"group/badge inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-[5px] px-2 font-medium text-[10.5px] leading-none ring-1 ring-inset transition-colors",
									isDownloading && "cursor-default",
									latencyToneClass(isActive, cache?.state),
								)}
								onClick={(e) => {
									e.preventDefault();
									e.stopPropagation();
									if (isDownloading) {
										return;
									}
									if (canStartDownload) {
										onDownloadAction?.("start", backingModelId, quantization);
										return;
									}
									if (canResumeDownload) {
										onDownloadAction?.("resume", backingModelId, quantization);
										return;
									}
									onSelect(backingModelId, quantization);
								}}
								onMouseDown={(e) => e.stopPropagation()}
								onPointerDown={(e) => e.stopPropagation()}
								type="button"
							>
								{isRecommended ? (
									<HugeiconsIcon
										aria-hidden="true"
										className="size-3 shrink-0 text-accent"
										icon={SparklesIcon}
									/>
								) : null}
								{canStartDownload ? (
									<span className="relative inline-flex items-center justify-center">
										<span className="transition-opacity duration-150 group-hover/badge:opacity-0 motion-reduce:transition-none">
											{latencyLabel}
										</span>
										<HugeiconsIcon
											aria-hidden="true"
											className="absolute inset-0 m-auto size-3 opacity-0 transition-opacity duration-150 group-hover/badge:opacity-100 motion-reduce:transition-none"
											icon={CloudDownloadIcon}
										/>
									</span>
								) : isDownloading ? (
									<span className="font-mono text-[9.5px] tabular-nums">
										{download.progress === null
											? "..."
											: `${download.progress}%`}
									</span>
								) : cache?.state === "partial" ? (
									<span className="font-mono text-[9.5px] tabular-nums">
										{Math.round(cache.progress * 100)}%
									</span>
								) : (
									<span>{latencyLabel}</span>
								)}
							</BaseButton>
						</Tooltip>
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
	 * in the expand/collapse chevron without overlapping the "Multilingual"
	 * badge (the chevron used to be absolutely positioned and would collide
	 * with the right-edge AttributeGroup when present).
	 */
	actions?: import("react").ReactNode;
	currentQuantization: OnnxQuantization;
	/** Lookup for the active download snapshot per (modelId, quant). The
	 *  picker is self-contained so the consumer wires it; ``undefined``
	 *  return = no active download for that variant. */
	getDownloadSnapshot?:
		| ((
				modelId: string,
				quantization: OnnxQuantization,
		  ) => QuantDownloadSnapshot | undefined)
		| undefined;
	/** Live RAM/VRAM fit assessment for this card, if the host app has one. */
	fitAssessment?: FitAssessmentEntry | null | undefined;
	/**
	 * Set on a bundle primary card whose currently-selected model is one of
	 * its hidden siblings (e.g. a ``.en`` or lite-whisper variant). Renders
	 * a softer "indirect" highlight so the user can spot the family at a
	 * glance without it competing visually with the actually-selected
	 * sibling card below.
	 */
	hasSelectedVariant?: boolean;
	/** Whether ``model.id`` is currently starred — drives the favorite toggle's
	 *  filled/amber state. Defaults to ``false`` when omitted. */
	isFavorite?: ((modelId: string) => boolean) | undefined;
	model: PrecisionRoutedSttModel;
	/**
	 * Renders the recessed {@link CARD_NESTED} chrome — set by
	 * ``SttVariantBundle`` for the sibling cards revealed under the chevron so
	 * they read as subordinate to their primary.
	 */
	nested?: boolean;
	/** Single dispatch for the four download actions emitted by the
	 *  badge controls (Download / Pause / Resume / Cancel). */
	onDownloadAction?:
		| ((
				action: QuantDownloadAction,
				modelId: string,
				quantization: OnnxQuantization,
		  ) => void)
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
				quantLabel: string,
		  ) => void)
		| undefined;
	/** Optional handler that can suppress the trash icon for a specific
	 *  cached/partial precision while leaving other precision actions enabled. */
	canDeleteQuant?:
		| ((modelId: string, quantization: OnnxQuantization) => boolean)
		| undefined;
	onSelect: (modelId: string, quantization?: OnnxQuantization) => void;
	/** Star / unstar handler. When omitted, no favorite toggle is rendered
	 *  (keeps the card read-only for consumers that don't wire favorites). */
	onToggleFavorite?: ((modelId: string) => void) | undefined;
	selectedId: string | undefined;
	statesById?: Record<string, ModelStateEntry>;
	/**
	 * Sibling variants in the same bundle. Passed so {@link variantDisplayName}
	 * can keep the size token when two siblings would otherwise collide to the
	 * same name (e.g. Canary 180M Flash vs Canary 1B Flash → both "Canary Flash").
	 */
	siblings?: readonly ModelInfo[] | undefined;
	state: ModelStateEntry | undefined;
	systemInfo: SystemInfoEntry | null;
}

export function SttModelCard({
	model,
	state,
	statesById,
	systemInfo,
	fitAssessment,
	selectedId,
	currentQuantization,
	onSelect,
	onRequestDeleteQuant,
	canDeleteQuant,
	getDownloadSnapshot,
	onDownloadAction,
	actions,
	hasSelectedVariant = false,
	isFavorite,
	nested = false,
	onToggleFavorite,
	siblings,
}: SttModelCardProps) {
	const isSelected = isSelectedSttModel(model, selectedId);
	const activeModel = activeLatencyModel(model, selectedId);
	const stateLookup: Record<string, ModelStateEntry> =
		statesById ?? (state ? { [model.id]: state } : {});
	const activeState = stateLookup[activeModel.id] ?? state;
	const isUnavailable = model.available === false;
	const downloadSizeBytes = resolveSttDownloadSizeBytes({
		currentQuantization,
		getDownloadSnapshot,
		model: activeModel,
		state: activeState,
	});
	const bytes = formatBytes(downloadSizeBytes ?? 0);
	const metaEntries = buildMetaEntries(
		activeModel,
		bytes,
		activeState,
		systemInfo,
		fitAssessment,
	);
	// Broken custom drops surface the scanner's error verbatim — much more
	// useful than a generic "couldn't load" toast. The label itself is
	// already shown; the tooltip explains *why* the card is greyed out.
	const title =
		isUnavailable && model.errorMessage
			? `Unavailable: ${model.errorMessage}`
			: undefined;
	// STT is the canonical adapter over the shared universal `ModelCard`: the
	// quant precision controls drop into the recessed `shelf`, the bundle
	// expand chevron into `actions`, and the rest maps 1:1. All STT-specific
	// logic (PrecisionGroup, language meta, variant naming) stays here.
	return (
		<ModelCard
			actions={actions}
			data-model-id={model.id}
			description={model.description || undefined}
			errorMessage={model.errorMessage}
			favorite={
				onToggleFavorite
					? {
							isFavorited: isFavorite?.(model.id) ?? false,
							label: model.displayName,
							onToggle: () => onToggleFavorite(model.id),
						}
					: undefined
			}
			indirectlySelected={!isSelected && hasSelectedVariant}
			meta={metaEntries}
			name={variantDisplayName(model, siblings)}
			nested={nested}
			perf={{
				accuracyScore: model.accuracyScore,
				speedScore: model.speedScore,
			}}
			selected={isSelected}
			shelf={
				<div className="flex flex-col gap-2">
					<LatencyShelf
						currentQuantization={currentQuantization}
						getDownloadSnapshot={getDownloadSnapshot}
						model={model}
						onDownloadAction={onDownloadAction}
						onSelect={onSelect}
						selectedId={selectedId}
						statesById={stateLookup}
					/>
					<PrecisionGroup
						currentQuantization={currentQuantization}
						getDownloadSnapshot={getDownloadSnapshot}
						isSelectedModel={isSelected}
						model={activeModel}
						onDownloadAction={onDownloadAction}
						onRequestDeleteQuant={onRequestDeleteQuant}
						canDeleteQuant={canDeleteQuant}
						onSelect={onSelect}
						state={activeState}
					/>
				</div>
			}
			title={title}
			unavailable={isUnavailable}
			value={model}
		/>
	);
}
