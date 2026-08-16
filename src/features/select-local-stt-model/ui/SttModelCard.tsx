"use client";

import { Button as BaseButton } from "@base-ui/react/button";
import {
	AlertCircleIcon,
	Clock01Icon,
	CloudDownloadIcon,
	CpuIcon,
	GlobeIcon,
	LanguageSkillIcon,
	LiveStreaming02Icon,
	NeuralNetworkIcon,
	SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import {
	type ModelInfo,
	resolveQuantCache,
	supportsTranslateToEnglish,
} from "@/entities/model-catalog";
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
import { downloadSizeMetaEntry } from "@/shared/ui/model-picker/core/model-card/card-meta-helpers";
import type { MetaEntry } from "@/shared/ui/model-picker/core/model-card/CardMeta";
import { ModelCard } from "@/shared/ui/model-picker/core/model-card/ModelCard";
import {
	type QuantCacheState,
	type QuantDownloadCallbacks,
	type QuantDownloadSnapshot,
	QuantShelf,
	type QuantShelfEntry,
} from "@/shared/ui/model-picker/core/model-card/QuantShelf";
import {
	badgeToneForCache,
	resolveProgressFillPct,
	resolveQuantDownloadState,
} from "@/shared/ui/model-picker/core/model-card/quant-shelf-state";
import { variantDisplayName } from "../lib/family-helpers";
import { severityFor } from "../lib/hardware-fit";
import { formatLanguages } from "@/shared/ui/model-picker/lib/language-names";
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
} from "@/shared/ui/model-picker/core/model-card/QuantShelf";

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

/** Precisions that lean on a GPU: fp16-family and 4-bit integer weights. On a
 *  CPU-only host these decode noticeably slower than an int8/fp32 path, and the
 *  int4-only models (Cohere / Canary) have no lighter fallback — so a card whose
 *  effective precision is one of these earns a subtle CPU hint. */
const GPU_ORIENTED_QUANTS: ReadonlySet<OnnxQuantization> = new Set([
	"fp16",
	"fp16w",
	"int4",
	"q4f16",
]);

function systemHasGpu(sys: SystemInfoEntry | null): boolean {
	return sys !== null && sys.gpus.length > 0;
}

/** The subtle "CPU — expect slower decode" meta entry, shown only when the host
 *  has no detected GPU AND this card's effective precision is GPU-oriented.
 *  Reuses the same `systemInfo.gpus` signal the hardware-fit warning reads, so
 *  no new device probe is introduced. */
function cpuSlowdownEntry(
	model: ModelInfo,
	state: ModelStateEntry | undefined,
	systemInfo: SystemInfoEntry | null,
): MetaEntry | null {
	if (systemHasGpu(systemInfo)) {
		return null;
	}
	const effective = (state?.effective_quantization ??
		null) as OnnxQuantization | null;
	const gpuOriented =
		effective === null
			? model.availableQuantizations.some((q) =>
					GPU_ORIENTED_QUANTS.has(q as OnnxQuantization),
				)
			: GPU_ORIENTED_QUANTS.has(effective);
	if (!gpuOriented) {
		return null;
	}
	return {
		key: "cpu-hint",
		icon: CpuIcon,
		value: "CPU",
		tooltip:
			"No GPU detected — this precision runs on CPU, so expect slower decode.",
		className: "text-foreground-muted",
	};
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
		entries.push(downloadSizeMetaEntry(bytes));
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
			// Just the word here — the per-chunk latency lives on the latency shelf
			// below (and in this tooltip), so the meta line stays short and one-line.
			icon: LiveStreaming02Icon,
			value: "Streaming",
			tooltip:
				latency === null
					? "Feeds new audio into a stateful streaming decoder"
					: `Feeds new audio into a stateful streaming decoder with ${latency} chunk latency`,
		});
	}
	// Native decoder translation is a catalog-level capability (multilingual
	// Whisper → English, NeMo Canary → any of its languages), so it reads as a
	// model fact alongside Streaming/Multilingual. The Transcriptions-tab picker
	// is where you choose the actual output language; the badge just advertises
	// that the model can do it at all.
	if (supportsTranslateToEnglish(model)) {
		const canary = model.id.startsWith("nemo-canary-");
		entries.push({
			key: "translate",
			icon: LanguageSkillIcon,
			value: "Translate",
			tooltip: canary
				? "Can translate speech between its languages during transcription"
				: "Can translate non-English speech to English during transcription",
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
	const cpuHint = cpuSlowdownEntry(model, state, systemInfo);
	if (cpuHint) {
		entries.push(cpuHint);
	}
	return entries;
}

interface PrecisionGroupProps extends QuantDownloadCallbacks<OnnxQuantization> {
	currentQuantization: OnnxQuantization;
	isSelectedModel: boolean;
	model: PrecisionRoutedSttModel;
	onSelect: (modelId: string, quantization: OnnxQuantization) => void;
	state: ModelStateEntry | undefined;
	compact?: boolean;
}

/**
 * Normalize each published precision into a {@link QuantShelfEntry} for the
 * shared {@link QuantShelf}. STT specifics live here: every badge is a concrete
 * precision (incl ``""`` = fp32, the full base export), the RAM/VRAM-aware pick
 * (the model state's ``effective_quantization``) is MARKED recommended, and the
 * active highlight follows the user's pick — falling back to the recommended
 * precision while the selection is still the ``"auto"`` sentinel.
 */
function buildSttQuantEntries(
	{
		model,
		state,
		currentQuantization,
		isSelectedModel,
		getDownloadSnapshot,
		getFittingQuants,
		onDownloadAction,
		onRequestDeleteQuant,
		canDeleteQuant,
	}: PrecisionGroupProps,
	unfitReason: string,
): QuantShelfEntry[] {
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
		// Suggested per-quant gating: while the flag is ON, a precision OUTSIDE
		// the fitting set renders disabled/greyed (and stops advertising a
		// download on hover). Keyed by the badge's BACKING model id so
		// streaming-precision-merged cards judge each precision against the raw
		// catalog row that publishes it. The "Recommended" mark stays untouched —
		// the server's fit-aware effective quant sits inside the fitting set by
		// construction.
		const fittingQuants = getFittingQuants?.(backingModelId) ?? null;
		const unfit = fittingQuants !== null && !fittingQuants.has(opt.value);
		return {
			value: opt.value,
			modelId: backingModelId,
			label: opt.label,
			tooltip: opt.tooltip,
			actionQuant: opt.value,
			cacheState: downloadState.cacheState,
			cacheProgress: downloadState.cacheProgress,
			cacheStatusLabel: downloadState.cacheStatusLabel,
			disabled: unfit,
			disabledReason: unfit ? unfitReason : undefined,
			download,
			downloadSizeBytes: downloadState.downloadSizeBytes,
			isActive: isSelectedModel && opt.value === activeQuant,
			isRecommended: recommended !== null && opt.value === recommended,
			canResumeDownload: downloadState.canResumeDownload && !unfit,
			canStartDownload: downloadState.canStartDownload && !unfit,
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
	// A model's download size is a static, known fact: the catalog ships it per
	// quant, so it's authoritative whenever present — full stop. (Trusting a
	// runtime number over it is exactly what let a 1 MB partial-download artifact
	// masquerade as cohere's multi-GB size.)
	const catalogBytes = model.sizeBytesByQuantization[quant];
	if (catalogBytes !== undefined && catalogBytes > 0) {
		return catalogBytes;
	}
	// Only the few catalog rows that ship NO size for this quant (e.g. moonshine)
	// reach here. Surface a real downloaded total if we have one — but never a
	// partial cache's on-disk bytes, which are a progress number, not the size.
	const backingModelId = backingModelIdForQuant(model, quant);
	const download = getDownloadSnapshot?.(backingModelId, quant);
	if (download && download.totalBytes > 0) {
		return Math.max(download.totalBytes, download.downloadedBytes);
	}
	const cache = resolveQuantCache(state, quant);
	if (cache && cache.state === "cached" && cache.total_bytes > 0) {
		return Math.max(cache.total_bytes, cache.downloaded_bytes);
	}
	return null;
}

/** STT precision shelf — builds the normalized entries and renders the shared
 *  {@link QuantShelf}. The string ⇄ OnnxQuantization casts happen at this
 *  boundary so the shared core stays quant-type agnostic. */
function PrecisionGroup(props: PrecisionGroupProps) {
	const { model, onSelect, onDownloadAction, onRequestDeleteQuant } = props;
	const t = useTranslations("modelPicker");
	return (
		<QuantShelf
			entries={buildSttQuantEntries(props, t("quantNeedsMoreMemory"))}
			modelDisplayName={model.displayName}
			modelId={model.id}
			compact={props.compact ?? false}
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
	compact?: boolean;
}

function LatencyShelf({
	currentQuantization,
	getDownloadSnapshot,
	model,
	onDownloadAction,
	onSelect,
	selectedId,
	statesById,
	compact = false,
}: LatencyShelfProps) {
	const variants = latencyVariantsForModel(model);
	if (variants.length <= 1) {
		return null;
	}
	const maxLatencyMs = Math.max(...variants.map((v) => v.latencyMs));
	return (
		<div
			className={cn(
				"flex flex-wrap items-center",
				compact ? "gap-1.5" : "gap-2",
			)}
		>
			<Tooltip
				content="Streaming latency. Pick lower latency for faster on-screen text, or higher latency for more right-context and steadier accuracy."
				side="top"
			>
				<span className="inline-flex shrink-0 items-center font-medium text-[10px] text-foreground-muted uppercase tracking-wide">
					<HugeiconsIcon
						className={compact ? "size-2.5" : "size-3"}
						icon={Clock01Icon}
					/>
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
				const cacheState = cache?.state as QuantCacheState | undefined;
				const progressFillPct = resolveProgressFillPct(
					cacheState,
					cache?.progress ?? null,
					download,
				);
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
							// 5px to match the inner badges (rounded-sm): the inset ring is a
							// box-shadow, so a flush child with a tighter radius pokes past the
							// group corner. Equal radii keep the ring flush to the fill.
							"rounded-sm ring-1 ring-inset",
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
									// Mirror the precision badge exactly: a single ring lives on the
									// enclosing ButtonGroup, so the inner button carries NO ring of
									// its own (a second inset ring here is what made these badges
									// read heavier than the quant badges).
									"group/badge relative inline-flex items-center gap-1.5 overflow-hidden rounded-[5px] px-2 font-medium leading-none transition-colors",
									compact ? "h-5 text-[10px]" : "h-6 text-[10.5px]",
									isDownloading ? "cursor-default" : "cursor-pointer",
									isActive
										? "bg-accent/20 text-accent"
										: badgeToneForCache(cacheState),
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
								{progressFillPct !== null && !isActive ? (
									<span
										aria-hidden="true"
										className="pointer-events-none absolute inset-y-0 left-0 bg-cache-partial/20 transition-[width] duration-200 ease-out motion-reduce:transition-none"
										style={{ width: `${progressFillPct}%` }}
									/>
								) : null}
								{isRecommended ? (
									<HugeiconsIcon
										aria-hidden="true"
										className={cn(
											"shrink-0 text-accent",
											compact ? "size-2.5" : "size-3",
										)}
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
											className={cn(
												"absolute inset-0 m-auto opacity-0 transition-opacity duration-150 group-hover/badge:opacity-100 motion-reduce:transition-none",
												compact ? "size-2.5" : "size-3",
											)}
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

export interface SttModelCardProps
	extends QuantDownloadCallbacks<OnnxQuantization> {
	/**
	 * Optional content rendered in the card's BOTTOM-right footer (above the
	 * precision shelf). Used by ``SttVariantBundle`` to slot in the
	 * "+N variants" expander. Kept out of the top-right cluster so the perf
	 * bars keep a stable x-position whether or not a card has variants.
	 */
	variantExpander?: import("react").ReactNode;
	currentQuantization: OnnxQuantization;
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
	compact?: boolean;
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
	getFittingQuants,
	onDownloadAction,
	variantExpander,
	hasSelectedVariant = false,
	compact = false,
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
	// useful than a generic "couldn't load" toast. `errorMessage` renders both
	// inline under the name and on the Broken badge's styled tooltip; no native
	// title attribute (tooltips are unified on the shared styled Tooltip).
	// STT is the canonical adapter over the shared universal `ModelCard`: the
	// quant precision controls drop into the recessed `shelf`, the bundle
	// expand chevron into the bottom-right `footer`, and the rest maps 1:1. All
	// STT-specific logic (PrecisionGroup, language meta, variant naming) stays here.
	return (
		<ModelCard
			data-model-id={model.id}
			compact={compact}
			footer={variantExpander}
			description={compact ? undefined : model.description || undefined}
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
			className={compact ? "gap-1.5 my-1 py-2" : undefined}
			perf={
				compact
					? undefined
					: {
							accuracyScore: model.accuracyScore,
							speedScore: model.speedScore,
						}
			}
			selected={isSelected}
			shelf={
				<div className={cn("flex flex-col", compact ? "gap-1.5" : "gap-2")}>
					<LatencyShelf
						currentQuantization={currentQuantization}
						getDownloadSnapshot={getDownloadSnapshot}
						model={model}
						onDownloadAction={onDownloadAction}
						onSelect={onSelect}
						selectedId={selectedId}
						statesById={stateLookup}
						compact={compact}
					/>
					<PrecisionGroup
						currentQuantization={currentQuantization}
						getDownloadSnapshot={getDownloadSnapshot}
						getFittingQuants={getFittingQuants}
						isSelectedModel={isSelected}
						model={activeModel}
						onDownloadAction={onDownloadAction}
						onRequestDeleteQuant={onRequestDeleteQuant}
						canDeleteQuant={canDeleteQuant}
						onSelect={onSelect}
						state={activeState}
						compact={compact}
					/>
				</div>
			}
			unavailable={isUnavailable}
			value={model}
		/>
	);
}
