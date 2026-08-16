"use client";

import {
	BracketsIcon,
	Copy01Icon,
	GlobeIcon,
	MagicWand01Icon,
	UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import type { TtsModelInfo, TtsModelState } from "@/entities/tts-catalog";
import { formatBytes } from "@/shared/lib/format-bytes";
import { Tooltip } from "@/shared/ui/tooltip";
import { downloadSizeMetaEntry } from "@/shared/ui/model-picker/core/model-card/card-meta-helpers";
import type { MetaEntry } from "@/shared/ui/model-picker/core/model-card/CardMeta";
import { ModelCard } from "@/shared/ui/model-picker/core/model-card/ModelCard";
import {
	type QuantDownloadCallbacks,
	QuantShelf,
	type QuantShelfEntry,
} from "@/shared/ui/model-picker/core/model-card/QuantShelf";
import { resolveQuantDownloadState } from "@/shared/ui/model-picker/core/model-card/quant-shelf-state";
import {
	cloningLabel,
	inlineTagsLabel,
	ttsLanguageMeta,
	voiceDesignLabel,
} from "@/entities/tts-catalog";

// Re-export the shelf download types from their canonical home so existing
// importers of `./TtsModelCard` (selector, list) keep working unchanged after
// the shelf moved into the shared core.
export type {
	QuantDownloadAction,
	QuantDownloadSnapshot,
} from "@/shared/ui/model-picker/core/model-card/QuantShelf";

/** Single per-quant cache entry from {@link TtsModelState.cacheByQuantization}. */
type TtsQuantCache = TtsModelState["cacheByQuantization"][string] | undefined;

/** Resolve the cache info for a specific quantization on a TTS model state. */
function resolveTtsQuantCache(
	state: TtsModelState | undefined,
	quantization: string,
): TtsQuantCache {
	return state?.cacheByQuantization?.[quantization];
}

/**
 * The precision the server will *actually* load for a given selection — when
 * the user leaves the quant on the default sentinel (`""`), honor the server's
 * `effectiveQuantization`; concrete picks pass through unchanged. Mirrors the
 * STT `resolveEffectiveQuant`.
 */
function resolveTtsEffectiveQuant(
	state: TtsModelState | undefined,
	selectedQuant: string,
): string {
	if (selectedQuant === "" && state?.effectiveQuantization) {
		return state.effectiveQuantization;
	}
	return selectedQuant;
}

/** One precision option on the shelf. The `""` sentinel renders as "Auto". */
interface TtsQuantOption {
	label: string;
	tooltip: string;
	value: string;
}

const QUANT_TOOLTIP: Record<string, string> = {
	"": "Automatically uses the best precision for your device. Recommended.",
	fp32: "32-bit float. Highest quality, largest + slowest.",
	fp16: "16-bit float. Near-fp32 quality, smaller + faster on GPU.",
	int8: "8-bit integer quantization. Faster and ~4× smaller than fp32, mild quality loss.",
	q8: "8-bit quantization. Similar trade-off to int8.",
	q4: "4-bit quantization. Smallest + fastest, noticeable quality loss.",
};

/** Bit-width proxy used to order the shelf heaviest/most-capable → lightest,
 *  matching the STT shelf's left-to-right convention. Unknown suffixes sort
 *  last so they don't jump ahead of the labelled precisions. */
const QUANT_WEIGHT: Record<string, number> = {
	"": 64,
	fp32: 32,
	fp16: 16,
	int8: 8,
	q8: 8,
	q4: 4,
};

function quantLabel(value: string): string {
	return value === "" ? "Auto" : value;
}

function quantTooltip(value: string): string {
	return QUANT_TOOLTIP[value] ?? `${value} precision.`;
}

/** The precision options the model actually ships, ordered heaviest → lightest. */
function getTtsQuantOptions(model: TtsModelInfo): TtsQuantOption[] {
	return [...model.availableQuantizations]
		.map((value) => ({
			value,
			label: quantLabel(value),
			tooltip: quantTooltip(value),
		}))
		.sort(
			(a, b) => (QUANT_WEIGHT[b.value] ?? -1) - (QUANT_WEIGHT[a.value] ?? -1),
		);
}

interface PrecisionGroupProps
	extends Omit<QuantDownloadCallbacks, "canDeleteQuant"> {
	currentQuantization: string;
	isSelectedModel: boolean;
	model: TtsModelInfo;
	onSelect: (modelId: string, quantization: string) => void;
	state: TtsModelState | undefined;
}

/**
 * Normalize each published precision into a {@link QuantShelfEntry} for the
 * shared {@link QuantShelf}. TTS specifics live here: the `""` sentinel is an
 * "Auto" router whose download/delete controls target the server's effective
 * precision (and which is never itself a download trigger). TTS has no
 * RAM-aware "recommended" mark, so `isRecommended` is always false.
 */
function buildTtsQuantEntries(
	{
		model,
		state,
		currentQuantization,
		isSelectedModel,
		getDownloadSnapshot,
		getFittingQuants,
		onDownloadAction,
		onRequestDeleteQuant,
	}: PrecisionGroupProps,
	unfitReason: string,
): QuantShelfEntry[] {
	const fittingQuants = getFittingQuants?.(model.id) ?? null;
	return getTtsQuantOptions(model).map((opt) => {
		const isAuto = opt.value === "";
		const effectiveValue = isAuto
			? resolveTtsEffectiveQuant(state, opt.value)
			: opt.value;
		const cache = resolveTtsQuantCache(state, effectiveValue);
		const download = getDownloadSnapshot?.(model.id, effectiveValue);
		const downloadState = resolveQuantDownloadState({
			cache,
			canStart: !isAuto,
			download,
			fallbackSizeBytes: [
				model.sizeBytesByQuantization[effectiveValue],
				model.sizeBytesByQuantization[opt.value],
			],
			hasDownloadAction: onDownloadAction !== undefined,
		});
		// Suggested per-quant gating: while the flag is ON, a precision OUTSIDE
		// the fitting set renders disabled/greyed (and stops advertising a
		// download on hover) — mirrors `buildSttQuantEntries`. The "Auto" router
		// is judged by the precision it actually resolves to. TTS has no
		// RAM-aware "Recommended" mark, so there's nothing else to preserve.
		const unfit =
			fittingQuants !== null &&
			!fittingQuants.has(isAuto ? effectiveValue : opt.value);
		return {
			value: opt.value,
			label: opt.label,
			tooltip: opt.tooltip,
			actionQuant: effectiveValue,
			cacheState: downloadState.cacheState,
			cacheProgress: downloadState.cacheProgress,
			cacheStatusLabel: downloadState.cacheStatusLabel,
			disabled: unfit,
			disabledReason: unfit ? unfitReason : undefined,
			download,
			downloadSizeBytes: downloadState.downloadSizeBytes,
			isActive: isSelectedModel && opt.value === currentQuantization,
			isRecommended: false,
			canResumeDownload: downloadState.canResumeDownload && !unfit,
			canStartDownload: downloadState.canStartDownload && !unfit,
			canDelete:
				!isAuto && onRequestDeleteQuant !== undefined && downloadState.isCached,
		};
	});
}

function resolveTtsDownloadSizeBytes({
	currentQuantization,
	getDownloadSnapshot,
	model,
	state,
}: {
	currentQuantization: string;
	getDownloadSnapshot: TtsModelCardProps["getDownloadSnapshot"];
	model: TtsModelInfo;
	state: TtsModelState | undefined;
}): number | null {
	const quant =
		currentQuantization === ""
			? (state?.effectiveQuantization ?? model.availableQuantizations[0] ?? "")
			: resolveTtsEffectiveQuant(state, currentQuantization);
	// A model's download size is a static, known fact: the catalog ships it per
	// quant, so it's authoritative whenever present — full stop. (Trusting a
	// runtime number over it is what let a partial-download artifact masquerade
	// as the model's size.)
	const catalogBytes =
		model.sizeBytesByQuantization[quant] ??
		model.sizeBytesByQuantization[currentQuantization];
	if (catalogBytes !== undefined && catalogBytes > 0) {
		return catalogBytes;
	}
	// Catalog ships no size for this quant: surface a real downloaded total if we
	// have one — but never a partial cache's on-disk bytes — else the estimate.
	const download = getDownloadSnapshot?.(model.id, quant);
	if (download && download.totalBytes > 0) {
		return Math.max(download.totalBytes, download.downloadedBytes);
	}
	const cache = resolveTtsQuantCache(state, quant);
	if (cache && cache.state === "cached" && cache.totalBytes > 0) {
		return Math.max(cache.totalBytes, cache.downloadedBytes);
	}
	return state?.estimatedBytes ?? null;
}

/** TTS precision shelf — builds the normalized entries and renders the shared
 *  {@link QuantShelf}. A TTS model ships a single precision, so this is what
 *  surfaces its lone downloadable badge (the shelf hides only when there are
 *  literally no precisions). */
function PrecisionGroup(props: PrecisionGroupProps) {
	const { model, onSelect, onDownloadAction, onRequestDeleteQuant } = props;
	const t = useTranslations("modelPicker");
	return (
		<QuantShelf
			entries={buildTtsQuantEntries(props, t("quantNeedsMoreMemory"))}
			modelDisplayName={model.displayName}
			modelId={model.id}
			onDownloadAction={onDownloadAction}
			onRequestDeleteQuant={onRequestDeleteQuant}
			onSelect={onSelect}
		/>
	);
}

/** The ordered facts under the model name: number of voices, language support,
 *  and download size. */
function buildMetaEntries(
	model: TtsModelInfo,
	bytes: string | null,
): MetaEntry[] {
	const entries: MetaEntry[] = [];
	const voiceLabel =
		model.numVoices === 1 ? "1 voice" : `${model.numVoices} voices`;
	entries.push({
		key: "voices",
		icon: UserMultiple02Icon,
		value: voiceLabel,
		tooltip: `${voiceLabel} available in this model`,
	});
	const lang = ttsLanguageMeta(model.languages);
	entries.push({
		key: "lang",
		icon: GlobeIcon,
		value: lang.label,
		tooltip: lang.tooltip,
	});
	if (bytes) {
		entries.push(downloadSizeMetaEntry(bytes));
	}
	return entries;
}

/**
 * One voice-capability chip in `ModelCard.badges` — the single pill definition
 * the cloning / voice-design / inline-tag badges all share, so the three read as
 * one family and only the glyph tells them apart.
 *
 * `iconOnly` keeps the label available to screen readers while spending only a
 * glyph's width: badges sit on the SAME single `overflow-hidden` line as the
 * meta strip (see `ModelCard`'s IdentityColumn), so every character a chip
 * spends is a character clipped off "54 voices · Multilingual (23) · 566 MB".
 * Chatterbox Turbo carries two chips at once, which is why the third capability
 * is the one that goes icon-only.
 */
function CapabilityChip({
	icon,
	iconOnly = false,
	label,
	tooltip,
}: {
	icon: IconSvgElement;
	iconOnly?: boolean;
	label: string;
	tooltip: string;
}): ReactNode {
	return (
		<Tooltip content={tooltip} side="top">
			<span className="inline-flex shrink-0 items-center gap-1 rounded bg-accent/10 px-1.5 py-0.5 font-medium text-[10px] text-accent">
				<HugeiconsIcon className="size-3" icon={icon} />
				{iconOnly ? <span className="sr-only">{label}</span> : label}
			</span>
		</Tooltip>
	);
}

export interface TtsModelCardProps
	extends Omit<QuantDownloadCallbacks, "canDeleteQuant"> {
	/** Currently-effective precision for the selected model — drives the active
	 *  precision badge highlight. */
	currentQuantization: string;
	/** Whether `model.id` is currently starred — drives the favorite toggle. */
	isFavorite?: ((modelId: string) => boolean) | undefined;
	model: TtsModelInfo;
	onSelect: (modelId: string, quantization?: string) => void;
	/** Star / unstar handler. When omitted, no favorite toggle is rendered. */
	onToggleFavorite?: ((modelId: string) => void) | undefined;
	selectedId: string | undefined;
	state: TtsModelState | undefined;
}

/**
 * The TTS adapter over the universal {@link ModelCard} — the exact same shape
 * as `SttModelCard`: meta line = voices + languages + size, the perf module =
 * quality + speed bars, the quant precision controls drop into the recessed
 * `shelf` (the shared {@link QuantShelf}), and the voice capabilities — cloning
 * (clip vs clip + transcript), voice design, inline paralinguistic tags — ride
 * in `badges`.
 */
export function TtsModelCard({
	model,
	state,
	selectedId,
	currentQuantization,
	onSelect,
	onRequestDeleteQuant,
	getDownloadSnapshot,
	getFittingQuants,
	onDownloadAction,
	isFavorite,
	onToggleFavorite,
}: TtsModelCardProps) {
	const t = useTranslations("modelPicker");
	const isSelected = model.id === selectedId;
	const isUnavailable = model.available === false;
	const downloadSizeBytes = resolveTtsDownloadSizeBytes({
		currentQuantization,
		getDownloadSnapshot,
		model,
		state,
	});
	const bytes = formatBytes(downloadSizeBytes ?? 0);
	const metaEntries = buildMetaEntries(model, bytes);
	// The three voice capabilities ride in `badges`. Each builder returns `null`
	// when the row doesn't advertise it, and the container itself stays hidden
	// (`undefined`) when the model advertises none — so a plain preset-voice model
	// keeps the identical footprint. Cloning distinguishes its two tiers by LABEL
	// (clip vs clip + transcript) because that changes what the user must supply.
	const cloning = cloningLabel(model, t);
	const inlineTags = inlineTagsLabel(model, t);
	const design = model.voiceDesign ? voiceDesignLabel(t) : null;
	const capabilityBadges =
		cloning || design || inlineTags ? (
			<>
				{cloning ? (
					<CapabilityChip
						icon={Copy01Icon}
						label={cloning.label}
						tooltip={cloning.tooltip}
					/>
				) : null}
				{design ? (
					<CapabilityChip
						icon={MagicWand01Icon}
						label={design.label}
						tooltip={design.tooltip}
					/>
				) : null}
				{inlineTags ? (
					<CapabilityChip
						icon={BracketsIcon}
						iconOnly
						label={inlineTags.label}
						tooltip={inlineTags.tooltip}
					/>
				) : null}
			</>
		) : undefined;
	return (
		<ModelCard
			badges={capabilityBadges}
			data-model-id={model.id}
			description={model.description}
			favorite={
				onToggleFavorite
					? {
							isFavorited: isFavorite?.(model.id) ?? false,
							label: model.displayName,
							onToggle: () => onToggleFavorite(model.id),
						}
					: undefined
			}
			meta={metaEntries}
			name={model.displayName}
			perf={{ accuracyScore: model.qualityScore, speedScore: model.speedScore }}
			selected={isSelected}
			shelf={
				<PrecisionGroup
					currentQuantization={currentQuantization}
					getDownloadSnapshot={getDownloadSnapshot}
					getFittingQuants={getFittingQuants}
					isSelectedModel={isSelected}
					model={model}
					onDownloadAction={onDownloadAction}
					onRequestDeleteQuant={onRequestDeleteQuant}
					onSelect={onSelect}
					state={state}
				/>
			}
			unavailable={isUnavailable}
			value={model}
		/>
	);
}
