"use client";

import {
	AlertCircleIcon,
	BinaryCodeIcon,
	CancelCircleIcon,
	CloudDownloadIcon,
	Delete02Icon,
	GlobeIcon,
	HardDriveDownloadIcon,
	NeuralNetworkIcon,
	PauseIcon,
	PlayIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ModelInfo } from "@/entities/model-catalog";
import type { ModelCacheInfo, ModelStateEntry, SystemInfoEntry } from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";
import { cn } from "@/shared/lib/cn";
import { formatBytes } from "@/shared/lib/format-bytes";
import { ButtonGroup } from "@/shared/ui/button-group";
import { Tooltip } from "@/shared/ui/tooltip";
import { type MetaEntry, ModelCard } from "../../core/model-card";
import { resolveEffectiveQuant, resolveQuantCache } from "../lib/cache-helpers";
import { variantDisplayName } from "../lib/family-helpers";
import { isUncomfortable } from "../lib/hardware-fit";
import { formatLanguages } from "../lib/language-names";
import { quantCacheStatus } from "../lib/pill-helpers";
import { getQuantizationOptions } from "../lib/quantization-helpers";
import { variantMeta } from "../lib/variant-helpers";

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

type BadgeIconButtonTone = "neutral" | "danger" | "primary";

/** Maps a {@link BadgeIconButtonTone} to its Tailwind class string. Extracted
 *  to avoid a nested ternary in the button render path. */
function toneClassName(tone: BadgeIconButtonTone): string {
	const map: Record<BadgeIconButtonTone, string> = {
		danger: "bg-foreground/[0.04] text-foreground-muted hover:bg-error/15 hover:text-error",
		primary: "bg-foreground/[0.04] text-accent hover:bg-accent/15",
		neutral:
			"bg-foreground/[0.04] text-foreground-muted hover:bg-foreground/[0.10] hover:text-foreground",
	};
	return map[tone];
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
	tone?: BadgeIconButtonTone;
	tooltip: string;
}) {
	const toneClass = toneClassName(tone);
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

type QuantOption = ReturnType<typeof getQuantizationOptions>[number];
type QuantCacheState = ReturnType<typeof resolveQuantCache>;

interface QuantActionButtonsProps {
	/** The precision these controls actually act on. For a concrete badge this
	 *  equals ``opt.value``; for the Auto badge it's the SERVER's effective
	 *  precision (e.g. ``int8`` for an int8-preferred family) so pause / resume /
	 *  cancel target the same ``model@quant`` key the download was started under.
	 *  ``opt.label`` is still used for the human-facing tooltip/aria text. */
	actionQuant: OnnxQuantization;
	cache: QuantCacheState;
	download: QuantDownloadSnapshot | undefined;
	model: ModelInfo;
	onDownloadAction:
		| ((action: QuantDownloadAction, modelId: string, quantization: OnnxQuantization) => void)
		| undefined;
	onRequestDeleteQuant:
		| ((
				modelId: string,
				quantization: OnnxQuantization,
				displayName: string,
				quantLabel: string
		  ) => void)
		| undefined;
	opt: QuantOption;
}

/** Renders the 0..2 trailing action buttons (Pause / Resume / Cancel /
 *  Download / Delete) appended to a precision badge in the same ButtonGroup.
 *  Extracted from {@link QuantOptionButton} so each branch is counted in its
 *  own scope, keeping both functions under the cognitive-complexity cap. */
function QuantActionButtons({
	actionQuant,
	cache,
	download,
	model,
	opt,
	onRequestDeleteQuant,
	onDownloadAction,
}: QuantActionButtonsProps) {
	const isDownloading = download !== undefined;
	const isOnDisk = cache?.state === "cached" || cache?.state === "partial";
	const canDelete = onRequestDeleteQuant !== undefined && isOnDisk;
	const canDownload = onDownloadAction !== undefined;
	const deleteTooltip =
		cache?.state === "partial"
			? `Delete partial ${opt.label} download`
			: `Delete cached ${opt.label} weights`;
	return (
		<>
			{/* Active download → Pause/Resume + Cancel. */}
			{isDownloading && canDownload && download.paused ? (
				<BadgeIconButton
					ariaLabel={`Resume ${opt.label} download`}
					icon={PlayIcon}
					onClick={() => onDownloadAction("resume", model.id, actionQuant)}
					tone="primary"
					tooltip="Resume download"
				/>
			) : null}
			{isDownloading && canDownload && !download.paused ? (
				<BadgeIconButton
					ariaLabel={`Pause ${opt.label} download`}
					icon={PauseIcon}
					onClick={() => onDownloadAction("pause", model.id, actionQuant)}
					tooltip="Pause download (resumable mid-file)"
				/>
			) : null}
			{isDownloading && canDownload ? (
				<BadgeIconButton
					ariaLabel={`Cancel ${opt.label} download`}
					icon={CancelCircleIcon}
					onClick={() => onDownloadAction("cancel", model.id, actionQuant)}
					tone="danger"
					tooltip="Cancel download"
				/>
			) : null}
			{/* Idle + not cached has NO trailing button — the precision badge
			    itself is the download affordance (click to start; hover swaps
			    its label for the download glyph). See QuantBadgeLabel. */}
			{canDelete && !isDownloading && onRequestDeleteQuant ? (
				<BadgeIconButton
					ariaLabel={`Delete ${opt.label} weights for ${model.displayName}`}
					icon={Delete02Icon}
					onClick={() => onRequestDeleteQuant(model.id, actionQuant, model.displayName, opt.label)}
					tone="danger"
					tooltip={deleteTooltip}
				/>
			) : null}
		</>
	);
}

/** Idle (non-selected) precision-badge tint, by on-disk state.
 *  Matches the emerald / amber / neutral palette used by the other
 *  cache pills (see ``cache-helpers.ts``) so downloaded quantizations
 *  now read at a glance from the badge fill itself — the old leading
 *  status dot is gone. */
function badgeToneForCache(state: "cached" | "partial" | "not_cached" | undefined): string {
	// Muted semantic tints: green still means "on disk", amber "partial", but
	// both are heavily desaturated (soft 300-shade text on a faint fill) so they
	// sit inside the grayscale fluidfunctionalism palette instead of glowing.
	// Not-cached is fully neutral — differentiation is "tinted vs gray".
	if (state === "cached") {
		return "bg-emerald-500/[0.08] text-emerald-300/80 hover:bg-emerald-500/[0.14]";
	}
	if (state === "partial") {
		return "bg-amber-500/[0.08] text-amber-300/80 hover:bg-amber-500/[0.14]";
	}
	return "bg-foreground/[0.04] text-foreground-muted hover:bg-foreground/[0.08]";
}

/** Percentage [0..100] to amber-fill the badge background for an
 *  in-progress / partly-cached quantization, or ``null`` to skip the
 *  overlay. Active downloads win over the on-disk snapshot so the bar
 *  ticks live; partial-cache progress is the float in [0..1] saved by
 *  the IPC layer.  ``ModelCacheInfo`` types ``progress`` as ``number``,
 *  but historical payloads have occasionally arrived undefined — coerce
 *  defensively so a missing field doesn't paint a 0%-NaN bar. */
function resolveProgressFillPct(
	cache: ModelCacheInfo | undefined,
	download: QuantDownloadSnapshot | undefined
): number | null {
	if (download && typeof download.progress === "number") {
		return Math.max(0, Math.min(100, download.progress));
	}
	if (cache?.state === "partial") {
		const raw = (cache.progress ?? 0) * 100;
		return Math.max(0, Math.min(100, Math.round(raw)));
	}
	return null;
}

/** Inner content of the precision-label button. Three visual states:
 *  - **downloading** — an animated download glyph + live percentage; the
 *    label is dropped because the badge IS the progress indicator now.
 *  - **idle + not cached** — the precision label, which crossfades to a
 *    download glyph on hover to advertise the click-to-download affordance.
 *    The glyph is overlaid on the label (kept as an opacity-0 width sizer)
 *    so the badge doesn't reflow as the pointer enters/leaves.
 *  - **cached / partial / active** — the bare precision label. */
function QuantBadgeLabel({
	opt,
	isDownloading,
	download,
	canStartDownload,
}: {
	canStartDownload: boolean;
	download: QuantDownloadSnapshot | undefined;
	isDownloading: boolean;
	opt: QuantOption;
}) {
	if (isDownloading) {
		const progress = download?.progress ?? null;
		return (
			<span className="relative inline-flex items-center gap-1.5">
				<HugeiconsIcon className="size-3 animate-pulse" icon={CloudDownloadIcon} />
				<span className="font-mono text-[9.5px] tabular-nums">
					{progress === null ? "…" : `${progress}%`}
				</span>
			</span>
		);
	}
	if (canStartDownload) {
		return (
			<span className="relative inline-flex items-center justify-center">
				<span className="transition-opacity duration-150 group-hover/badge:opacity-0 motion-reduce:transition-none">
					{opt.label}
				</span>
				<HugeiconsIcon
					aria-hidden="true"
					className="absolute inset-0 m-auto size-3 opacity-0 transition-opacity duration-150 group-hover/badge:opacity-100 motion-reduce:transition-none"
					icon={CloudDownloadIcon}
				/>
			</span>
		);
	}
	return <span className="relative inline-flex items-center">{opt.label}</span>;
}

interface QuantOptionButtonProps {
	currentQuantization: OnnxQuantization;
	getDownloadSnapshot:
		| ((modelId: string, quantization: OnnxQuantization) => QuantDownloadSnapshot | undefined)
		| undefined;
	isSelectedModel: boolean;
	model: ModelInfo;
	onDownloadAction:
		| ((action: QuantDownloadAction, modelId: string, quantization: OnnxQuantization) => void)
		| undefined;
	onRequestDeleteQuant:
		| ((
				modelId: string,
				quantization: OnnxQuantization,
				displayName: string,
				quantLabel: string
		  ) => void)
		| undefined;
	onSelect: (modelId: string, quantization: OnnxQuantization) => void;
	opt: QuantOption;
	state: ModelStateEntry | undefined;
}

/** Renders one precision-badge ButtonGroup: the precision label button
 *  followed by 0..2 contextual action buttons (download / pause / resume /
 *  cancel / delete) supplied by {@link QuantActionButtons}.
 *
 *  Per-badge button-group composition:
 *    - Always: the precision label button itself.
 *    - Active download: progress label + Pause/Resume + Cancel.
 *    - Partial, idle: Delete only. Clicking the badge re-selects the
 *      quant which the parent's swap controller turns back into a
 *      resumable download — no explicit Resume affordance needed.
 *    - Cached, idle: Delete.
 *    - Not cached, idle: Download. */
function QuantOptionButton({
	opt,
	model,
	state,
	currentQuantization,
	isSelectedModel,
	onSelect,
	onRequestDeleteQuant,
	getDownloadSnapshot,
	onDownloadAction,
}: QuantOptionButtonProps) {
	const isActive = isSelectedModel && opt.value === currentQuantization;
	// "Auto" (value "") is a selection-only router. It maps to the precision the
	// SERVER will actually load for this device/runtime — ``effective_quantization``
	// (e.g. fp16 on DirectML, int8 on CPU for the int8-preferred families) — NOT
	// the raw fp32 default export. So we reflect THAT precision's cache tone (Auto
	// reads green when selecting it loads instantly) but give Auto NO download
	// chrome of its own: no progress fill, no pause/cancel/delete, and no
	// click-to-fetch. Clicking Auto always selects at "" and lets the swap
	// controller resolve + prompt the right device-appropriate download. Without
	// this, Auto checked the (usually absent) fp32 default, so clicking it either
	// fired a spurious fp32 download ("picks a random quantization") or went inert.
	const isAuto = opt.value === "";
	// ``resolveEffectiveQuant`` returns ``string`` (the server's
	// ``effective_quantization``); every value it can yield is a member of the
	// ``OnnxQuantization`` union (it's sourced from the same catalog quant list),
	// so narrow it back the way ``use-model-swap-controller.resolveTargetQuant``
	// does — keeps the snapshot lookup + action dispatch on the typed quant.
	const effectiveValue = (
		isAuto ? resolveEffectiveQuant(state, opt.value) : opt.value
	) as OnnxQuantization;
	const cache = resolveQuantCache(state, effectiveValue);
	// Look up the live download by the EFFECTIVE precision, not ``opt.value``.
	// The Auto badge is the only surface representing an int8-preferred family's
	// effective download (e.g. cohere has no concrete ``int8`` badge, yet a
	// download started via Auto/row lands under ``model@int8``). Keying off
	// ``effectiveValue`` makes Auto reflect that download's progress + controls
	// instead of silently showing nothing. For a concrete badge ``effectiveValue``
	// equals ``opt.value``, so this is a no-op there.
	const download = getDownloadSnapshot?.(model.id, effectiveValue);
	const isDownloading = download !== undefined;
	const isOnDisk = cache?.state === "cached" || cache?.state === "partial";
	const cacheToneClass = badgeToneForCache(cache?.state);
	const progressFillPct = resolveProgressFillPct(cache, download);
	// A not-cached, idle concrete badge IS the download button: clicking it kicks
	// off a background predownload (no swap) rather than selecting. Cached/partial
	// badges keep their select-to-swap behaviour (partial resumes via the swap
	// controller on select). Auto is never a download button — it routes through
	// select. Falls back to select if the consumer wired no download dispatcher.
	const canStartDownload = !(isAuto || isDownloading || isOnDisk) && onDownloadAction !== undefined;
	// With the inline Download button gone, a not-cached idle badge has no
	// trailing controls — round both ends so it doesn't show a square right
	// edge inside the group ring. (Downloading → pause/cancel; on-disk → trash.)
	const canDelete = !isAuto && onRequestDeleteQuant !== undefined && isOnDisk;
	const hasTrailingActions =
		(isDownloading && onDownloadAction !== undefined) || (canDelete && !isDownloading);
	const statusHint = canStartDownload ? " Click to download." : "";
	let badgeAriaLabel = `Select ${opt.label} precision`;
	if (canStartDownload) {
		badgeAriaLabel = `Download ${opt.label} weights`;
	} else if (isDownloading) {
		badgeAriaLabel = `${opt.label} downloading`;
	}
	return (
		<ButtonGroup
			aria-label={`Precision ${opt.label} for ${model.displayName}`}
			className="rounded-md ring-1 ring-border ring-inset"
		>
			<Tooltip
				content={`${opt.label} — ${quantCacheStatus(cache)}.${statusHint} ${opt.tooltip}`}
				side="top"
			>
				<button
					aria-disabled={isDownloading}
					aria-label={badgeAriaLabel}
					className={cn(
						"group/badge relative inline-flex h-6 items-center gap-1.5 overflow-hidden px-2 font-medium text-[10.5px] leading-none transition-colors",
						isDownloading ? "cursor-default" : "cursor-pointer",
						hasTrailingActions ? "rounded-l-[5px]" : "rounded-[5px]",
						isActive ? "bg-accent/20 text-accent" : cacheToneClass
					)}
					onClick={(e) => {
						e.preventDefault();
						e.stopPropagation();
						// While this precision is downloading, the badge body is inert
						// for selection — switching to a not-yet-downloaded precision
						// would just fail / re-fetch. The trailing pause/cancel
						// controls (QuantActionButtons) own the in-flight download.
						if (isDownloading) {
							return;
						}
						if (canStartDownload) {
							onDownloadAction?.("start", model.id, opt.value);
						} else {
							onSelect(model.id, opt.value);
						}
					}}
					type="button"
				>
					{progressFillPct !== null && !isActive ? (
						<span
							aria-hidden="true"
							className="pointer-events-none absolute inset-y-0 left-0 bg-amber-500/20 transition-[width] duration-200 ease-out motion-reduce:transition-none"
							style={{ width: `${progressFillPct}%` }}
						/>
					) : null}
					<QuantBadgeLabel
						canStartDownload={canStartDownload}
						download={download}
						isDownloading={isDownloading}
						opt={opt}
					/>
				</button>
			</Tooltip>
			{/* Auto still renders its download controls (pause/resume/cancel) when
			    its EFFECTIVE precision is downloading — for int8-preferred families
			    Auto is the only badge representing that download. Delete stays off
			    Auto (the "Auto" label would read wrong on a delete confirm; the
			    concrete badge or the dialog's Discard owns deletion). */}
			<QuantActionButtons
				actionQuant={effectiveValue}
				cache={cache}
				download={download}
				model={model}
				onDownloadAction={onDownloadAction}
				onRequestDeleteQuant={isAuto ? undefined : onRequestDeleteQuant}
				opt={opt}
			/>
		</ButtonGroup>
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
			{options.map((opt) => (
				<QuantOptionButton
					currentQuantization={currentQuantization}
					getDownloadSnapshot={getDownloadSnapshot}
					isSelectedModel={isSelectedModel}
					key={opt.value || "default"}
					model={model}
					onDownloadAction={onDownloadAction}
					onRequestDeleteQuant={onRequestDeleteQuant}
					onSelect={onSelect}
					opt={opt}
					state={state}
				/>
			))}
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
