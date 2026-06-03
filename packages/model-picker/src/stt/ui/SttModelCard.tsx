"use client";

import {
	AlertCircleIcon,
	GlobeIcon,
	HardDriveDownloadIcon,
	NeuralNetworkIcon,
} from "@hugeicons/core-free-icons";
import type { ModelInfo } from "@/entities/model-catalog";
import type { ModelStateEntry, SystemInfoEntry } from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";
import { formatBytes } from "@/shared/lib/format-bytes";
import {
	type MetaEntry,
	ModelCard,
	type QuantDownloadAction,
	type QuantDownloadSnapshot,
	QuantShelf,
	type QuantShelfEntry,
} from "../../core/model-card";
import { resolveQuantCache } from "../lib/cache-helpers";
import { variantDisplayName } from "../lib/family-helpers";
import { isUncomfortable } from "../lib/hardware-fit";
import { formatLanguages } from "../lib/language-names";
import { quantCacheStatus } from "../lib/pill-helpers";
import { getQuantizationOptions } from "../lib/quantization-helpers";
import { variantMeta } from "../lib/variant-helpers";

// Re-export the shelf download types from their canonical home so existing
// importers of `./SttModelCard` (selector, list, variant bundle, tests) keep
// working unchanged after the shelf moved into the shared core.
export type { QuantDownloadAction, QuantDownloadSnapshot } from "../../core/model-card";

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
		return { label: "English", tooltip: "English only — no multilingual support" };
	}
	const codes = model.languages.map((l) => l.toUpperCase());
	return { label: codes.join("/"), tooltip: `Supports: ${codes.join(", ")}` };
}

/** The ordered facts shown under the model name: parameters, download size,
 *  language support, and (only when relevant) the hardware-fit warning. */
function buildMetaEntries(
	model: ModelInfo,
	bytes: string | null,
	state: ModelStateEntry | undefined,
	systemInfo: SystemInfoEntry | null
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
	entries.push({ key: "lang", icon: GlobeIcon, value: lang.label, tooltip: lang.tooltip });
	if (isUncomfortable(state, systemInfo)) {
		entries.push({
			key: "fit",
			icon: AlertCircleIcon,
			value: "Won't fit",
			tooltip: "May not fit comfortably on your hardware",
			className: "text-error",
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
}: PrecisionGroupProps): QuantShelfEntry[] {
	const recommended = (state?.effective_quantization ?? null) as OnnxQuantization | null;
	const activeQuant: OnnxQuantization =
		(currentQuantization as string) === "auto" ? (recommended ?? "") : currentQuantization;
	return getQuantizationOptions(model).map((opt) => {
		const cache = resolveQuantCache(state, opt.value);
		const download = getDownloadSnapshot?.(model.id, opt.value);
		const isOnDisk = cache?.state === "cached" || cache?.state === "partial";
		return {
			value: opt.value,
			label: opt.label,
			tooltip: opt.tooltip,
			actionQuant: opt.value,
			cacheState: cache?.state,
			cacheProgress: cache?.state === "partial" ? (cache.progress ?? 0) : null,
			cacheStatusLabel: quantCacheStatus(cache),
			download,
			isActive: isSelectedModel && opt.value === activeQuant,
			isRecommended: recommended !== null && opt.value === recommended,
			canStartDownload: !(download !== undefined || isOnDisk) && onDownloadAction !== undefined,
			canDelete: onRequestDeleteQuant !== undefined && isOnDisk,
		};
	});
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
					? (action, id, q) => onDownloadAction(action, id, q as OnnxQuantization)
					: undefined
			}
			onRequestDeleteQuant={
				onRequestDeleteQuant
					? (id, q, dn, ql) => onRequestDeleteQuant(id, q as OnnxQuantization, dn, ql)
					: undefined
			}
			onSelect={(id, q) => onSelect(id, q as OnnxQuantization)}
		/>
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
	/** Whether ``model.id`` is currently starred — drives the favorite toggle's
	 *  filled/amber state. Defaults to ``false`` when omitted. */
	isFavorite?: ((modelId: string) => boolean) | undefined;
	model: ModelInfo;
	/**
	 * Renders the recessed {@link CARD_NESTED} chrome — set by
	 * ``SttVariantBundle`` for the sibling cards revealed under the chevron so
	 * they read as subordinate to their primary.
	 */
	nested?: boolean;
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
	/** Star / unstar handler. When omitted, no favorite toggle is rendered
	 *  (keeps the card read-only for consumers that don't wire favorites). */
	onToggleFavorite?: ((modelId: string) => void) | undefined;
	selectedId: string | undefined;
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
	systemInfo,
	selectedId,
	currentQuantization,
	onSelect,
	onRequestDeleteQuant,
	getDownloadSnapshot,
	onDownloadAction,
	actions,
	hasSelectedVariant = false,
	isFavorite,
	nested = false,
	onToggleFavorite,
	siblings,
}: SttModelCardProps) {
	const isSelected = model.id === selectedId;
	const isUnavailable = model.available === false;
	const bytes = formatBytes(state?.estimated_bytes ?? 0);
	const metaEntries = buildMetaEntries(model, bytes, state, systemInfo);
	// Broken custom drops surface the scanner's error verbatim — much more
	// useful than a generic "couldn't load" toast. The label itself is
	// already shown; the tooltip explains *why* the card is greyed out.
	const title =
		isUnavailable && model.errorMessage ? `Unavailable: ${model.errorMessage}` : undefined;
	// STT is the canonical adapter over the shared universal `ModelCard`: the
	// quant precision controls drop into the recessed `shelf`, the bundle
	// expand chevron into `actions`, and the rest maps 1:1. All STT-specific
	// logic (PrecisionGroup, language meta, variant naming) stays here.
	return (
		<ModelCard
			actions={actions}
			data-model-id={model.id}
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
			perf={{ accuracyScore: model.accuracyScore, speedScore: model.speedScore }}
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
			title={title}
			unavailable={isUnavailable}
			value={model}
		/>
	);
}
