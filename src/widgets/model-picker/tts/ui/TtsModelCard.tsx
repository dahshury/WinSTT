"use client";

import {
	Copy01Icon,
	GlobeIcon,
	HardDriveDownloadIcon,
	UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import type { TtsModelInfo, TtsModelState } from "@/entities/tts-catalog";
import { formatBytes } from "@/shared/lib/format-bytes";
import { Tooltip } from "@/shared/ui/tooltip";
import type { MetaEntry } from "../../core/model-card/CardMeta";
import { ModelCard } from "../../core/model-card/ModelCard";
import {
	type QuantDownloadAction,
	type QuantDownloadSnapshot,
	QuantShelf,
	type QuantShelfEntry,
} from "../../core/model-card/QuantShelf";
import { resolveQuantDownloadState } from "../../core/model-card/quant-shelf-state";
import { cloningLabel, ttsLanguageMeta } from "../lib/tts-helpers";

// Re-export the shelf download types from their canonical home so existing
// importers of `./TtsModelCard` (selector, list) keep working unchanged after
// the shelf moved into the shared core.
export type {
	QuantDownloadAction,
	QuantDownloadSnapshot,
} from "../../core/model-card/QuantShelf";

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

interface PrecisionGroupProps {
	currentQuantization: string;
	getDownloadSnapshot?:
		| ((
				modelId: string,
				quantization: string,
		  ) => QuantDownloadSnapshot | undefined)
		| undefined;
	isSelectedModel: boolean;
	model: TtsModelInfo;
	onDownloadAction?:
		| ((
				action: QuantDownloadAction,
				modelId: string,
				quantization: string,
		  ) => void)
		| undefined;
	onRequestDeleteQuant?:
		| ((
				modelId: string,
				quantization: string,
				displayName: string,
				quantLabel: string,
		  ) => void)
		| undefined;
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
function buildTtsQuantEntries({
	model,
	state,
	currentQuantization,
	isSelectedModel,
	getDownloadSnapshot,
	onDownloadAction,
	onRequestDeleteQuant,
}: PrecisionGroupProps): QuantShelfEntry[] {
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
		return {
			value: opt.value,
			label: opt.label,
			tooltip: opt.tooltip,
			actionQuant: effectiveValue,
			cacheState: downloadState.cacheState,
			cacheProgress: downloadState.cacheProgress,
			cacheStatusLabel: downloadState.cacheStatusLabel,
			download,
			downloadSizeBytes: downloadState.downloadSizeBytes,
			isActive: isSelectedModel && opt.value === currentQuantization,
			isRecommended: false,
			canResumeDownload: downloadState.canResumeDownload,
			canStartDownload: downloadState.canStartDownload,
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
	return (
		<QuantShelf
			entries={buildTtsQuantEntries(props)}
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
		entries.push({
			key: "size",
			icon: HardDriveDownloadIcon,
			value: bytes,
			tooltip: `Download size: ${bytes}`,
		});
	}
	return entries;
}

/** The voice-cloning capability chip, rendered into `ModelCard.badges` when the
 *  model supports cloning. `null` for `cloning: 'none'`. */
function CloningChip({ model }: { model: TtsModelInfo }): ReactNode {
	const cloning = cloningLabel(model.cloning);
	if (!cloning) {
		return null;
	}
	return (
		<Tooltip content={cloning.tooltip} side="top">
			<span className="inline-flex shrink-0 items-center gap-1 rounded bg-accent/10 px-1.5 py-0.5 font-medium text-[10px] text-accent">
				<HugeiconsIcon className="size-3" icon={Copy01Icon} />
				{cloning.label}
			</span>
		</Tooltip>
	);
}

export interface TtsModelCardProps {
	/** Currently-effective precision for the selected model — drives the active
	 *  precision badge highlight. */
	currentQuantization: string;
	/** Lookup for the active download snapshot per (modelId, quant). `undefined`
	 *  return = no active download for that variant. */
	getDownloadSnapshot?:
		| ((
				modelId: string,
				quantization: string,
		  ) => QuantDownloadSnapshot | undefined)
		| undefined;
	/** Whether `model.id` is currently starred — drives the favorite toggle. */
	isFavorite?: ((modelId: string) => boolean) | undefined;
	model: TtsModelInfo;
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
 * `shelf` (the shared {@link QuantShelf}), and the voice-cloning capability
 * rides in `badges`.
 */
export function TtsModelCard({
	model,
	state,
	selectedId,
	currentQuantization,
	onSelect,
	onRequestDeleteQuant,
	getDownloadSnapshot,
	onDownloadAction,
	isFavorite,
	onToggleFavorite,
}: TtsModelCardProps) {
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
	const cloningChip = <CloningChip model={model} />;
	return (
		<ModelCard
			badges={model.cloning !== "none" ? cloningChip : undefined}
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
