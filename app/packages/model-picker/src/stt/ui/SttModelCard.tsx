"use client";

import { Combobox } from "@base-ui/react/combobox";
import {
	AlertCircleIcon,
	BinaryCodeIcon,
	CancelCircleIcon,
	CheckmarkCircle02Icon,
	CloudDownloadIcon,
	DashboardSpeed02Icon,
	Delete02Icon,
	GlobeIcon,
	HardDriveDownloadIcon,
	NeuralNetworkIcon,
	PauseIcon,
	PlayIcon,
	StarIcon,
	Target02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import type { ModelInfo } from "@/entities/model-catalog";
import type { ModelCacheInfo, ModelStateEntry, SystemInfoEntry } from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";
import { cn } from "@/shared/lib/cn";
import { formatBytes } from "@/shared/lib/format-bytes";
import { ButtonGroup } from "@/shared/ui/button-group";
import { Tooltip } from "@/shared/ui/tooltip";
import { resolveEffectiveQuant, resolveQuantCache } from "../lib/cache-helpers";
import { variantDisplayName } from "../lib/family-helpers";
import { isUncomfortable } from "../lib/hardware-fit";
import { formatLanguages } from "../lib/language-names";
import { quantCacheStatus } from "../lib/pill-helpers";
import { getQuantizationOptions } from "../lib/quantization-helpers";
import { variantMeta } from "../lib/variant-helpers";

/** One discrete fact in the card's metadata line (params / download size /
 *  language / hardware-fit warning). */
interface MetaEntry {
	/** Tone override — only the hardware-fit warning sets this (to `text-error`). */
	className?: string;
	icon: IconSvgElement;
	key: string;
	tooltip: string;
	value: string;
}

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

/** A single fact in the metadata line: a dim leading glyph + value, full detail
 *  in the tooltip. The hardware-fit warning colours itself via `className`. */
function MetaItem({
	className,
	icon,
	value,
	tooltip,
}: {
	className?: string | undefined;
	icon: IconSvgElement;
	tooltip: string;
	value: string;
}) {
	return (
		<Tooltip content={tooltip} side="top">
			<span className={cn("inline-flex shrink-0 items-center gap-1 tabular-nums", className)}>
				<HugeiconsIcon className="size-3 opacity-70" icon={icon} />
				{value}
			</span>
		</Tooltip>
	);
}

/**
 * The metadata line under the model name. Facts are middot-separated so the row
 * reads as one calm, scannable strip — params, size, language at a glance —
 * instead of a cluster of competing badges. Subordinate to the name by size
 * (11px) and tone (muted), so it never fights the title for attention.
 */
function CardMetaRow({ entries }: { entries: MetaEntry[] }) {
	const nodes: ReactNode[] = [];
	for (const [i, entry] of entries.entries()) {
		if (i > 0) {
			nodes.push(
				<span aria-hidden="true" className="text-foreground-dim/40" key={`sep-${entry.key}`}>
					·
				</span>
			);
		}
		nodes.push(
			<MetaItem
				className={entry.className}
				icon={entry.icon}
				key={entry.key}
				tooltip={entry.tooltip}
				value={entry.value}
			/>
		);
	}
	return (
		<div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-foreground-muted leading-tight">
			{nodes}
		</div>
	);
}

interface PerfBarsProps {
	accuracyScore: number;
	speedScore: number;
}

/**
 * Map a 0..1 score to a MUTED health-bar colour — soft rose (worst) → soft
 * amber (mid) → soft sage (best). Each channel is pulled toward a mid-grey so
 * the bars read as gently-tinted signals inside the otherwise-grayscale card
 * rather than a neon rainbow. Higher is better for both metrics, so a
 * fast-but-sloppy model shows a sage speed bar over a rose accuracy bar at a
 * glance.
 */
function scoreColor(score: number): string {
	const t = Math.max(0, Math.min(1, score));
	const mix = (a: number, b: number, k: number): number => Math.round(a + (b - a) * k);
	if (t < 0.5) {
		// rose (188,108,108) → amber (190,162,104)
		const k = t * 2;
		return `rgb(${mix(188, 190, k)}, ${mix(108, 162, k)}, ${mix(108, 104, k)})`;
	}
	// amber (190,162,104) → sage (120,176,138)
	const k = (t - 0.5) * 2;
	return `rgb(${mix(190, 120, k)}, ${mix(162, 176, k)}, ${mix(104, 138, k)})`;
}

interface PerfBarProps {
	icon: IconSvgElement;
	label: string;
	score: number;
}

/**
 * One read-only metric as a compact horizontal module: a dim metaphor glyph
 * (target = accuracy, gauge = speed), a muted-coloured fill bar, and the
 * percentage echoed in the bar's own colour. Reads on its own without a text
 * label, and uses horizontal space instead of stacking another full-width row.
 */
function PerfBar({ icon, label, score }: PerfBarProps) {
	const pct = Math.round(score * 100);
	const color = scoreColor(score);
	return (
		<Tooltip content={`${label} ${pct}%`} side="top">
			<div aria-label={`${label} ${pct}%`} className="flex items-center gap-1.5" role="img">
				<HugeiconsIcon
					aria-hidden="true"
					className="size-3 shrink-0 text-foreground-dim"
					icon={icon}
				/>
				<div className="relative h-1 w-14 overflow-hidden rounded-full bg-foreground/[0.08]">
					<span
						aria-hidden="true"
						className="absolute inset-y-0 left-0 rounded-full"
						style={{ width: `${pct}%`, backgroundColor: color }}
					/>
				</div>
				<span
					className="w-8 shrink-0 text-end font-semibold text-[10px] tabular-nums"
					style={{ color }}
				>
					{pct}%
				</span>
			</div>
		</Tooltip>
	);
}

/**
 * The speed + accuracy module pinned to the card's top-right. Hidden when the
 * catalog reports the unknown-default 0.5/0.5 — two half-full bars on every
 * variant would just teach the user to ignore them.
 */
function PerfBars({ speedScore, accuracyScore }: PerfBarsProps) {
	const hasSignal = speedScore !== 0.5 || accuracyScore !== 0.5;
	if (!hasSignal) {
		return null;
	}
	return (
		<div className="flex shrink-0 flex-col gap-1">
			<PerfBar icon={Target02Icon} label="Accuracy" score={accuracyScore} />
			<PerfBar icon={DashboardSpeed02Icon} label="Speed" score={speedScore} />
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

/**
 * Star toggle pinned to the card's right edge. Clicking it stars / unstars the
 * model, which adds / removes it from the synthetic "Favorites" group at the
 * top of the list. Mirrors the rail's favorite-star vocabulary (amber, filled
 * when active) so the two affordances read as the same gesture.
 *
 * ``preventDefault`` + ``stopPropagation`` keep the click from bubbling to the
 * enclosing ``Combobox.Item`` (which would otherwise select the model) — the
 * same guard {@link ExpandTrigger} and the per-badge buttons use.
 */
function FavoriteToggle({
	displayName,
	isFavorited,
	modelId,
	onToggle,
}: {
	displayName: string;
	isFavorited: boolean;
	modelId: string;
	onToggle: (modelId: string) => void;
}) {
	return (
		<Tooltip content={isFavorited ? "Remove from Favorites" : "Add to Favorites"} side="top">
			<button
				aria-label={
					isFavorited ? `Remove ${displayName} from favorites` : `Add ${displayName} to favorites`
				}
				aria-pressed={isFavorited}
				className={cn(
					"inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors",
					"motion-reduce:transition-none",
					isFavorited
						? "text-amber-400 hover:bg-amber-400/15"
						: "text-foreground-muted opacity-55 hover:bg-foreground/[0.08] hover:text-foreground hover:opacity-100"
				)}
				onClick={(e) => {
					e.preventDefault();
					e.stopPropagation();
					onToggle(modelId);
				}}
				type="button"
			>
				<HugeiconsIcon
					className={cn("size-3.5", isFavorited && "fill-amber-400")}
					icon={StarIcon}
				/>
			</button>
		</Tooltip>
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

// The list used to read as a "swimming pool" — identical translucent rows
// melting into the popup and into each other. Each card is now a solid,
// elevated *specimen*: a real surface step (surface-3 over the surface-2
// popup) with a tinted depth shadow, so it reads as a discrete object. Hover
// lifts it 1px and deepens the shadow; press settles it back with a subtle
// scale (12-principles: transform/opacity only, ease-out ≤150ms, motion-reduce
// guarded). The header/precision divider lives in the JSX below.
const CARD_BASE = cn(
	"relative mx-2 my-1.5 flex cursor-pointer flex-col gap-2.5 overflow-hidden rounded-lg px-3.5 py-3 outline-none",
	"border border-border bg-surface-3 shadow-surface-2",
	"transition-[transform,border-color,background-color,box-shadow] duration-150 ease-out",
	"hover:-translate-y-px hover:border-border-hover hover:bg-surface-4 hover:shadow-surface-3",
	"active:translate-y-0 active:scale-[0.99]",
	"data-[highlighted]:border-border-hover data-[highlighted]:bg-surface-4 data-[highlighted]:shadow-surface-3",
	"motion-reduce:transition-none motion-reduce:active:scale-100 motion-reduce:hover:translate-y-0"
);
/** Active selection: the fill warms to a Docker-blue tint and gains a ring.
 *  Hover/highlight keep the accent rather than falling back to the neutral
 *  surface-4 of {@link CARD_BASE}. */
const CARD_SELECTED = cn(
	"border-accent/55 bg-accent/[0.09] shadow-surface-3 ring-1 ring-accent/25",
	"hover:border-accent/70 hover:bg-accent/[0.12]",
	"data-[highlighted]:border-accent/70 data-[highlighted]:bg-accent/[0.12]"
);
/** Softer variant: the primary's bundle owns the selected variant but the
 *  primary itself isn't the active id. Lighter than ``CARD_SELECTED`` so the
 *  actually-selected sibling still wins the eye. */
const CARD_SELECTED_VARIANT = cn(
	"border-accent/30 bg-accent/[0.05]",
	"hover:border-accent/45 hover:bg-accent/[0.08]",
	"data-[highlighted]:border-accent/45 data-[highlighted]:bg-accent/[0.08]"
);
/** Bundle siblings (revealed under the chevron) recess to surface-2 so they
 *  read as tucked *under* their surface-3 primary — depth reinforces the
 *  indent rail instead of competing with it. */
const CARD_NESTED = cn(
	"bg-surface-2 shadow-surface-1",
	"hover:bg-surface-3",
	"data-[highlighted]:bg-surface-3"
);

/** Class fragment that desaturates a broken custom-model card and parks the
 *  hover-lift (a non-selectable card shouldn't feel tactile) without changing
 *  the dimensions — keeps the picker layout stable while making the
 *  unavailable state obvious. */
const CARD_UNAVAILABLE = cn(
	"cursor-not-allowed opacity-55",
	"hover:-translate-y-0 hover:border-border hover:bg-surface-3 hover:shadow-surface-2"
);

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
	const isIndirectlySelected = !isSelected && hasSelectedVariant;
	const isUnavailable = model.available === false;
	const bytes = formatBytes(state?.estimated_bytes ?? 0);
	const metaEntries = buildMetaEntries(model, bytes, state, systemInfo);
	// Broken custom drops surface the scanner's error verbatim — much more
	// useful than a generic "couldn't load" toast. The label itself is
	// already shown; the tooltip explains *why* the card is greyed out.
	const title =
		isUnavailable && model.errorMessage ? `Unavailable: ${model.errorMessage}` : undefined;
	return (
		<Combobox.Item
			className={cn(
				CARD_BASE,
				nested && CARD_NESTED,
				isSelected && CARD_SELECTED,
				isIndirectlySelected && CARD_SELECTED_VARIANT,
				isUnavailable && CARD_UNAVAILABLE
			)}
			data-model-id={model.id}
			disabled={isUnavailable}
			title={title}
			value={model}
		>
			<div className="flex items-start justify-between gap-3">
				{/* Identity column — the name owns the top line at full body size;
				    the spec strip sits quietly beneath it. The two-line stack is
				    what gives the title room to breathe instead of sharing one row
				    with a cluster of metadata badges. */}
				<div className="flex min-w-0 flex-1 flex-col gap-1.5">
					<div className="flex min-w-0 items-center gap-1.5">
						{/* Combobox.ItemIndicator renders only when the Item's value
						    matches the root's selected value (resolved via
						    isItemEqualToValue) — no manual `isSelected` guard
						    needed, and it automatically picks up the canonical
						    `data-selected` state Base UI maintains. */}
						<Combobox.ItemIndicator className="flex shrink-0 items-center">
							<HugeiconsIcon className="size-4 text-accent" icon={CheckmarkCircle02Icon} />
						</Combobox.ItemIndicator>
						<span className="min-w-0 truncate font-semibold text-body text-foreground leading-tight">
							{variantDisplayName(model, siblings)}
						</span>
						{isUnavailable ? (
							<Tooltip content={model.errorMessage || "Unavailable"} side="top">
								<span className="inline-flex shrink-0 items-center gap-1 rounded bg-error/15 px-1.5 py-0.5 font-medium text-[10px] text-error">
									<HugeiconsIcon className="size-3" icon={AlertCircleIcon} />
									Broken
								</span>
							</Tooltip>
						) : null}
					</div>
					{isUnavailable ? null : <CardMetaRow entries={metaEntries} />}
					{isUnavailable && model.errorMessage ? (
						<span className="truncate text-[11px] text-foreground-dim leading-tight">
							{model.errorMessage}
						</span>
					) : null}
				</div>
				{/* Perf + actions module, pinned top-right and aligned to the name
				    line. Perf bars use horizontal space so the card stays two
				    logical rows tall. */}
				<div className="flex shrink-0 items-start gap-3">
					{isUnavailable ? null : (
						<PerfBars accuracyScore={model.accuracyScore} speedScore={model.speedScore} />
					)}
					<div className="flex items-center gap-0.5">
						{actions}
						{/* Favorite star — hidden on broken custom drops (you can't
						    star a model you can't load) and when the consumer wires
						    no toggle handler. */}
						{onToggleFavorite && !isUnavailable ? (
							<FavoriteToggle
								displayName={model.displayName}
								isFavorited={isFavorite?.(model.id) ?? false}
								modelId={model.id}
								onToggle={onToggleFavorite}
							/>
						) : null}
					</div>
				</div>
			</div>
			{isUnavailable ? null : (
				// Recessed "how to get it" shelf. The precision / download controls
				// drop onto their own subtly-darkened ledge that bleeds to the card's
				// bottom + side edges, split from the identity header by a full-bleed
				// hairline. Two clearly-organized zones — "what it is" vs "how to get
				// it" — without adding extra chrome.
				<div className="-mx-3.5 -mb-3 border-divider border-t bg-foreground/[0.02] px-3.5 pt-2.5 pb-3">
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
				</div>
			)}
		</Combobox.Item>
	);
}
