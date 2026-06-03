"use client";

import { Combobox } from "@base-ui/react/combobox";
import {
	AlertCircleIcon,
	ArrowDown01Icon,
	ArrowUpDownIcon,
	Atom01Icon,
	BinaryCodeIcon,
	Brain01Icon,
	CancelCircleIcon,
	CloudDownloadIcon,
	Delete02Icon,
	HardDriveIcon,
	PauseIcon,
	PlayIcon,
	StarIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import FuseConstructor, { type default as Fuse, type IFuseOptions } from "fuse.js";
import { type ComponentPropsWithoutRef, type ReactNode, useEffect, useRef, useState } from "react";
import type { SystemInfoEntry } from "@/shared/api/ipc-client";
import type {
	OllamaLibraryHit,
	OllamaLibraryTag,
	OllamaModel,
	OllamaPullProgress,
	RecommendedOllamaModel,
} from "@/shared/api/models";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { ButtonGroup } from "@/shared/ui/button-group";
import { DownloadActions, type DownloadPhase, DownloadProgressBar } from "@/shared/ui/download";
import { PulseDot } from "@/shared/ui/pulse-dot";
import {
	buildSwitchingClassName,
	SwapSweepBar,
	SwitchingFromToRow,
	SwitchingPill,
} from "@/shared/ui/switching-trigger";
import { Tooltip as ContentTooltip } from "@/shared/ui/tooltip";
import {
	buildFavoritesRailItem,
	GroupRail,
	type GroupRailItem,
	RailIconChip,
} from "../../core/GroupRail";
import { FAVORITES_GROUP_VALUE } from "../../core/favorites";
import { ModelPicker } from "../../core/ModelPicker";
import {
	BadgeIconButton,
	badgeToneForCache,
	GroupHeader,
	type MetaEntry,
	ModelCard,
	NeutralHeaderIcon,
	QuantBadgeLabel,
} from "../../core/model-card";
import { useFavoriteSet } from "../../core/use-favorite-set";
import { useRailScrollSpy } from "../../core/use-rail-scroll-spy";
import { extractCloseReason } from "../../lib/combobox-reasons";
import {
	applyCloseWith,
	isInsideMenuPopup,
} from "../../lib/openrouter-model-selector-test-helpers";
import { getProviderIconWithFallback, resolveProviderIcon } from "../../lib/provider-icons";
import { useModelSelectorClickTracking } from "../../lib/use-model-selector-click-tracking";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/Tooltip";
import { TruncatedText } from "../../ui/TruncatedText";
import {
	formatOllamaDisplayName,
	formatOllamaSize,
	getOllamaFamily,
	getOllamaPublisher,
	getOllamaPublisherBySlug,
} from "../lib/family-helpers";
import {
	isSameOllamaTag,
	isTagInstalled,
	libraryBaseSlug,
	paramSizeFromName,
	pruneToShownQuants,
	type QuantBadgeCacheState,
	quantBadgeCacheState,
	quantBadgeLabel,
	tagsForParamSize,
} from "../lib/quant-shelf-helpers";
import {
	OLLAMA_SORT_HEADER_LABEL,
	type OllamaSortKey,
	type OllamaSortValue,
	sortOllamaModels,
} from "../lib/sort-state";
import { useFavoriteOllamaModels } from "../lib/use-favorite-ollama-models";
import { OllamaSortMenu } from "./OllamaSortMenu";

interface PausedPullState {
	pausedAt: number;
	progress: OllamaPullProgress;
}

/** Shape of a single recommended-model fit assessment used to render the
 *  "won't fit" warning chip next to oversized recommendations. Mirrors
 *  {@link import("@/entities/llm-catalog").OllamaFitAssessment} but without
 *  pulling the entities package into the picker. */
interface OllamaFitInfo {
	availableBytes: number;
	fits: boolean;
	requiredBytes: number;
	shortfall: "vram" | "ram" | "unknown" | undefined;
}

/** State surfaced by the library scraper — passed in so the picker stays
 *  presentational while the renderer-side store drives fetching. */
interface OllamaLibrarySearchProps {
	/** Full library catalog (entire `ollama.com/library` listing). The picker
	 *  filters this client-side against the search query and groups it by
	 *  publisher into per-maker sections. */
	catalog: readonly OllamaLibraryHit[];
	/** Scraper failure reason — surfaces inline in the Library area. */
	error?: string | null;
	/** Trigger a per-model tag scrape. Idempotent once cached. */
	fetchTags: (model: string) => void;
	isLoaded: boolean;
	isLoading: boolean;
	/** Pull the catalog from main process. Idempotent. */
	loadCatalog: () => void;
	/** Per-model tag-fetch state keyed by lower-cased model slug. */
	tagsByModel: Readonly<
		Record<
			string,
			{
				error?: string | null;
				isLoading: boolean;
				tags: readonly OllamaLibraryTag[];
			}
		>
	>;
}

export interface OllamaModelSelectorProps {
	disabled?: boolean | undefined;
	/** Render the list as an always-open inline panel (no popup) — used to host
	 *  the picker in a dedicated surface and by render tests. */
	inline?: boolean | undefined;
	isLoading?: boolean | undefined;
	/** When provided, the popup grows a third "Library" section that lists
	 *  scraped ollama.com search results with paginated pull actions. */
	librarySearch?: OllamaLibrarySearchProps | undefined;
	models: readonly OllamaModel[];
	onChange: (modelName: string) => void;
	/** Delete an installed model. Omit to hide the delete button. */
	onDelete?: ((modelName: string) => void) | undefined;
	/** Forget a paused pull (doesn't touch disk). Omit to hide the recommended UI. */
	onDiscardPull?: ((modelName: string) => void) | undefined;
	/** Called when the dropdown opens — used to refresh the catalog. */
	onOpen?: (() => void) | undefined;
	/** Start (or restart) a pull. Omit to hide the recommended UI. */
	onPull?: ((modelName: string) => void) | undefined;
	/** Resume a previously-paused pull. Omit to hide the recommended UI. */
	onResumePull?: ((modelName: string) => void) | undefined;
	/** Stop an active pull (becomes a paused pull). Omit to hide the recommended UI. */
	onStopPull?: ((modelName: string) => void) | undefined;
	pausedPulls?: Readonly<Record<string, PausedPullState>> | undefined;
	placeholder?: string | undefined;
	/** Active pulls keyed by model name. Omit to hide the recommended UI. */
	pulls?: Readonly<Record<string, OllamaPullProgress>> | undefined;
	/** Curated list of suggested models. When supplied alongside pull
	 *  callbacks, the popup grows a "Recommended" section with inline
	 *  install actions; omitting it falls back to installed-only mode. */
	recommendedModels?: readonly RecommendedOllamaModel[] | undefined;
	/** In-flight model swap (caller-driven; the picker has no IPC subscription
	 *  for Ollama swaps the way the STT picker does). When set, the trigger
	 *  renders the same `from → ◌ → to` view + accent sweep used by the STT
	 *  selector. `fromName` is the previously-loaded model id; `toName` the
	 *  one the user just picked. Both are resolved against `models` to render
	 *  publisher chips. Omit (or pass `null`) when no swap is in flight. */
	swap?: { fromName?: string | null | undefined; toName: string } | null | undefined;
	/** Optional fit-assessment lookup. Called per recommended model to
	 *  render a "Won't fit" badge when the host system can't run it. */
	systemFit?: ((sizeBytes: number) => OllamaFitInfo) | undefined;
	/** Optional system info — currently only used to decide whether to call
	 *  `systemFit`; if the caller supplies neither, the badge is suppressed. */
	systemInfo?: SystemInfoEntry | null | undefined;
	value: string;
}

const DEFAULT_PLACEHOLDER = "Select a model";
const OLLAMA_LIBRARY_URL = "https://ollama.com/library";
const VALID_MODEL_NAME_RE = /^[a-zA-Z0-9._:/-]+$/;
// Shared synthetic-group value so the Favorites rail tile, the group header's
// `data-rail-section`, and the click-to-jump all use the same id across pickers.
const FAVORITES_RAIL_ID = FAVORITES_GROUP_VALUE;
const SORTED_RAIL_ID = "__sorted__";
const LEADING_LETTERS_RE = /^[a-zA-Z]+/;

/** Pull the leading alphabetic chunk off an Ollama slug — `gemma3n` → `gemma`. */
function familySlugFromName(name: string): string {
	return (LEADING_LETTERS_RE.exec(name)?.[0] ?? "").toLowerCase();
}

// ── Shared chips (used by trigger + row) ──────────────────────────────

/** The small publisher logo rendered before a model name inside the shared
 *  {@link ModelCard} (installed / recommended / library rows) so every Ollama
 *  card carries its maker mark, mirroring the OpenRouter picker. Falls back to a
 *  gray initials chip when the publisher has no logo. */
function OllamaMakerIcon({ slug }: { slug: string }) {
	const icon = resolveProviderIcon(slug);
	if (icon) {
		return (
			<img
				alt=""
				className="size-4 shrink-0 rounded-[3px] object-cover"
				height={16}
				src={icon}
				width={16}
			/>
		);
	}
	// No bundled logo → neutral initials chip (never the misleading OpenRouter "O").
	return (
		<span className="flex size-4 shrink-0 items-center justify-center rounded-[3px] bg-foreground/[0.08] font-semibold text-[9px] text-foreground-muted uppercase">
			{getOllamaPublisherBySlug(slug).label.charAt(0) || "?"}
		</span>
	);
}

function PublisherChip({ family }: { family: string }) {
	const publisher = getOllamaPublisher(family);
	const iconSrc = getProviderIconWithFallback(publisher.slug);
	return (
		<span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-surface-secondary/60 px-1.5 py-0.5 font-medium text-[10px] text-foreground-secondary leading-none">
			<img
				alt=""
				className="size-3 rounded-[2px] object-cover"
				height={12}
				src={iconSrc}
				width={12}
			/>
			{publisher.label}
		</span>
	);
}

/**
 * Reasoning-capability marker. Renders when the model's `capabilities`
 * array (fetched from Ollama's `/api/show`) advertises `thinking`. Rendered
 * as a quiet neutral capability pill (matching the Library capability chips)
 * — in the fluidfunctionalism palette the icon shape carries the meaning, so
 * the chip stays fully grayscale rather than glowing purple.
 */
function ThinkingChip({ capabilities }: { capabilities: readonly string[] | undefined }) {
	if (!capabilities?.includes("thinking")) {
		return null;
	}
	return (
		<Tooltip>
			<TooltipTrigger
				render={(props) => (
					<span
						{...(props as ComponentPropsWithoutRef<"span">)}
						className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/60 px-1.5 py-px font-medium text-[9.5px] text-foreground-muted leading-none"
					>
						<HugeiconsIcon className="size-2.5" icon={Brain01Icon} />
						Reasoning
					</span>
				)}
			/>
			<TooltipContent>
				Supports thinking output. The model can show its step-by-step reasoning before producing the
				final answer.
			</TooltipContent>
		</Tooltip>
	);
}

function WontFitChip({ fit }: { fit: OllamaFitInfo | undefined }) {
	if (!fit || fit.fits) {
		return null;
	}
	const tooltip =
		fit.shortfall === "vram"
			? `Needs ~${formatOllamaSize(fit.requiredBytes)} of VRAM — only ${formatOllamaSize(fit.availableBytes)} available`
			: `Needs ~${formatOllamaSize(fit.requiredBytes)} of RAM — only ${formatOllamaSize(fit.availableBytes)} available`;
	return (
		<Tooltip>
			<TooltipTrigger
				render={(props) => (
					<span
						{...(props as ComponentPropsWithoutRef<"span">)}
						className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-md bg-error/10 px-1.5 font-medium text-[10px] text-error leading-none ring-1 ring-error/30 ring-inset"
					>
						<HugeiconsIcon className="size-2.5" icon={AlertCircleIcon} />
						Won't fit
					</span>
				)}
			/>
			<TooltipContent side="top">{tooltip}</TooltipContent>
		</Tooltip>
	);
}

/** The amber "Recommended" star badge shown on a curated model's card now that
 *  recommended models live inside their maker group rather than a separate
 *  maker-less "Recommended" section. */
function RecommendedStar() {
	return (
		<ContentTooltip content="Recommended for dictation post-processing" side="top">
			<span className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-md bg-amber-400/[0.12] px-1.5 font-medium text-[10px] text-amber-400 leading-none">
				<HugeiconsIcon className="size-2.5 fill-amber-400" icon={StarIcon} />
				Recommended
			</span>
		</ContentTooltip>
	);
}

// ── Quantization precision shelf ──────────────────────────────────────
//
// The Ollama analogue of the STT picker's precision shelf
// (`stt/ui/SttModelCard.tsx` → PrecisionGroup): a recessed strip of quant
// BADGES with click-to-download folded into each badge. ONE badge per library
// tag matching the card's parameter size. Each badge's on-disk state drives its
// behaviour, mirroring the STT `QuantOptionButton`:
//   - installed  → muted-emerald, click selects the model, trailing trash deletes
//   - active pull → progress fill + pause/resume + cancel; body inert
//   - paused      → muted-amber, resume
//   - not on disk → neutral; the badge IS the download button (hover → glyph)
// The shelf reuses the EXACT muted tones + ButtonGroup composition as STT so the
// two pickers read identically. (No speed/accuracy perf bars — out of scope.)

// The badge tone palette + the per-control icon button are the SHARED quant-shelf
// leaves (`core/model-card` → badgeToneForCache / BadgeIconButton): one definition
// across the STT, TTS, and Ollama shelves. Ollama keeps only its tag/pull-specific
// composition below.

interface QuantBadgeState {
	cacheState: QuantBadgeCacheState;
	/** A pull is flowing for this tag right now. */
	isDownloading: boolean;
	/** Pull percent [0..100] for the progress fill (active OR paused), or null. */
	progressPercent: number | null;
}

function deriveQuantBadgeState(
	pull: OllamaPullProgress | undefined,
	paused: PausedPullState | undefined,
	installed: boolean
): QuantBadgeState {
	const isDownloading = pull !== undefined;
	const cacheState = quantBadgeCacheState({ installed, paused: paused !== undefined });
	let progressPercent: number | null = null;
	if (pull) {
		progressPercent = Math.max(0, Math.min(100, Math.round(pull.percent ?? 0)));
	} else if (paused) {
		progressPercent = Math.max(0, Math.min(100, Math.round(paused.progress.percent ?? 0)));
	}
	return { cacheState, isDownloading, progressPercent };
}

/** The 0..2 trailing pull controls appended to a quant badge in the same
 *  ButtonGroup — Pause/Resume + Cancel while pulling, Delete when on disk.
 *  Extracted so each branch stays in its own scope (cognitive-complexity cap),
 *  mirroring the STT shelf's `QuantActionButtons`. */
function QuantBadgeActions({
	tagName,
	label,
	state,
	canDelete,
	onResume,
	onStop,
	onDiscard,
}: {
	canDelete: boolean;
	label: string;
	onDiscard: (name: string) => void;
	onResume: (name: string) => void;
	onStop: (name: string) => void;
	state: QuantBadgeState;
	tagName: string;
}) {
	const isPaused = state.cacheState === "partial" && !state.isDownloading;
	return (
		<>
			{state.isDownloading ? (
				<BadgeIconButton
					ariaLabel={`Pause ${label} download`}
					icon={PauseIcon}
					onClick={() => onStop(tagName)}
					tooltip="Pause download"
				/>
			) : null}
			{isPaused ? (
				<BadgeIconButton
					ariaLabel={`Resume ${label} download`}
					icon={PlayIcon}
					onClick={() => onResume(tagName)}
					tone="primary"
					tooltip="Resume download"
				/>
			) : null}
			{state.isDownloading || isPaused ? (
				<BadgeIconButton
					ariaLabel={`Cancel ${label} download`}
					icon={CancelCircleIcon}
					onClick={() => onDiscard(tagName)}
					tone="danger"
					tooltip="Cancel download"
				/>
			) : null}
			{canDelete ? (
				<BadgeIconButton
					ariaLabel={`Delete ${label}`}
					icon={Delete02Icon}
					onClick={() => onDiscard(tagName)}
					tone="danger"
					tooltip="Delete installed weights"
				/>
			) : null}
		</>
	);
}

interface OllamaQuantBadgeProps {
	fit: OllamaFitInfo | undefined;
	installed: boolean;
	onDiscard: (name: string) => void;
	onPull: (name: string) => void;
	onResume: (name: string) => void;
	onSelect: (name: string) => void;
	onStop: (name: string) => void;
	paused: PausedPullState | undefined;
	pull: OllamaPullProgress | undefined;
	selected: boolean;
	tag: OllamaLibraryTag;
}

/** One quant-badge ButtonGroup: the quant-label button + 0..2 contextual pull
 *  controls. Direct analogue of the STT shelf's `QuantOptionButton`. */
function OllamaQuantBadge({
	tag,
	fit,
	installed,
	selected,
	pull,
	paused,
	onSelect,
	onPull,
	onStop,
	onResume,
	onDiscard,
}: OllamaQuantBadgeProps) {
	const label = quantBadgeLabel(tag);
	const state = deriveQuantBadgeState(pull, paused, installed);
	const isActive = selected && installed;
	// A not-installed, idle badge IS the download button: click → onPull. Installed
	// badges select the model. While pulling the body is inert (controls own it).
	const canStartDownload = !(state.isDownloading || installed || state.cacheState === "partial");
	const canDelete = installed && !state.isDownloading;
	const hasTrailing = state.isDownloading || state.cacheState === "partial" || canDelete;
	const tooltip = buildQuantBadgeTooltip(tag, label, state, canStartDownload, fit);
	let ariaLabel = `Select ${label}`;
	if (canStartDownload) {
		ariaLabel = `Download ${label}`;
	} else if (state.isDownloading) {
		ariaLabel = `${label} downloading`;
	}
	return (
		<ButtonGroup
			aria-label={`Quantization ${label} for ${formatOllamaDisplayName(tag.name)}`}
			className="rounded-md ring-1 ring-border ring-inset"
		>
			<ContentTooltip content={tooltip} side="top">
				<button
					aria-disabled={state.isDownloading}
					aria-label={ariaLabel}
					className={cn(
						"group/badge relative inline-flex h-6 items-center gap-1.5 overflow-hidden px-2 font-medium text-[10.5px] leading-none transition-colors",
						state.isDownloading ? "cursor-default" : "cursor-pointer",
						hasTrailing ? "rounded-l-[5px]" : "rounded-[5px]",
						isActive ? "bg-accent/20 text-accent" : badgeToneForCache(state.cacheState)
					)}
					onClick={(e) => {
						e.preventDefault();
						e.stopPropagation();
						if (state.isDownloading) {
							return;
						}
						if (canStartDownload) {
							onPull(tag.name);
						} else if (state.cacheState === "partial") {
							onResume(tag.name);
						} else {
							onSelect(tag.name);
						}
					}}
					type="button"
				>
					{state.progressPercent !== null && !isActive ? (
						<span
							aria-hidden="true"
							className="pointer-events-none absolute inset-y-0 left-0 bg-amber-500/20 transition-[width] duration-200 ease-out motion-reduce:transition-none"
							style={{ width: `${state.progressPercent}%` }}
						/>
					) : null}
					<QuantBadgeLabel
						canStartDownload={canStartDownload}
						isDownloading={state.isDownloading}
						label={label}
						mono
						progress={state.progressPercent}
					/>
				</button>
			</ContentTooltip>
			<QuantBadgeActions
				canDelete={canDelete}
				label={label}
				onDiscard={onDiscard}
				onResume={onResume}
				onStop={onStop}
				state={state}
				tagName={tag.name}
			/>
		</ButtonGroup>
	);
}

/** Tooltip copy for a quant badge — quant marker + on-disk status + size +
 *  "won't fit" warning, so the badge is self-describing on hover. */
function buildQuantBadgeTooltip(
	tag: OllamaLibraryTag,
	label: string,
	state: QuantBadgeState,
	canStartDownload: boolean,
	fit: OllamaFitInfo | undefined
): string {
	let status = "Not downloaded";
	if (state.cacheState === "cached") {
		status = "Installed";
	} else if (state.isDownloading) {
		status = `Downloading ${state.progressPercent ?? 0}%`;
	} else if (state.cacheState === "partial") {
		status = `Paused at ${state.progressPercent ?? 0}%`;
	}
	const sizePart = tag.sizeLabel ? ` · ${tag.sizeLabel}` : "";
	const hint = canStartDownload ? " Click to download." : "";
	const fitPart = fit && !fit.fits ? " May not fit on your hardware." : "";
	return `${label} — ${status}${sizePart}.${hint}${fitPart}`;
}

interface OllamaQuantShelfProps {
	getFit: ((sizeBytes: number) => OllamaFitInfo) | undefined;
	installedNames: ReadonlySet<string>;
	onDiscard: (name: string) => void;
	onPull: (name: string) => void;
	onResume: (name: string) => void;
	onSelect: (name: string) => void;
	onStop: (name: string) => void;
	/** The model's parameter size (`4b`, `27b`) — the shelf shows only the quant
	 *  badges for THIS size. Empty/undefined shows every quant the tag list has. */
	paramSize: string | null | undefined;
	pausedPulls: Readonly<Record<string, PausedPullState>>;
	pulls: Readonly<Record<string, OllamaPullProgress>>;
	/** Currently-selected (active) model name — drives the accent badge. */
	selectedName: string | undefined;
	/** All library tags for the model's base slug. Sliced to `paramSize` here. */
	tags: readonly OllamaLibraryTag[];
}

/** The recessed quant shelf: a leading binary glyph + a wrap of quant badges,
 *  one per tag matching `paramSize`. Mirrors the STT picker's `PrecisionGroup`.
 *  Returns null when there are no tags to show (the caller renders nothing). */
function OllamaQuantShelf({
	tags,
	paramSize,
	installedNames,
	selectedName,
	pulls,
	pausedPulls,
	getFit,
	onSelect,
	onPull,
	onStop,
	onResume,
	onDiscard,
}: OllamaQuantShelfProps) {
	// Slice to the card's param size, then prune the dominated/irrelevant quants
	// down to the canonical ladder — keeping anything the user has on disk, is
	// pulling/paused, or has selected so it never disappears mid-flight.
	const visibleTags = pruneToShownQuants(
		tagsForParamSize(tags, paramSize),
		(name) =>
			isTagInstalled(installedNames, name) ||
			pulls[name] !== undefined ||
			pausedPulls[name] !== undefined ||
			isSameOllamaTag(selectedName, name)
	);
	if (visibleTags.length === 0) {
		return null;
	}
	return (
		<div className="flex flex-wrap items-center gap-2">
			<ContentTooltip
				content="Quantization — the numeric precision of the model's weights. Lower precision (q4 / q5) loads faster and uses less RAM/VRAM at a small quality cost; higher precision (q8 / fp16) is the most faithful but heaviest. Click a badge to download it, or select an installed one."
				side="top"
			>
				<span className="inline-flex shrink-0 items-center font-medium text-[10px] text-foreground-muted uppercase tracking-wide">
					<HugeiconsIcon className="size-3" icon={BinaryCodeIcon} />
				</span>
			</ContentTooltip>
			{visibleTags.map((tag) => (
				<OllamaQuantBadge
					fit={tag.sizeBytes ? getFit?.(tag.sizeBytes) : undefined}
					installed={isTagInstalled(installedNames, tag.name)}
					key={tag.name}
					onDiscard={onDiscard}
					onPull={onPull}
					onResume={onResume}
					onSelect={onSelect}
					onStop={onStop}
					paused={pausedPulls[tag.name]}
					pull={pulls[tag.name]}
					selected={isSameOllamaTag(selectedName, tag.name)}
					tag={tag}
				/>
			))}
		</div>
	);
}

/** Everything the quant shelf needs from the picker, threaded down to each row
 *  as one bundle so the row signatures stay small. The pull/select/fit handlers
 *  are the SAME ones the old Pull-button cluster used — the shelf just folds
 *  them into the badges. `getTags`/`fetchTags` source the per-model tag list
 *  from the library store (keyed by lower-cased base slug). */
interface QuantShelfDeps {
	fetchTags: ((baseSlug: string) => void) | undefined;
	getFit: ((sizeBytes: number) => OllamaFitInfo) | undefined;
	getTags: ((baseSlug: string) => readonly OllamaLibraryTag[]) | undefined;
	installedNames: ReadonlySet<string>;
	onDiscard: (name: string) => void;
	onPull: (name: string) => void;
	onResume: (name: string) => void;
	onSelect: (name: string) => void;
	onStop: (name: string) => void;
	pausedPulls: Readonly<Record<string, PausedPullState>>;
	pulls: Readonly<Record<string, OllamaPullProgress>>;
	selectedName: string | undefined;
}

/**
 * Card-BODY click handler for a non-installed (`as="div"`) recommended/library
 * card: it selects/pulls the model's AUTO / recommended (default) tag — the bare
 * `<name>` / `<name>:<size>` with no precision suffix. Mirrors the STT picker,
 * where the "Auto" badge was removed and a card-body click selects the
 * recommended precision; the explicit per-quant badges keep their own clicks
 * (they `stopPropagation`, so they never reach here).
 *
 * The action matches a quant badge's own routing for the default tag: select it
 * when it's already installed, resume a paused pull, otherwise start the pull.
 * Returns `undefined` when the tag is actively downloading (no body action while
 * the default is in flight — the user uses the shelf controls to pause/cancel).
 */
function defaultTagBodyClick(deps: QuantShelfDeps, defaultTag: string): (() => void) | undefined {
	if (deps.pulls[defaultTag] !== undefined) {
		return undefined;
	}
	if (isTagInstalled(deps.installedNames, defaultTag)) {
		return () => deps.onSelect(defaultTag);
	}
	if (deps.pausedPulls[defaultTag] !== undefined) {
		return () => deps.onResume(defaultTag);
	}
	return () => deps.onPull(defaultTag);
}

interface LazyQuantShelfProps {
	/** Library slug whose sibling tags to fetch + render (`gemma3`). */
	baseSlug: string;
	deps: QuantShelfDeps;
	/** Param size the card represents (`4b`). Filters the tag list. */
	paramSize: string | null | undefined;
	/** Rendered until tags load — keeps a single badge visible so the shelf
	 *  doesn't flicker empty for an installed model whose siblings are en route. */
	placeholder?: ReactNode;
}

/** Lazily fetches the base-slug tags (idempotent in the store) and renders the
 *  quant shelf once they're available. Used by every card type so installed,
 *  recommended, and library rows all show the same precision strip. */
function LazyQuantShelf({ baseSlug, paramSize, deps, placeholder }: LazyQuantShelfProps) {
	const { fetchTags, getTags } = deps;
	// Fetch is store-deduped, so firing it on every mount is a no-op after the
	// first resolve. Re-runs only when the slug changes.
	useEffect(() => {
		if (baseSlug) {
			fetchTags?.(baseSlug);
		}
	}, [baseSlug, fetchTags]);
	const tags = baseSlug ? (getTags?.(baseSlug) ?? []) : [];
	if (tags.length === 0) {
		return placeholder ?? null;
	}
	return (
		<OllamaQuantShelf
			getFit={deps.getFit}
			installedNames={deps.installedNames}
			onDiscard={deps.onDiscard}
			onPull={deps.onPull}
			onResume={deps.onResume}
			onSelect={deps.onSelect}
			onStop={deps.onStop}
			paramSize={paramSize}
			pausedPulls={deps.pausedPulls}
			pulls={deps.pulls}
			selectedName={deps.selectedName}
			tags={tags}
		/>
	);
}

// ── Trigger ───────────────────────────────────────────────────────────

function SelectedTriggerContent({ model }: { model: OllamaModel }) {
	const family = getOllamaFamily(model);
	return (
		<div className="flex min-w-0 flex-1 items-center gap-2">
			<PublisherChip family={family} />
			<TruncatedText
				className="font-medium text-foreground"
				text={formatOllamaDisplayName(model.name)}
			/>
		</div>
	);
}

// Flat muted surface — calmed off the old "glass" (white inset highlight +
// white ring + bright hover ring). The trigger now reads as a flat surface step
// (surface-3 over the popup) with a neutral hairline border + soft depth shadow,
// matching the fluidfunctionalism grayscale base. The single accent moments are
// restrained and state-only: the open-state accent ring + the accent hairline
// (rendered in the JSX) + the accent pull-progress strip.
const OLLAMA_TRIGGER_GLASS_CLASSES =
	"group relative flex h-auto min-h-[3.25rem] w-full items-center justify-between gap-2 overflow-hidden rounded-lg border border-border bg-surface-3 px-3 py-2 text-left shadow-surface-2 transition-[transform,border-color,background-color,box-shadow] duration-150 ease-out hover:border-border-hover hover:bg-surface-4 hover:shadow-surface-3 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:border-accent/55 data-[state=open]:bg-accent/[0.06] data-[state=open]:ring-1 data-[state=open]:ring-accent/25";

interface TriggerPullSummary {
	model: string;
	percent: number;
	status: OllamaPullProgress["status"];
}

/** Pick the most-progressed active pull as the one to surface on the trigger.
 *  When multiple pulls run concurrently this keeps the visible bar moving
 *  monotonically toward done rather than flickering between models. */
function pickPrimaryPull(
	pulls: Readonly<Record<string, OllamaPullProgress>>
): TriggerPullSummary | null {
	let best: TriggerPullSummary | null = null;
	for (const [name, progress] of Object.entries(pulls)) {
		const percent = Math.round(progress.percent ?? 0);
		if (!best || percent > best.percent) {
			best = { model: name, percent, status: progress.status };
		}
	}
	return best;
}

/** Ollama-flavored chip+name pair used as a slot inside `SwitchingFromToRow`.
 *  Mirrors the STT picker's `SttModelLabel` so both switching views read the
 *  same way: family chip + name, dim/struck-through on the "from" leg and
 *  accent-emphasized on the "to" leg. */
function OllamaModelLabel({ model, side }: { model: OllamaModel; side: "from" | "to" }) {
	const family = getOllamaFamily(model);
	const displayName = formatOllamaDisplayName(model.name);
	if (side === "from") {
		return (
			<>
				<PublisherChip family={family} />
				<span className="min-w-0 max-w-[8rem] truncate font-medium text-body text-foreground-dim leading-tight tracking-tight line-through decoration-foreground-dim/40">
					{displayName}
				</span>
			</>
		);
	}
	return (
		<>
			<PublisherChip family={family} />
			<span className="min-w-0 truncate font-semibold text-accent text-body leading-tight tracking-tight">
				{displayName}
			</span>
		</>
	);
}

/** Fallback label when the user picked a model that isn't (yet) in the
 *  installed catalog — happens when the swap is "to" an Ollama-library hit
 *  that's still pulling. We can't render a publisher chip without the model
 *  metadata, so just render the bare display name with the same emphasis. */
function OllamaTextLabel({ name, side }: { name: string; side: "from" | "to" }) {
	const displayName = formatOllamaDisplayName(name);
	const tone =
		side === "from"
			? "text-foreground-dim line-through decoration-foreground-dim/40"
			: "font-semibold text-accent";
	return (
		<span
			className={`min-w-0 max-w-[8rem] truncate font-medium text-body leading-tight tracking-tight ${tone}`}
		>
			{displayName}
		</span>
	);
}

interface OllamaTriggerProps {
	activePull: TriggerPullSummary | null;
	disabled: boolean;
	fromModel: OllamaModel | undefined;
	fromName: string | undefined;
	isLoading: boolean;
	isSwitching: boolean;
	placeholder: string;
	selected: OllamaModel | undefined;
	toModel: OllamaModel | undefined;
	toName: string | undefined;
}

/** Pick the right label component for one side of the switching row. Prefers
 *  the resolved `OllamaModel` (publisher chip + name); falls back to the bare
 *  text label when the picked model isn't installed yet (typed pull target). */
function SwitchingSlot({
	model,
	name,
	side,
}: {
	model: OllamaModel | undefined;
	name: string | undefined;
	side: "from" | "to";
}): ReactNode {
	if (model) {
		return <OllamaModelLabel model={model} side={side} />;
	}
	if (name) {
		return <OllamaTextLabel name={name} side={side} />;
	}
	return null;
}

function OllamaBody({
	props,
	ariaLabel,
}: {
	props: OllamaTriggerProps;
	ariaLabel: string | undefined;
}): ReactNode {
	if (props.isSwitching) {
		return (
			<SwitchingFromToRow
				ariaLabel={ariaLabel}
				from={<SwitchingSlot model={props.fromModel} name={props.fromName} side="from" />}
				to={<SwitchingSlot model={props.toModel} name={props.toName} side="to" />}
			/>
		);
	}
	if (props.isLoading) {
		return (
			<div className="flex flex-1 items-center gap-2">
				<PulseDot className="size-2.5 text-foreground-muted" />
				<span className="font-medium text-body text-foreground-muted italic tracking-tight">
					{props.placeholder}
				</span>
			</div>
		);
	}
	if (props.selected) {
		return <SelectedTriggerContent model={props.selected} />;
	}
	return (
		<span className="font-medium text-body text-foreground-muted italic tracking-tight">
			{props.placeholder}
		</span>
	);
}

function buildSwitchingAriaLabel(props: OllamaTriggerProps): string | undefined {
	if (!props.isSwitching) {
		return;
	}
	const toName = props.toModel?.name ?? props.toName;
	if (!toName) {
		return;
	}
	const fromName = props.fromModel?.name ?? props.fromName;
	const fromClause = fromName ? ` from ${formatOllamaDisplayName(fromName)}` : "";
	return `Switching${fromClause} to ${formatOllamaDisplayName(toName)}`;
}

function OllamaTrigger(props: OllamaTriggerProps) {
	const { disabled, isLoading, isSwitching, activePull } = props;
	const ariaLabel = buildSwitchingAriaLabel(props);
	return (
		<Combobox.Trigger
			nativeButton
			render={(triggerProps) => (
				<Button
					{...(triggerProps as ComponentPropsWithoutRef<"button">)}
					aria-label={ariaLabel}
					className={`${OLLAMA_TRIGGER_GLASS_CLASSES} ${buildSwitchingClassName(isSwitching)}`}
					data-loading={isLoading || undefined}
					data-slot="ollama-model-selector-trigger"
					data-switching={isSwitching}
					disabled={disabled || isLoading || isSwitching}
					type="button"
				>
					<span
						aria-hidden="true"
						className="pointer-events-none absolute inset-x-3 top-0 h-px bg-gradient-to-r from-transparent via-accent/30 to-transparent opacity-0 transition-opacity duration-200 group-data-[state=open]:opacity-100 group-data-[switching=true]:opacity-100"
					/>
					<OllamaBody ariaLabel={ariaLabel} props={props} />
					{isSwitching ? (
						<SwitchingPill />
					) : (
						<HugeiconsIcon
							className="ms-2 size-4 shrink-0 text-foreground-muted transition-[transform,color] duration-200 ease-out group-data-[state=open]:rotate-180 group-data-[state=open]:text-foreground"
							icon={ArrowDown01Icon}
						/>
					)}
					{isSwitching ? <SwapSweepBar /> : null}
					{activePull && !isSwitching ? <TriggerPullProgressOverlay summary={activePull} /> : null}
				</Button>
			)}
		/>
	);
}

/** Thin status overlay rendered along the trigger's bottom edge whenever an
 *  Ollama pull is in flight. Conveys two things at a glance while the popup
 *  is closed:
 *
 *    1. A 2px progress strip that fills left → right as bytes land.
 *    2. A label `Downloading <model> · NN%` so the user knows *which* model
 *       is in flight (multiple feature toggles can share the same picker).
 */
function TriggerPullProgressOverlay({ summary }: { summary: TriggerPullSummary }) {
	const beautified = formatOllamaDisplayName(summary.model);
	return (
		<span
			aria-hidden="true"
			className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 px-3 pb-1 text-[9px] text-accent leading-none"
		>
			<span className="truncate font-medium uppercase tracking-wide">
				↓ {beautified} · {summary.percent}%
			</span>
			<span className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-accent/20">
				<span
					className="block h-full bg-accent transition-[width] duration-300 ease-out"
					style={{ width: `${summary.percent}%` }}
				/>
			</span>
		</span>
	);
}

// ── Installed rows ────────────────────────────────────────────────────

/** The installed model's spec facts as a homogeneous middot meta-line: parameter
 *  count and disk size. The quantization level is NO LONGER shown here — it now
 *  lives as a badge in the precision shelf below the card (so it reads at a
 *  glance alongside the model's other available quants). Empty facts are dropped
 *  so a model missing one doesn't render a stray separator. */
function buildInstalledMetaEntries(model: OllamaModel): MetaEntry[] {
	const entries: MetaEntry[] = [];
	const paramSize = model.details?.parameterSize;
	if (paramSize) {
		entries.push({
			key: "params",
			icon: Atom01Icon,
			value: paramSize,
			tooltip: "Parameter count",
		});
	}
	entries.push({
		key: "size",
		icon: HardDriveIcon,
		value: formatOllamaSize(model.size),
		tooltip: "Disk size",
	});
	return entries;
}

/** Synthesize a one-tag list standing in for an installed model whose sibling
 *  library tags haven't loaded yet — the model's OWN tag, so the shelf shows at
 *  least the installed quant (muted-emerald, selectable) without flickering empty
 *  while {@link LazyQuantShelf} fetches the rest. Optional fields are omitted
 *  (not set to `undefined`) so the tag satisfies `exactOptionalPropertyTypes`. */
function installedSelfTag(model: OllamaModel): OllamaLibraryTag {
	const tag: OllamaLibraryTag = { name: model.name };
	if (model.size) {
		tag.sizeBytes = model.size;
		tag.sizeLabel = formatOllamaSize(model.size);
	}
	if (model.details?.quantizationLevel) {
		tag.quantization = model.details.quantizationLevel;
	}
	if (model.details?.parameterSize) {
		tag.parameterSize = model.details.parameterSize;
	}
	return tag;
}

/** The installed model's param size, as the token the library TAGS carry
 *  (`gemma3:4b` → `4b`). Ollama reports `details.parameterSize` as `4.3B`/`4.0B`
 *  — the rounded real param count, which never equals the tag token `4b` — so we
 *  parse the token out of the name and only fall back to the structured field
 *  when the name has no token (a bare `gemma3`). */
function installedParamSize(model: OllamaModel): string {
	return paramSizeFromName(model.name) || (model.details?.parameterSize ?? "");
}

/** The shelf rendered for an installed card. Lazily scrapes the family's sibling
 *  tags (gated to a few concurrent requests in the main process, so a picker-open
 *  burst can't overwhelm ollama.com) and renders every quant for the model's
 *  param size — the installed one tinted as cached/selectable, the rest as
 *  click-to-pull. Until the tags load (or if the scrape fails) the model's own
 *  quant shows as a placeholder so the shelf never flickers empty. */
function InstalledQuantShelf({ model, deps }: { deps: QuantShelfDeps; model: OllamaModel }) {
	const paramSize = installedParamSize(model);
	const selfPlaceholder = (
		<OllamaQuantShelf
			getFit={deps.getFit}
			installedNames={deps.installedNames}
			onDiscard={deps.onDiscard}
			onPull={deps.onPull}
			onResume={deps.onResume}
			onSelect={deps.onSelect}
			onStop={deps.onStop}
			paramSize={paramSize}
			pausedPulls={deps.pausedPulls}
			pulls={deps.pulls}
			selectedName={deps.selectedName}
			tags={[installedSelfTag(model)]}
		/>
	);
	return (
		<LazyQuantShelf
			baseSlug={libraryBaseSlug(model.name)}
			deps={deps}
			paramSize={paramSize}
			placeholder={selfPlaceholder}
		/>
	);
}

/** The trailing delete affordance for an installed card — slotted into
 *  {@link ModelCard}'s `trailing` so it sits after the favourite star, matching
 *  the STT card's delete placement. */
function OllamaDeleteButton({
	model,
	onDelete,
}: {
	model: OllamaModel;
	onDelete: (name: string) => void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={(props) => (
					<button
						{...(props as ComponentPropsWithoutRef<"button">)}
						aria-label={`Delete ${model.name}`}
						className="flex size-6 items-center justify-center rounded text-foreground-muted opacity-0 transition-opacity hover:bg-error/10 hover:text-error focus-visible:opacity-100 group-hover:opacity-100"
						onClick={(e) => {
							e.preventDefault();
							e.stopPropagation();
							onDelete(model.name);
						}}
						type="button"
					>
						<HugeiconsIcon className="size-3.5" icon={Delete02Icon} />
					</button>
				)}
			/>
			<TooltipContent side="top">Delete</TooltipContent>
		</Tooltip>
	);
}

function OllamaModelRow({
	model,
	isSelected,
	isFavorited,
	onDelete,
	onToggleFavorite,
	shelfDeps,
}: {
	isFavorited: boolean;
	isSelected: boolean;
	model: OllamaModel;
	onDelete: ((name: string) => void) | undefined;
	onSelect: (name: string) => void;
	onToggleFavorite: (name: string) => void;
	/** Quant-shelf deps. Omitted (no `librarySearch` prop) → no shelf, and the
	 *  card keeps its prior installed-only chrome. */
	shelfDeps: QuantShelfDeps | undefined;
}) {
	const displayName = formatOllamaDisplayName(model.name);
	const publisher = getOllamaPublisher(getOllamaFamily(model));
	return (
		<ModelCard
			as="combobox-item"
			badges={<ThinkingChip capabilities={model.capabilities ?? undefined} />}
			data-model-id={model.name}
			favorite={{
				isFavorited,
				label: displayName,
				onToggle: () => onToggleFavorite(model.name),
			}}
			makerIcon={<OllamaMakerIcon slug={publisher.slug} />}
			meta={buildInstalledMetaEntries(model)}
			name={displayName}
			selected={isSelected}
			shelf={shelfDeps ? <InstalledQuantShelf deps={shelfDeps} model={model} /> : undefined}
			trailing={onDelete ? <OllamaDeleteButton model={model} onDelete={onDelete} /> : undefined}
			value={model.name}
		/>
	);
}

/** The dim middot count suffix shown after a section label — `· 3 models`. */
function countSubtitle(count: number): string {
	return `· ${count === 1 ? "1 model" : `${count} models`}`;
}

function PublisherGroupHeader({ publisherSlug, count }: { count: number; publisherSlug: string }) {
	const publisher = getOllamaPublisherBySlug(publisherSlug);
	return (
		<GroupHeader
			data-rail-section={publisherSlug}
			icon={<OllamaMakerIcon slug={publisher.slug} />}
			label={publisher.label}
			subtitle={countSubtitle(count)}
		/>
	);
}

function FavoritesGroupHeader({ count }: { count: number }) {
	return (
		<GroupHeader
			data-rail-section={FAVORITES_RAIL_ID}
			icon={<NeutralHeaderIcon icon={StarIcon} tone="favorites" />}
			label="Favorites"
			subtitle={countSubtitle(count)}
		/>
	);
}

/**
 * Header for the synthetic flat "Sorted" group shown while a sort is active.
 * Same shared {@link GroupHeader} chrome as the other sections but maker-agnostic,
 * and it spells out the active dimension + direction, e.g. "Sorted · Size ·
 * smallest first". Mirrors the STT picker's `SortedLabel`.
 */
function SortedGroupHeader({ count, sortKey }: { count: number; sortKey: OllamaSortKey }) {
	return (
		<GroupHeader
			data-rail-section={SORTED_RAIL_ID}
			icon={<NeutralHeaderIcon icon={ArrowUpDownIcon} />}
			label="Sorted"
			subtitle={`· ${OLLAMA_SORT_HEADER_LABEL[sortKey]} · ${count === 1 ? "1 model" : `${count} models`}`}
		/>
	);
}

// ── Library section ───────────────────────────────────────────────────

interface LibraryRowProps {
	hit: OllamaLibraryHit;
	installedNames: ReadonlySet<string>;
	isFavorited: boolean;
	onToggleFavorite: (name: string) => void;
	pausedPulls: Readonly<Record<string, PausedPullState>>;
	pulls: Readonly<Record<string, OllamaPullProgress>>;
	/** Quant-shelf deps — the badges replace the old expand-to-see-tags +
	 *  per-tag Pull cluster. The shelf self-fetches the hit's tags on render. */
	shelfDeps: QuantShelfDeps;
	tagsState:
		| {
				error?: string | null;
				isLoading: boolean;
				tags: readonly OllamaLibraryTag[];
		  }
		| undefined;
}

/** Snapshot of how a library hit is represented locally: how many variants
 *  the user has on disk, plus any pull/paused-pull frame keyed under one of
 *  the hit's tags. Lets the row surface progress without forcing the user to
 *  expand it. */
interface LibraryRowStatus {
	activePull: { name: string; progress: OllamaPullProgress } | null;
	installedCount: number;
	pausedPull: { name: string; state: PausedPullState } | null;
}

function deriveLibraryRowStatus(
	hit: OllamaLibraryHit,
	installedNames: ReadonlySet<string>,
	pulls: Readonly<Record<string, OllamaPullProgress>>,
	pausedPulls: Readonly<Record<string, PausedPullState>>
): LibraryRowStatus {
	const prefix = `${hit.name}:`;
	const matches = (name: string) => name === hit.name || name.startsWith(prefix);

	let installedCount = 0;
	for (const name of installedNames) {
		if (matches(name)) {
			installedCount++;
		}
	}

	let activePull: LibraryRowStatus["activePull"] = null;
	for (const [name, progress] of Object.entries(pulls)) {
		if (matches(name)) {
			activePull = { name, progress };
			break;
		}
	}

	let pausedPull: LibraryRowStatus["pausedPull"] = null;
	for (const [name, state] of Object.entries(pausedPulls)) {
		if (matches(name)) {
			pausedPull = { name, state };
			break;
		}
	}

	return { activePull, installedCount, pausedPull };
}

function libraryRowProgressPercent(status: LibraryRowStatus): number | null {
	if (status.activePull) {
		return Math.round(status.activePull.progress.percent ?? 0);
	}
	if (status.pausedPull) {
		return Math.round(status.pausedPull.state.progress.percent ?? 0);
	}
	return null;
}

/** Maps the current pull/paused snapshot onto the tri-state download phase. */
function derivePullPhase(
	pull: OllamaPullProgress | undefined,
	paused: PausedPullState | undefined
): DownloadPhase {
	if (pull) {
		return "active";
	}
	if (paused) {
		return "paused";
	}
	return "idle";
}

function LibraryRowBadges({
	status,
	progressPercent,
}: {
	status: LibraryRowStatus;
	progressPercent: number | null;
}) {
	return (
		<>
			{status.installedCount > 0 ? (
				<span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/[0.08] px-1.5 py-px font-medium text-[10px] text-emerald-300/80">
					✓ {status.installedCount}{" "}
					{status.installedCount === 1 ? "installed" : "installed variants"}
				</span>
			) : null}
			{status.activePull ? (
				<span className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-1.5 py-px font-medium text-[10px] text-accent">
					<PulseDot className="size-1.5" />
					Downloading {progressPercent ?? 0}%
				</span>
			) : null}
			{!status.activePull && status.pausedPull ? (
				<span className="inline-flex items-center gap-1 rounded-full bg-amber-500/[0.08] px-1.5 py-px font-medium text-[10px] text-amber-300/80">
					Paused at {progressPercent ?? 0}%
				</span>
			) : null}
		</>
	);
}

function LibraryRowProgress({
	hit,
	status,
	progressPercent,
}: {
	hit: OllamaLibraryHit;
	status: LibraryRowStatus;
	progressPercent: number | null;
}) {
	if (progressPercent === null) {
		return null;
	}
	const label = status.activePull
		? `${status.activePull.name} · ${progressPercent}%`
		: `${status.pausedPull?.name ?? hit.name} · paused at ${progressPercent}%`;
	return (
		<div className="mt-2">
			<DownloadProgressBar
				label={label}
				percent={progressPercent}
				variant={status.activePull ? "active" : "paused"}
			/>
		</div>
	);
}

function LibraryRowHeader({
	hit,
	isFavorited,
	onToggleFavorite,
	status,
	progressPercent,
	shelf,
	onBodyClick,
}: {
	hit: OllamaLibraryHit;
	isFavorited: boolean;
	/** Card-body click — selects/pulls the hit's recommended (default `:latest`)
	 *  tag. Omitted (no body action) when the default is actively downloading. */
	onBodyClick: (() => void) | undefined;
	onToggleFavorite: (name: string) => void;
	progressPercent: number | null;
	/** The quant shelf — replaces the old expand-to-see-tags chevron. The
	 *  badges ARE the tag list now. */
	shelf: ReactNode;
	status: LibraryRowStatus;
}) {
	const hitDisplayName = formatOllamaDisplayName(hit.name);
	const hitPublisher = getOllamaPublisher(familySlugFromName(hit.name));
	const caps = hit.capabilities ?? [];
	// Demote status badges + capability pills off the name row to the card's
	// subordinate `badges` wrap-row (mirrors RecommendedRow), so the name owns
	// the top line.
	const hasBadges =
		status.installedCount > 0 || Boolean(status.activePull) || Boolean(status.pausedPull);
	const badges =
		hasBadges || caps.length > 0 ? (
			<>
				<LibraryRowBadges progressPercent={progressPercent} status={status} />
				{caps.map((cap) => (
					<span
						className="rounded-full border border-border/60 px-1.5 py-px text-[9px] text-foreground-muted"
						key={cap}
					>
						{cap}
					</span>
				))}
			</>
		) : undefined;
	return (
		<ModelCard
			as="div"
			badges={badges}
			description={hit.description || undefined}
			favorite={{
				isFavorited,
				label: hitDisplayName,
				onToggle: () => onToggleFavorite(hit.name),
			}}
			makerIcon={<OllamaMakerIcon slug={hitPublisher.slug} />}
			name={hitDisplayName}
			// Card-body click = pull/select the hit's recommended default tag (its
			// bare slug → `:latest`). The per-quant badges keep their explicit clicks.
			onBodyClick={onBodyClick}
			shelf={shelf}
		/>
	);
}

/** The subordinate "pulls · updated" provenance line + download progress,
 *  rendered as PEERS below the library card (the card itself owns name / maker /
 *  badges / description). Indented to align under the card body. */
function LibraryRowFooter({
	hit,
	status,
	progressPercent,
}: {
	hit: OllamaLibraryHit;
	status: LibraryRowStatus;
	progressPercent: number | null;
}) {
	const hitPublisher = getOllamaPublisher(familySlugFromName(hit.name));
	return (
		<div className="mt-1 px-2">
			<div className="flex items-center gap-2 text-[10px] text-foreground-muted">
				<span>by {hitPublisher.label}</span>
				{hit.pulls ? <span>· {hit.pulls} pulls</span> : null}
				{hit.updated ? <span>· Updated {hit.updated}</span> : null}
			</div>
			<LibraryRowProgress hit={hit} progressPercent={progressPercent} status={status} />
		</div>
	);
}

/** The library row's shelf: the quant-badge strip (the tag list, as badges), or
 *  the inline loading / error hint while the hit's sibling tags resolve. The
 *  shelf shows EVERY quant the hit has (a library hit spans all param sizes), so
 *  no param-size filter is applied. */
function LibraryRowShelf({
	hit,
	tagsState,
	shelfDeps,
}: {
	hit: OllamaLibraryHit;
	shelfDeps: QuantShelfDeps;
	tagsState: LibraryRowProps["tagsState"];
}) {
	if (tagsState?.isLoading && (tagsState?.tags.length ?? 0) === 0) {
		return (
			<div className="flex items-center gap-2 text-foreground-muted text-xs">
				<PulseDot className="size-2" />
				Loading quantizations…
			</div>
		);
	}
	if (tagsState?.error) {
		return <div className="rounded bg-error/10 p-2 text-error text-xs">{tagsState.error}</div>;
	}
	return <LazyQuantShelf baseSlug={hit.name} deps={shelfDeps} paramSize={undefined} />;
}

function LibraryRow({
	hit,
	isFavorited,
	onToggleFavorite,
	tagsState,
	installedNames,
	pulls,
	pausedPulls,
	shelfDeps,
}: LibraryRowProps) {
	const status = deriveLibraryRowStatus(hit, installedNames, pulls, pausedPulls);
	const progressPercent = libraryRowProgressPercent(status);
	return (
		<div>
			<LibraryRowHeader
				hit={hit}
				isFavorited={isFavorited}
				onBodyClick={defaultTagBodyClick(shelfDeps, hit.name)}
				onToggleFavorite={onToggleFavorite}
				progressPercent={progressPercent}
				shelf={<LibraryRowShelf hit={hit} shelfDeps={shelfDeps} tagsState={tagsState} />}
				status={status}
			/>
			<LibraryRowFooter hit={hit} progressPercent={progressPercent} status={status} />
		</div>
	);
}

function EmptyState({ filtered }: { filtered: boolean }) {
	return (
		<div className="flex flex-col items-center gap-1 p-6 text-center">
			<p className="font-medium text-body-sm text-foreground">
				{filtered ? "No models match your search" : "No Ollama models installed"}
			</p>
			<p className="text-foreground-muted text-xs">
				{filtered
					? "Try a different search term — or pull a model below."
					: "Pull one from the Recommended list below or visit the Ollama library."}
			</p>
		</div>
	);
}

// ── Recommended rows ──────────────────────────────────────────────────

function pullPercent(progress: OllamaPullProgress): number {
	return Math.round(progress.percent ?? 0);
}

function pullStatusLabel(progress: OllamaPullProgress): string {
	switch (progress.status) {
		case "downloading":
			return "Downloading";
		case "verifying":
			return "Verifying";
		case "writing":
			return "Writing";
		case "success":
			return "Done";
		default:
			return "Pulling";
	}
}

interface PullPaneProps {
	paused: PausedPullState | undefined;
	pull: OllamaPullProgress | undefined;
}

function PullPane({ pull, paused }: PullPaneProps) {
	if (pull) {
		const percent = pullPercent(pull);
		return (
			<div className="mt-2">
				<DownloadProgressBar
					label={`${percent}% — ${pullStatusLabel(pull)}`}
					percent={percent}
					variant="active"
				/>
			</div>
		);
	}
	if (paused) {
		const percent = pullPercent(paused.progress);
		return (
			<div className="mt-2">
				<DownloadProgressBar label={`Paused at ${percent}%`} percent={percent} variant="paused" />
			</div>
		);
	}
	return null;
}

interface RecommendedRowProps {
	fit: OllamaFitInfo | undefined;
	isFavorited: boolean;
	model: RecommendedOllamaModel;
	onToggleFavorite: (name: string) => void;
	/** Quant-shelf deps — the badges replace the recommended row's old
	 *  Pull/Stop/Resume/Discard cluster. Pull/paused state is read from
	 *  `shelfDeps.pulls`/`pausedPulls` per tag. */
	shelfDeps: QuantShelfDeps;
}

/** The shared Pull / Stop / Resume / Discard action cluster used by the
 *  recommended, library-tag, and custom-pull rows. Extracted so each row passes
 *  it through {@link ModelCard}'s `actions` slot with identical labels. */
function OllamaPullActions({
	name,
	phase,
	onPull,
	onStop,
	onResume,
	onDiscard,
}: {
	name: string;
	onDiscard: (name: string) => void;
	onPull: (name: string) => void;
	onResume: (name: string) => void;
	onStop: (name: string) => void;
	phase: DownloadPhase;
}) {
	return (
		<DownloadActions
			discardTooltip="Discard paused download"
			labels={{ download: "Pull", stop: "Stop", resume: "Resume", discard: "Discard" }}
			onDiscard={() => onDiscard(name)}
			onDownload={() => onPull(name)}
			onResume={() => onResume(name)}
			onStop={() => onStop(name)}
			phase={phase}
			size="sm"
		/>
	);
}

/** The recommended model's param-count + disk-size facts as a middot meta-line. */
function buildRecommendedMetaEntries(model: RecommendedOllamaModel): MetaEntry[] {
	return [
		{ key: "params", icon: Atom01Icon, value: model.paramSize, tooltip: "Parameter count" },
		{
			key: "size",
			icon: HardDriveIcon,
			value: formatOllamaSize(model.sizeBytes),
			tooltip: "Disk size",
		},
	];
}

/** Synthesize the recommended model's own tag so its shelf shows a download
 *  badge immediately, before the family's sibling tags resolve. Optional fields
 *  are omitted (not `undefined`) for `exactOptionalPropertyTypes`. */
function recommendedSelfTag(model: RecommendedOllamaModel): OllamaLibraryTag {
	const tag: OllamaLibraryTag = { name: model.name };
	if (model.sizeBytes) {
		tag.sizeBytes = model.sizeBytes;
		tag.sizeLabel = formatOllamaSize(model.sizeBytes);
	}
	const paramSize = paramSizeFromName(model.name);
	if (paramSize) {
		tag.parameterSize = paramSize;
	}
	return tag;
}

function RecommendedRow({
	model,
	fit,
	isFavorited,
	onToggleFavorite,
	shelfDeps,
}: RecommendedRowProps) {
	const recPublisher = getOllamaPublisher((model.family ?? "").toLowerCase());
	// The shelf replaces the old Pull cluster: badges for each quant of this
	// recommended model's param size, with click-to-pull / pause / resume / cancel
	// folded in. Filter by the tag's param token (matching `model.paramSize`'s
	// size), falling back to all when unparseable.
	const paramSize = paramSizeFromName(model.name);
	const placeholder = (
		<OllamaQuantShelf
			getFit={shelfDeps.getFit}
			installedNames={shelfDeps.installedNames}
			onDiscard={shelfDeps.onDiscard}
			onPull={shelfDeps.onPull}
			onResume={shelfDeps.onResume}
			onSelect={shelfDeps.onSelect}
			onStop={shelfDeps.onStop}
			paramSize={paramSize}
			pausedPulls={shelfDeps.pausedPulls}
			pulls={shelfDeps.pulls}
			selectedName={shelfDeps.selectedName}
			tags={[recommendedSelfTag(model)]}
		/>
	);
	return (
		<ModelCard
			as="div"
			badges={
				<>
					<RecommendedStar />
					<WontFitChip fit={fit} />
				</>
			}
			description={model.description}
			favorite={{
				isFavorited,
				label: model.displayName,
				onToggle: () => onToggleFavorite(model.name),
			}}
			makerIcon={<OllamaMakerIcon slug={recPublisher.slug} />}
			meta={buildRecommendedMetaEntries(model)}
			name={model.displayName}
			// Card-body click = use the recommended (default) tag: `model.name` is the
			// bare recommended pull tag (e.g. `gemma3:4b`). Select it if installed,
			// else pull it. The per-quant badges keep their own explicit clicks.
			onBodyClick={defaultTagBodyClick(shelfDeps, model.name)}
			// Lazily scrape the family's sibling tags (gated in the main process) so
			// the card shows every quant for its param size; the default pull badge
			// stands in as the placeholder until they resolve.
			shelf={
				<LazyQuantShelf
					baseSlug={libraryBaseSlug(model.name)}
					deps={shelfDeps}
					paramSize={paramSize}
					placeholder={placeholder}
				/>
			}
		/>
	);
}

interface CustomPullRowProps {
	onDiscard: (name: string) => void;
	onPull: (name: string) => void;
	onResume: (name: string) => void;
	onStop: (name: string) => void;
	paused: PausedPullState | undefined;
	pull: OllamaPullProgress | undefined;
	query: string;
}

function CustomPullRow({
	query,
	pull,
	paused,
	onPull,
	onStop,
	onResume,
	onDiscard,
}: CustomPullRowProps) {
	const trimmed = query.trim();
	if (!(trimmed && VALID_MODEL_NAME_RE.test(trimmed))) {
		return null;
	}
	const phase = derivePullPhase(pull, paused);
	const showPullPane = Boolean(pull || paused);
	return (
		<ModelCard
			actions={
				<OllamaPullActions
					name={trimmed}
					onDiscard={onDiscard}
					onPull={onPull}
					onResume={onResume}
					onStop={onStop}
					phase={phase}
				/>
			}
			as="div"
			description={<span className="truncate font-mono text-foreground-secondary">{trimmed}</span>}
			name="Pull custom model"
			shelf={showPullPane ? <PullPane paused={paused} pull={pull} /> : undefined}
		/>
	);
}

// ── Filtering ─────────────────────────────────────────────────────────

/** Substring match against the model's full search corpus. We index the
 *  beautified display name, the publisher label, and the publisher slug too
 *  so users typing "google" surface their installed Gemma models, "meta"
 *  surfaces Llama, "alibaba" or "qwen" surface Qwen, and so on — the same
 *  search affordance the OpenRouter picker offers. */
function matchesInstalledQuery(m: OllamaModel, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) {
		return true;
	}
	const family = getOllamaFamily(m);
	const publisher = getOllamaPublisher(family);
	const corpus = [
		m.name,
		formatOllamaDisplayName(m.name),
		family,
		publisher.label,
		publisher.slug,
		m.details?.parameterSize ?? "",
		m.details?.quantizationLevel ?? "",
	]
		.join(" ")
		.toLowerCase();
	return corpus.includes(q);
}

function matchesRecommendedQuery(m: RecommendedOllamaModel, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) {
		return true;
	}
	const family = (m.family ?? familySlugFromName(m.name)).toLowerCase();
	const publisher = getOllamaPublisher(family);
	const fields = [
		m.name,
		m.displayName,
		m.description,
		family,
		publisher.label,
		publisher.slug,
		formatOllamaDisplayName(m.name),
		...(m.tags ?? []),
	];
	return fields.some((field) => field.toLowerCase().includes(q));
}

/** Search-indexed row for a single library hit — denormalizes publisher
 *  info onto each entry so fuse.js can fuzzy-match against the maker
 *  ("google", "alibaba", "meta") without us having to re-derive it. */
interface IndexedLibraryHit {
	capabilities: string;
	description: string;
	displayName: string;
	family: string;
	hit: OllamaLibraryHit;
	publisherLabel: string;
	publisherSlug: string;
}

function indexLibraryHit(hit: OllamaLibraryHit): IndexedLibraryHit {
	const family = familySlugFromName(hit.name);
	const publisher = getOllamaPublisher(family);
	return {
		hit,
		displayName: formatOllamaDisplayName(hit.name),
		publisherLabel: publisher.label,
		publisherSlug: publisher.slug,
		family,
		capabilities: (hit.capabilities ?? []).join(" "),
		description: hit.description ?? "",
	};
}

/** Fuse.js options for library search. Threshold and weights mirror the
 *  OpenRouter picker (`packages/model-picker/src/lib/model-selector-logic.ts`)
 *  so search "feels" the same across pickers. */
const LIBRARY_FUSE_OPTIONS: IFuseOptions<IndexedLibraryHit> = {
	threshold: 0.4,
	distance: 100,
	ignoreLocation: true,
	minMatchCharLength: 1,
	shouldSort: true,
	keys: [
		{ name: "hit.name", weight: 2 },
		{ name: "displayName", weight: 2 },
		{ name: "publisherLabel", weight: 1.5 },
		{ name: "publisherSlug", weight: 1 },
		{ name: "family", weight: 0.8 },
		{ name: "capabilities", weight: 0.6 },
		{ name: "description", weight: 0.3 },
	],
};

let cachedIndex: { catalog: readonly OllamaLibraryHit[]; index: IndexedLibraryHit[] } | null = null;
let cachedFuse: { catalog: readonly OllamaLibraryHit[]; fuse: Fuse<IndexedLibraryHit> } | null =
	null;

function getIndex(catalog: readonly OllamaLibraryHit[]): IndexedLibraryHit[] {
	if (cachedIndex && cachedIndex.catalog === catalog) {
		return cachedIndex.index;
	}
	const index = catalog.map(indexLibraryHit);
	cachedIndex = { catalog, index };
	return index;
}

function getFuse(catalog: readonly OllamaLibraryHit[]): Fuse<IndexedLibraryHit> {
	if (cachedFuse && cachedFuse.catalog === catalog) {
		return cachedFuse.fuse;
	}
	const fuse = new FuseConstructor(getIndex(catalog), LIBRARY_FUSE_OPTIONS);
	cachedFuse = { catalog, fuse };
	return fuse;
}

/** Fuzzy-filter the library catalog against a query. Empty query short-circuits
 *  to the original catalog so the popup renders the whole library without
 *  paying the search cost. */
function filterLibraryHits(
	catalog: readonly OllamaLibraryHit[],
	query: string
): readonly OllamaLibraryHit[] {
	const trimmed = query.trim();
	if (!trimmed) {
		return catalog;
	}
	const fuse = getFuse(catalog);
	return fuse.search(trimmed).map((r) => r.item.hit);
}

// ── Maker-first grouping ──────────────────────────────────────────────
// Every model — installed, recommended, and (on search) library — collapses into
// ONE group per maker, so gemma4 shows under "Google" next to gemma3 instead of in
// a separate maker-less "Recommended"/"Library" pile.

export interface MakerGroup {
	installed: OllamaModel[];
	library: OllamaLibraryHit[];
	recommended: RecommendedOllamaModel[];
	slug: string;
}

function recommendedPublisherSlug(m: RecommendedOllamaModel): string {
	return getOllamaPublisher((m.family ?? familySlugFromName(m.name)).toLowerCase()).slug;
}

function ensureMakerGroup(map: Map<string, MakerGroup>, slug: string): MakerGroup {
	const found = map.get(slug);
	if (found) {
		return found;
	}
	const created: MakerGroup = { slug, installed: [], recommended: [], library: [] };
	map.set(slug, created);
	return created;
}

function makerGroupCount(g: MakerGroup): number {
	return g.installed.length + g.recommended.length + g.library.length;
}

/**
 * Merge installed + recommended + (query-only) library models into one group per
 * maker, sorted by maker label. Library hits whose base slug is already shown as
 * an installed/recommended card in the same maker are dropped (no `gemma4` library
 * card next to the `gemma4:e2b` recommended card).
 */
export function buildMakerGroups(opts: {
	installed: readonly OllamaModel[];
	library: readonly OllamaLibraryHit[];
	recommended: readonly RecommendedOllamaModel[];
}): MakerGroup[] {
	const map = new Map<string, MakerGroup>();
	for (const m of opts.installed) {
		ensureMakerGroup(map, getOllamaPublisher(getOllamaFamily(m)).slug).installed.push(m);
	}
	for (const m of opts.recommended) {
		ensureMakerGroup(map, recommendedPublisherSlug(m)).recommended.push(m);
	}
	for (const hit of opts.library) {
		const group = ensureMakerGroup(map, getOllamaPublisher(familySlugFromName(hit.name)).slug);
		const covered = new Set(
			[...group.installed, ...group.recommended].map((m) => libraryBaseSlug(m.name))
		);
		if (!covered.has(libraryBaseSlug(hit.name))) {
			group.library.push(hit);
		}
	}
	return [...map.values()]
		.filter((g) => makerGroupCount(g) > 0)
		.toSorted((a, b) =>
			getOllamaPublisherBySlug(a.slug).label.localeCompare(getOllamaPublisherBySlug(b.slug).label)
		);
}

/** Build the maker-grouped view + the "still loading" flag. Library hits join the
 *  groups ONLY while searching, so the full catalog never dumps by default. */
function buildMakerView(opts: {
	filteredCatalog: readonly OllamaLibraryHit[];
	hasQuery: boolean;
	installed: readonly OllamaModel[];
	libraryIsLoading: boolean;
	recommended: readonly RecommendedOllamaModel[];
}): { libraryLoading: boolean; makerGroups: MakerGroup[] } {
	const makerGroups = buildMakerGroups({
		installed: opts.installed,
		recommended: opts.recommended,
		library: opts.hasQuery ? opts.filteredCatalog : [],
	});
	return { makerGroups, libraryLoading: opts.hasQuery && opts.libraryIsLoading };
}

/** Recommended models not already installed, filtered by the active query. */
function computeRecommendedVisible(
	recommendedModels: readonly RecommendedOllamaModel[] | undefined,
	installedNameSet: ReadonlySet<string>,
	query: string
): RecommendedOllamaModel[] {
	if (!recommendedModels) {
		return [];
	}
	return recommendedModels.filter(
		(m) => !installedNameSet.has(m.name) && matchesRecommendedQuery(m, query)
	);
}

// ── List body ─────────────────────────────────────────────────────────

interface ListBodyProps {
	customPullPaused: PausedPullState | undefined;
	customPullProgress: OllamaPullProgress | undefined;
	/** Recommended (not-installed) models the user has starred — pinned into the
	 *  Favorites group alongside installed favorites, matching the STT picker. */
	favoriteRecommended: readonly RecommendedOllamaModel[];
	/** Installed models the user has starred — pinned as a synthetic "Favorites"
	 *  group at the very top (repeated: each also keeps its maker-group row). */
	favoritesVisible: readonly OllamaModel[];
	hasQuery: boolean;
	/** True while the library catalog is still loading during an active search. */
	libraryLoading: boolean;
	/** Shared row deps for every maker group (installed + recommended + library). */
	makerDeps: MakerGroupDeps;
	/** Installed + recommended (+ library on search) merged into one group per
	 *  maker, sorted by maker label. */
	makerGroups: readonly MakerGroup[];
	onDelete: ((name: string) => void) | undefined;
	onDiscard: (name: string) => void;
	onPull: (name: string) => void;
	onResume: (name: string) => void;
	onSelect: (name: string) => void;
	onStop: (name: string) => void;
	onToggleFavorite: (name: string) => void;
	query: string;
	shelfDeps: QuantShelfDeps;
	/** Whether pull handlers are wired — gates the custom free-text pull row. */
	showCustomPull: boolean;
	/** Installed models flattened into one globally-sorted column, rendered in
	 *  place of the maker groups while a sort is active. */
	sortedInstalled: readonly OllamaModel[];
	/** Active global sort key, or ``null`` for the default maker-grouped view. */
	sortKey: OllamaSortValue;
	value: string;
}

/** Props for the installed-models section — the part that flips between the
 *  per-publisher groups and the single flat "Sorted" column. */
interface InstalledModelsSectionProps {
	grouped: [string, OllamaModel[]][];
	isFavorite: (name: string) => boolean;
	onDelete: ((name: string) => void) | undefined;
	onSelect: (name: string) => void;
	onToggleFavorite: (name: string) => void;
	shelfDeps: QuantShelfDeps;
	sortedInstalled: readonly OllamaModel[];
	sortKey: OllamaSortValue;
	value: string;
}

/**
 * The installed-models section of the list. When a sort is active it renders
 * every installed model in ONE globally-sorted flat column under a single
 * "Sorted · …" header; otherwise it renders the per-publisher groups. Extracted
 * from {@link ListBody} so that function stays under the cognitive-complexity
 * cap. Favorites / Recommended / Library are rendered by `ListBody` around it
 * and are unaffected — the sort applies only to installed models.
 */
function InstalledModelsSection({
	grouped,
	isFavorite,
	onDelete,
	onSelect,
	onToggleFavorite,
	shelfDeps,
	sortedInstalled,
	sortKey,
	value,
}: InstalledModelsSectionProps) {
	if (sortKey !== null) {
		return (
			<div>
				<SortedGroupHeader count={sortedInstalled.length} sortKey={sortKey} />
				<div className="flex flex-col gap-0.5 p-1">
					{sortedInstalled.map((m) => (
						<OllamaModelRow
							isFavorited={isFavorite(m.name)}
							isSelected={m.name === value}
							key={m.name}
							model={m}
							onDelete={onDelete}
							onSelect={onSelect}
							onToggleFavorite={onToggleFavorite}
							shelfDeps={shelfDeps}
						/>
					))}
				</div>
			</div>
		);
	}
	return (
		<>
			{grouped.map(([publisherSlug, items]) => (
				<div key={publisherSlug}>
					<PublisherGroupHeader count={items.length} publisherSlug={publisherSlug} />
					<div className="flex flex-col gap-0.5 p-1">
						{items.map((m) => (
							<OllamaModelRow
								isFavorited={isFavorite(m.name)}
								isSelected={m.name === value}
								key={m.name}
								model={m}
								onDelete={onDelete}
								onSelect={onSelect}
								onToggleFavorite={onToggleFavorite}
								shelfDeps={shelfDeps}
							/>
						))}
					</div>
				</div>
			))}
		</>
	);
}

/** Everything one maker group's rows need, bundled so the section signature
 *  stays small. */
interface MakerGroupDeps {
	getFit: ((sizeBytes: number) => OllamaFitInfo) | undefined;
	installedNames: ReadonlySet<string>;
	isFavorite: (name: string) => boolean;
	onDelete: ((name: string) => void) | undefined;
	onSelect: (name: string) => void;
	onToggleFavorite: (name: string) => void;
	pausedPulls: Readonly<Record<string, PausedPullState>>;
	pulls: Readonly<Record<string, OllamaPullProgress>>;
	shelfDeps: QuantShelfDeps;
	tagsByModel: OllamaLibrarySearchProps["tagsByModel"];
	value: string;
}

/** One maker's section: installed rows first (selectable), then recommended
 *  rows (curated, star-badged), then library hits (only present on search). */
function MakerGroupSection({ group, deps }: { deps: MakerGroupDeps; group: MakerGroup }) {
	return (
		<div>
			<PublisherGroupHeader count={makerGroupCount(group)} publisherSlug={group.slug} />
			<div className="flex flex-col gap-1.5 p-1.5">
				{group.installed.map((m) => (
					<OllamaModelRow
						isFavorited={deps.isFavorite(m.name)}
						isSelected={m.name === deps.value}
						key={m.name}
						model={m}
						onDelete={deps.onDelete}
						onSelect={deps.onSelect}
						onToggleFavorite={deps.onToggleFavorite}
						shelfDeps={deps.shelfDeps}
					/>
				))}
				{group.recommended.map((m) => (
					<RecommendedRow
						fit={deps.getFit?.(m.sizeBytes)}
						isFavorited={deps.isFavorite(m.name)}
						key={m.name}
						model={m}
						onToggleFavorite={deps.onToggleFavorite}
						shelfDeps={deps.shelfDeps}
					/>
				))}
				{group.library.map((hit) => (
					<LibraryRow
						hit={hit}
						installedNames={deps.installedNames}
						isFavorited={deps.isFavorite(hit.name)}
						key={hit.name}
						onToggleFavorite={deps.onToggleFavorite}
						pausedPulls={deps.pausedPulls}
						pulls={deps.pulls}
						shelfDeps={deps.shelfDeps}
						tagsState={deps.tagsByModel[hit.name.toLowerCase()]}
					/>
				))}
			</div>
		</div>
	);
}

function ListBody(props: ListBodyProps) {
	const {
		customPullPaused,
		customPullProgress,
		favoriteRecommended,
		favoritesVisible,
		hasQuery,
		libraryLoading,
		makerDeps,
		makerGroups,
		onDelete,
		onDiscard,
		onPull,
		onResume,
		onSelect,
		onStop,
		onToggleFavorite,
		query,
		shelfDeps,
		showCustomPull,
		sortedInstalled,
		sortKey,
		value,
	} = props;

	const customQuery = query.trim();
	const showCustom = showCustomPull && VALID_MODEL_NAME_RE.test(customQuery);

	if (
		makerGroups.length === 0 &&
		favoritesVisible.length === 0 &&
		favoriteRecommended.length === 0 &&
		!(showCustom || libraryLoading)
	) {
		return <EmptyState filtered={hasQuery} />;
	}

	return (
		<Combobox.List className="min-h-0 flex-1 overflow-y-auto p-0" data-slot="ollama-model-list">
			{/* A global sort flattens EVERY model into one sorted column (matching the
			    STT picker), so the Favorites group — which is intrinsically unsorted /
			    starred-order — is suppressed while sorting; the favorited models still
			    appear in the flat sorted column. */}
			{sortKey === null && favoritesVisible.length + favoriteRecommended.length > 0 ? (
				<div>
					<FavoritesGroupHeader count={favoritesVisible.length + favoriteRecommended.length} />
					<div className="flex flex-col gap-1.5 p-1.5">
						{favoritesVisible.map((m) => (
							<OllamaModelRow
								isFavorited
								isSelected={m.name === value}
								key={`fav-${m.name}`}
								model={m}
								onDelete={onDelete}
								onSelect={onSelect}
								onToggleFavorite={onToggleFavorite}
								shelfDeps={shelfDeps}
							/>
						))}
						{favoriteRecommended.map((m) => (
							<RecommendedRow
								fit={makerDeps.getFit?.(m.sizeBytes)}
								isFavorited
								key={`fav-${m.name}`}
								model={m}
								onToggleFavorite={onToggleFavorite}
								shelfDeps={shelfDeps}
							/>
						))}
					</div>
				</div>
			) : null}
			{showCustom ? (
				<div className="p-1.5">
					<CustomPullRow
						onDiscard={onDiscard}
						onPull={onPull}
						onResume={onResume}
						onStop={onStop}
						paused={customPullPaused}
						pull={customPullProgress}
						query={customQuery}
					/>
				</div>
			) : null}
			{/* Default view: one section per maker, merging that maker's installed +
			    recommended (+ library hits on search) so every model sits under its
			    real maker. An active sort instead flattens all installed models into
			    one globally-sorted column. */}
			{sortKey === null ? (
				makerGroups.map((group) => (
					<MakerGroupSection deps={makerDeps} group={group} key={group.slug} />
				))
			) : (
				<InstalledModelsSection
					grouped={[]}
					isFavorite={makerDeps.isFavorite}
					onDelete={onDelete}
					onSelect={onSelect}
					onToggleFavorite={onToggleFavorite}
					shelfDeps={shelfDeps}
					sortedInstalled={sortedInstalled}
					sortKey={sortKey}
					value={value}
				/>
			)}
			{libraryLoading ? (
				<div className="flex items-center justify-center gap-2 px-3 py-4 text-foreground-muted text-xs">
					<PulseDot className="size-2" />
					Searching the Ollama library…
				</div>
			) : null}
		</Combobox.List>
	);
}

// ── Footer ────────────────────────────────────────────────────────────

function LibraryLinkFooter() {
	return (
		<div className="shrink-0 border-divider border-t bg-[var(--color-surface-1)]/40 px-3 py-2">
			<a
				className="inline-flex items-center gap-1 text-accent text-xs hover:underline"
				href={OLLAMA_LIBRARY_URL}
				rel="noreferrer"
				target="_blank"
			>
				Browse the Ollama library →
			</a>
		</div>
	);
}

// ── Wrapper: composes ModelPicker shell ───────────────────────────────

const EMPTY_PULLS: Readonly<Record<string, OllamaPullProgress>> = Object.freeze({});
const EMPTY_PAUSED: Readonly<Record<string, PausedPullState>> = Object.freeze({});

/** Wraps the body so the popup gets a fixed footer below the scrollable list. */
function selectorListSlot(body: ReactNode): ReactNode {
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{body}
			<LibraryLinkFooter />
		</div>
	);
}

/** Build the GroupRail tile list: a Favorites tile and a Recommended tile
 *  pinned to the top, then one tile per installed publisher, then the Library
 *  section header + per-publisher sub-tiles when the catalog has loaded.
 *  Extracted from `OllamaModelSelector` to keep the component body under the
 *  cognitive-complexity cap. */
/** The rail tile icon for one maker — brand logo when bundled, else a neutral
 *  initials chip (never the misleading OpenRouter "O"). */
function makerRailIcon(slug: string): ReactNode {
	const icon = resolveProviderIcon(slug);
	if (icon) {
		return (
			<img alt="" className="size-5 rounded-[3px] object-cover" height={20} src={icon} width={20} />
		);
	}
	return (
		<RailIconChip>
			{getOllamaPublisherBySlug(slug).label.charAt(0).toUpperCase() || "?"}
		</RailIconChip>
	);
}

function buildOllamaRailItems(opts: {
	favoritesVisibleCount: number;
	makerGroups: readonly MakerGroup[];
	/** When true a sort is active: the maker tiles are replaced by a single
	 *  "Sorted" tile (installed models render as one flat sorted column). */
	sortActive: boolean;
	sortedInstalledCount: number;
}): GroupRailItem[] {
	const railItems: GroupRailItem[] = [];
	if (opts.favoritesVisibleCount > 0) {
		railItems.push(buildFavoritesRailItem(opts.favoritesVisibleCount));
	}
	if (opts.sortActive) {
		if (opts.sortedInstalledCount > 0) {
			railItems.push({
				id: SORTED_RAIL_ID,
				pinned: true,
				label: "Sorted",
				badge: opts.sortedInstalledCount,
				icon: (
					<RailIconChip>
						<HugeiconsIcon className="size-3" icon={ArrowUpDownIcon} />
					</RailIconChip>
				),
			});
		}
		return railItems;
	}
	// One tile per maker — installed + recommended (+ library on search) collapse
	// into the same group, so there is no separate Recommended / Library tile.
	for (const group of opts.makerGroups) {
		railItems.push({
			id: group.slug,
			label: getOllamaPublisherBySlug(group.slug).label,
			badge: makerGroupCount(group),
			icon: makerRailIcon(group.slug),
		});
	}
	return railItems;
}

/** Bundle the quant-shelf data source + handlers into a single {@link
 *  QuantShelfDeps} threaded to every row. Extracted from `OllamaModelSelector`
 *  to keep its cognitive complexity under the rule cap. */
function buildQuantShelfDeps(opts: {
	installedNames: ReadonlySet<string>;
	librarySearch: OllamaLibrarySearchProps | undefined;
	onDelete: ((name: string) => void) | undefined;
	onDiscardPull: ((name: string) => void) | undefined;
	onPull: ((name: string) => void) | undefined;
	onResumePull: ((name: string) => void) | undefined;
	onSelect: (name: string) => void;
	onStopPull: ((name: string) => void) | undefined;
	pausedPulls: Readonly<Record<string, PausedPullState>>;
	pulls: Readonly<Record<string, OllamaPullProgress>>;
	systemFit: ((sizeBytes: number) => OllamaFitInfo) | undefined;
	value: string;
}): QuantShelfDeps {
	const tagsByModel = opts.librarySearch?.tagsByModel;
	const fetchTags = opts.librarySearch?.fetchTags;
	return {
		getFit: opts.systemFit,
		getTags: tagsByModel
			? (baseSlug: string) => tagsByModel[baseSlug.toLowerCase()]?.tags ?? []
			: undefined,
		fetchTags: fetchTags ? (baseSlug: string) => fetchTags(baseSlug) : undefined,
		installedNames: opts.installedNames,
		selectedName: opts.value,
		pulls: opts.pulls,
		pausedPulls: opts.pausedPulls,
		onSelect: opts.onSelect,
		onPull: opts.onPull ?? noop,
		onStop: opts.onStopPull ?? noop,
		onResume: opts.onResumePull ?? noop,
		// The shelf's single `onDiscard` serves two roles: cancel/forget an
		// in-flight or paused pull (not yet installed) AND delete an installed
		// quant's weights. Route by installed-ness so deleting an installed quant
		// actually removes it from disk (onDelete) instead of no-oping on the
		// forget-paused-pull handler — mirrors STT, whose delete hits a real delete.
		onDiscard: (name: string) =>
			opts.installedNames.has(name)
				? (opts.onDelete ?? noop)(name)
				: (opts.onDiscardPull ?? noop)(name),
	};
}

/**
 * Combobox picker for Ollama models. Composes the shared `ModelPicker`
 * shell (search + popup + close-on-select) with three sections inside
 * one dropdown:
 *
 *   1. Installed models grouped by family (selectable, with optional delete).
 *   2. Recommended models filtered to NOT installed, each with a Pull /
 *      Stop / Resume / Discard action row and an inline progress bar.
 *   3. A "Pull custom model" row that appears when the search query matches
 *      a valid Ollama tag (`name`, `name:tag`, etc.) so users can install
 *      anything from the Ollama library without leaving the picker.
 *
 * The recommended section is only rendered when callers supply the pull
 * callbacks (`onPull`, `onStopPull`, `onResumePull`, `onDiscardPull`) and
 * a `recommendedModels` list — otherwise the picker falls back to the
 * pre-existing installed-only behavior.
 */
export function OllamaModelSelector({
	disabled = false,
	inline = false,
	isLoading = false,
	librarySearch,
	models,
	onChange,
	onDelete,
	onDiscardPull,
	onOpen,
	onPull,
	onResumePull,
	onStopPull,
	pausedPulls = EMPTY_PAUSED,
	placeholder = DEFAULT_PLACEHOLDER,
	pulls = EMPTY_PULLS,
	recommendedModels,
	swap,
	systemFit,
	value,
}: OllamaModelSelectorProps) {
	const selected = models.find((m) => m.name === value);
	const [query, setQuery] = useState("");
	// Active global sort key, or ``null`` for the default per-publisher grouping.
	const [sortKey, setSortKey] = useState<OllamaSortValue>(null);
	// Controlled-open + click-tracking, mirroring the STT/OpenRouter pickers.
	// The sort menu's Popover content is portaled OUTSIDE the combobox popup, so
	// without this, clicking a sort chip trips Base UI's outside-press dismissal
	// and collapses the whole picker. ``handleOpenChange`` vetoes that close when
	// the click landed inside our own sort popup.
	const [open, setOpen] = useState(false);
	const lastClickTargetRef = useModelSelectorClickTracking();

	// Kick off the catalog scrape as soon as we have a `librarySearch` prop.
	// The store dedupes via `isLoaded`/`isLoading`, so this is a no-op after
	// the first call. We don't gate on the dropdown opening because some
	// users start typing while the popup is still animating in — the scrape
	// would race and the empty-state would flash misleadingly.
	const loadCatalog = librarySearch?.loadCatalog;
	useEffect(() => {
		loadCatalog?.();
	}, [loadCatalog]);

	// localStorage-backed per-model favorites — same affordance as the STT
	// picker. The star toggle on each installed row flips membership; favorited
	// models surface as a "Favorites" group pinned to the top of the list.
	const { isFavorite, toggleFavorite } = useFavoriteOllamaModels();
	// Per-window starred-AUTHOR set (the publisher rail tiles) — the maker-
	// favoriting affordance every picker shares. Separate localStorage key from
	// the per-model favorites above.
	const { favorites: favoriteAuthors, toggleFavorite: toggleAuthorFavorite } = useFavoriteSet(
		"winstt:ollama-favorite-authors"
	);

	const showRecommendedSection = !!(
		recommendedModels &&
		onPull &&
		onStopPull &&
		onResumePull &&
		onDiscardPull
	);

	const installedFiltered = query.trim()
		? models.filter((m) => matchesInstalledQuery(m, query))
		: models;

	// When a sort is active, the maker groups collapse into one globally-sorted
	// flat column. Computed once here and threaded to both the rail (count) and
	// the list body.
	const sortedInstalled = sortKey === null ? [] : sortOllamaModels(installedFiltered, sortKey);

	// Selecting a model returns to the default grouped view — mirrors the STT
	// picker, which resets its sort on select. Wraps `onChange`.
	const handleSelect = (name: string) => {
		setSortKey(null);
		onChange(name);
	};

	// Starred installed models, query-filtered — pinned to the top of the list
	// as a synthetic "Favorites" group. The model is repeated (it also keeps its
	// publisher-group row), matching the STT picker's behavior.
	const favoritesVisible = installedFiltered.filter((m) => isFavorite(m.name));

	const installedNameSet = new Set(models.map((m) => m.name));

	const recommendedVisible = computeRecommendedVisible(recommendedModels, installedNameSet, query);
	// Recommended models the user starred — pinned into the Favorites group (and
	// kept in their maker group too), matching the STT picker.
	const favoriteRecommended = recommendedVisible.filter((m) => isFavorite(m.name));

	// Client-side fuzzy filter against the full Ollama library catalog. Uses
	// fuse.js (same library the OpenRouter picker uses) so typos / partial
	// names / maker names ("google", "lama") all surface results.
	const hasQuery = query.trim().length > 0;
	const filteredCatalog = librarySearch?.catalog
		? filterLibraryHits(librarySearch.catalog, query)
		: ([] as readonly OllamaLibraryHit[]);

	// Maker-first: installed + recommended (+ library ONLY while searching, so the
	// full ~230-model catalog never dumps by default) merge into one group per
	// maker, sorted by maker label.
	const { makerGroups, libraryLoading } = buildMakerView({
		filteredCatalog,
		hasQuery,
		installed: installedFiltered,
		libraryIsLoading: librarySearch?.isLoading ?? false,
		recommended: recommendedVisible,
	});

	// Build the shared rail tile list — one tile per maker (no Recommended /
	// Library tiles). Matches the OpenRouter + STT pickers (same `GroupRail`).
	const railItems = buildOllamaRailItems({
		favoritesVisibleCount: favoritesVisible.length,
		makerGroups,
		sortActive: sortKey !== null,
		sortedInstalledCount: sortedInstalled.length,
	});

	// Reset the active rail to the selected publisher whenever the model
	// changes. Stored as state so user clicks (``handleRailClick``) and
	// scroll-spy events can override it independently — but tracked via
	// the "previous-prop snapshot" pattern instead of a sync ``useEffect``.
	// ``lastSelectedPublisher`` is a bookkeeping ref (never read in JSX), so
	// it stays out of render-state per react-doctor/rerender-state-only-in-handlers.
	const selectedPublisher = selected ? getOllamaPublisher(getOllamaFamily(selected)).slug : null;
	const [activeRailId, setActiveRailId] = useState<string | null>(selectedPublisher);
	const lastSelectedPublisherRef = useRef<string | null>(selectedPublisher);
	if (lastSelectedPublisherRef.current !== selectedPublisher) {
		lastSelectedPublisherRef.current = selectedPublisher;
		setActiveRailId(selectedPublisher);
	}

	// The popup node is captured into ``popupRef`` via Base UI's callback
	// ref AND forwarded to ``railSpy.attach`` so the spy's internal state
	// fires its `useEffect` when the popup mounts/unmounts. No `useState`
	// for the node lives at this layer — the hook owns it (avoiding the
	// `react-doctor/rerender-state-only-in-handlers` smell).
	const popupRef = useRef<HTMLElement | null>(null);
	const railSpy = useRailScrollSpy({
		scrollContainerSelector: '[data-slot="ollama-model-list"]',
		onActiveChange: (id) => setActiveRailId(id),
	});
	const handleRailClick = (id: string) => {
		railSpy.suppress();
		setActiveRailId(id);
		const root: ParentNode = popupRef.current ?? document;
		const target = root.querySelector<HTMLElement>(`[data-rail-section="${CSS.escape(id)}"]`);
		target?.scrollIntoView({ block: "start", behavior: "smooth" });
	};

	// Keep the picker open when a "close" was actually an outside-press that
	// landed inside our portaled sort popup; let genuine model selections
	// (``item-press``) and real outside clicks close it. Opening also runs the
	// lazy catalog refresh the uncontrolled path used to fire via ``onOpen``.
	const handleOpenChange = (next: boolean, eventDetails?: unknown) => {
		if (next) {
			setOpen(true);
			onOpen?.();
			loadCatalog?.();
			return;
		}
		applyCloseWith(
			extractCloseReason(eventDetails),
			"item-press",
			isInsideMenuPopup(lastClickTargetRef.current, popupRef.current),
			setOpen
		);
	};

	// Combobox.Root's built-in filter is used so keyboard typeahead +
	// item-focus stay in sync with our visible installed rows. We mirror
	// the filtered list for our own grouping/recommended rendering.
	const filter = (m: OllamaModel, q: string) => matchesInstalledQuery(m, q);

	const customQuery = query.trim();
	const customPullProgress = customQuery ? pulls[customQuery] : undefined;
	const customPullPaused = customQuery ? pausedPulls[customQuery] : undefined;

	// The quant shelf's data source + handlers, bundled once and threaded to every
	// row. The pull/select/fit handlers are the SAME ones the old Pull-button
	// cluster used; `getTags`/`fetchTags` lazily source per-base-slug sibling tags
	// from the library store (undefined when no `librarySearch` → shelf shows just
	// the self-badge).
	const shelfDeps = buildQuantShelfDeps({
		installedNames: installedNameSet,
		librarySearch,
		onDelete,
		onDiscardPull,
		onPull,
		onResumePull,
		onSelect: handleSelect,
		onStopPull,
		pausedPulls,
		pulls,
		systemFit,
		value,
	});

	// Shared row deps for every maker group — installed + recommended + library
	// rows all draw from this one bundle.
	const makerDeps: MakerGroupDeps = {
		getFit: systemFit,
		installedNames: installedNameSet,
		isFavorite,
		onDelete,
		onSelect: handleSelect,
		onToggleFavorite: toggleFavorite,
		pausedPulls,
		pulls,
		shelfDeps,
		tagsByModel: librarySearch?.tagsByModel ?? {},
		value,
	};

	const body = (
		<ListBody
			customPullPaused={customPullPaused}
			customPullProgress={customPullProgress}
			favoriteRecommended={favoriteRecommended}
			favoritesVisible={favoritesVisible}
			hasQuery={hasQuery}
			libraryLoading={libraryLoading}
			makerDeps={makerDeps}
			makerGroups={makerGroups}
			onDelete={onDelete}
			onDiscard={onDiscardPull ?? noop}
			onPull={onPull ?? noop}
			onResume={onResumePull ?? noop}
			onSelect={handleSelect}
			onStop={onStopPull ?? noop}
			onToggleFavorite={toggleFavorite}
			query={query}
			shelfDeps={shelfDeps}
			showCustomPull={showRecommendedSection}
			sortedInstalled={sortedInstalled}
			sortKey={sortKey}
			value={value}
		/>
	);

	const swapFromName = swap?.fromName ?? undefined;
	const swapToName = swap?.toName ?? undefined;
	const swapFromModel = swapFromName ? models.find((m) => m.name === swapFromName) : undefined;
	const swapToModel = swapToName ? models.find((m) => m.name === swapToName) : undefined;
	const sidebarSlot =
		railItems.length > 1 ? (
			<GroupRail
				activeId={activeRailId}
				favorites={favoriteAuthors}
				items={railItems}
				onClick={handleRailClick}
				onToggleFavorite={toggleAuthorFavorite}
			/>
		) : undefined;

	return (
		<ModelPicker<OllamaModel, OllamaModel | null>
			disabled={disabled}
			filter={filter}
			filtersMenuSlot={<OllamaSortMenu onSortChange={setSortKey} sort={sortKey} />}
			inline={inline}
			inputValue={query}
			isItemEqualToValue={(a, b) => a?.name === b?.name}
			isLoading={isLoading}
			items={models}
			itemToStringLabel={(m) => m?.name ?? ""}
			list={selectorListSlot(body)}
			onInputValueChange={setQuery}
			onOpenChange={handleOpenChange}
			onValueChange={(next) => forwardOllamaSelection(next, handleSelect)}
			open={open}
			popupHeightClass="h-[min(620px,var(--available-height))]"
			popupRef={(node) => {
				popupRef.current = node;
				railSpy.attach(node);
			}}
			popupWidthClass="w-[max(620px,var(--anchor-width))]"
			searchPlaceholder="Search the Ollama library"
			sidebarSlot={sidebarSlot}
			trigger={
				<OllamaTrigger
					activePull={pickPrimaryPull(pulls)}
					disabled={disabled}
					fromModel={swapFromModel}
					fromName={swapFromName}
					isLoading={isLoading}
					isSwitching={!!swapToName}
					placeholder={placeholder}
					selected={selected}
					toModel={swapToModel}
					toName={swapToName}
				/>
			}
			value={selected ?? null}
		/>
	);
}

function noop() {
	/* no-op fallback when caller doesn't supply pull callbacks */
}

/** Forward a real selection (non-empty string name) to `onChange`. Base UI's
 *  Combobox fires `onValueChange` twice per click — once with the real model,
 *  once with a synthetic value whose `.name` is undefined. The strict guard
 *  prevents the second call from clearing the selection and reverting swaps.
 *  Extracted out of `OllamaModelSelector` to keep its cognitive complexity
 *  under the rule cap. */
function forwardOllamaSelection(
	next: OllamaModel | null,
	onChange: (modelName: string) => void
): void {
	if (next && typeof next.name === "string" && next.name.length > 0) {
		onChange(next.name);
	}
}
