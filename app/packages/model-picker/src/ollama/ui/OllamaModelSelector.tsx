"use client";

import { Combobox } from "@base-ui/react/combobox";
import {
	AlertCircleIcon,
	ArrowDown01Icon,
	ArrowUpDownIcon,
	Atom01Icon,
	BinaryCodeIcon,
	Brain01Icon,
	Delete02Icon,
	HardDriveIcon,
	Idea01Icon,
	StarIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
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
import { DownloadActions, type DownloadPhase, DownloadProgressBar } from "@/shared/ui/download";
import { Spinner } from "@/shared/ui/spinner";
import {
	buildSwitchingClassName,
	SwapSweepBar,
	SwitchingFromToRow,
	SwitchingPill,
} from "@/shared/ui/switching-trigger";
import { GroupRail, type GroupRailItem } from "../../core/GroupRail";
import { ModelPicker } from "../../core/ModelPicker";
import { useRailScrollSpy } from "../../core/use-rail-scroll-spy";
import { getProviderIconWithFallback } from "../../lib/provider-icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/Tooltip";
import { TruncatedText } from "../../ui/TruncatedText";
import {
	formatOllamaDisplayName,
	formatOllamaSize,
	getOllamaFamily,
	getOllamaPublisher,
	getOllamaPublisherBySlug,
	groupOllamaModelsByPublisher,
} from "../lib/family-helpers";
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
const FAVORITES_RAIL_ID = "__favorites__";
const RECOMMENDED_RAIL_ID = "__recommended__";
const LIBRARY_RAIL_ID = "__library__";
const SORTED_RAIL_ID = "__sorted__";
const LEADING_LETTERS_RE = /^[a-zA-Z]+/;

/** Pull the leading alphabetic chunk off an Ollama slug — `gemma3n` → `gemma`. */
function familySlugFromName(name: string): string {
	return (LEADING_LETTERS_RE.exec(name)?.[0] ?? "").toLowerCase();
}

// ── Shared chips (used by trigger + row) ──────────────────────────────

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

function ParameterSizeChip({ value }: { value: string | undefined }) {
	if (!value) {
		return null;
	}
	return (
		<Tooltip>
			<TooltipTrigger
				render={(props) => (
					<span
						{...(props as ComponentPropsWithoutRef<"span">)}
						className="inline-flex shrink-0 items-center gap-1 text-[11px] text-foreground-muted tabular-nums leading-none"
					>
						<HugeiconsIcon className="size-3" icon={Atom01Icon} />
						{value}
					</span>
				)}
			/>
			<TooltipContent>Parameter count</TooltipContent>
		</Tooltip>
	);
}

function QuantizationChip({ value }: { value: string | undefined }) {
	if (!value) {
		return null;
	}
	return (
		<Tooltip>
			<TooltipTrigger
				render={(props) => (
					<span
						{...(props as ComponentPropsWithoutRef<"span">)}
						className="inline-flex shrink-0 items-center gap-1 font-mono text-[10.5px] text-foreground-muted leading-none"
					>
						<HugeiconsIcon className="size-3" icon={BinaryCodeIcon} />
						{value}
					</span>
				)}
			/>
			<TooltipContent>Quantization level</TooltipContent>
		</Tooltip>
	);
}

function SizeChip({ size }: { size: number | undefined }) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={(props) => (
					<span
						{...(props as ComponentPropsWithoutRef<"span">)}
						className="inline-flex shrink-0 items-center gap-1 text-[11px] text-foreground-muted tabular-nums leading-none"
					>
						<HugeiconsIcon className="size-3" icon={HardDriveIcon} />
						{formatOllamaSize(size)}
					</span>
				)}
			/>
			<TooltipContent>Disk size</TooltipContent>
		</Tooltip>
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

/**
 * Star toggle pinned to an installed row's right edge. Clicking it stars /
 * unstars the model, which adds / removes it from the synthetic "Favorites"
 * group pinned to the top of the list. Mirrors the STT picker's `FavoriteToggle`
 * (amber, filled when active) so the gesture reads the same across pickers.
 *
 * `preventDefault` + `stopPropagation` keep the click from bubbling to the
 * enclosing `Combobox.Item` (which would otherwise select the model) — same
 * guard the delete button uses.
 */
function FavoriteToggle({
	isFavorited,
	modelName,
	onToggle,
}: {
	isFavorited: boolean;
	modelName: string;
	onToggle: (name: string) => void;
}) {
	const displayName = formatOllamaDisplayName(modelName);
	return (
		<Tooltip>
			<TooltipTrigger
				render={(props) => (
					<button
						{...(props as ComponentPropsWithoutRef<"button">)}
						aria-label={
							isFavorited
								? `Remove ${displayName} from favorites`
								: `Add ${displayName} to favorites`
						}
						aria-pressed={isFavorited}
						className={cn(
							"flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors",
							"motion-reduce:transition-none",
							isFavorited
								? "text-amber-400 hover:bg-amber-400/15"
								: "text-foreground-muted opacity-55 hover:bg-foreground/[0.08] hover:text-foreground hover:opacity-100"
						)}
						onClick={(e) => {
							e.preventDefault();
							e.stopPropagation();
							onToggle(modelName);
						}}
						type="button"
					>
						<HugeiconsIcon
							className={cn("size-3.5", isFavorited && "fill-amber-400")}
							icon={StarIcon}
						/>
					</button>
				)}
			/>
			<TooltipContent side="top">
				{isFavorited ? "Remove from Favorites" : "Add to Favorites"}
			</TooltipContent>
		</Tooltip>
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
				<Spinner className="size-4" />
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

function OllamaModelRow({
	model,
	isSelected,
	isFavorited,
	onSelect,
	onDelete,
	onToggleFavorite,
}: {
	isFavorited: boolean;
	isSelected: boolean;
	model: OllamaModel;
	onDelete: ((name: string) => void) | undefined;
	onSelect: (name: string) => void;
	onToggleFavorite: (name: string) => void;
}) {
	return (
		<Combobox.Item
			className={cn(
				"group/row flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 transition-colors",
				"hover:bg-foreground/[0.05]",
				isSelected && "bg-accent/[0.09] ring-1 ring-accent/25 ring-inset"
			)}
			onClick={() => onSelect(model.name)}
			value={model.name}
		>
			{/* Name dominates the row; the spec cluster sits to the right in a
			    consistent icon-chip vocabulary, fenced off by a quiet divider so
			    it reads as one grouped strip rather than a smear. */}
			<TruncatedText
				className="font-semibold text-body text-foreground leading-tight"
				text={formatOllamaDisplayName(model.name)}
			/>
			<div className="ms-auto flex shrink-0 items-center gap-2 border-divider border-l ps-2 text-[11px] text-foreground-muted">
				<ThinkingChip capabilities={model.capabilities} />
				<SizeChip size={model.size} />
				<ParameterSizeChip value={model.details?.parameterSize} />
				<QuantizationChip value={model.details?.quantizationLevel} />
			</div>
			<div className="flex shrink-0 items-center gap-1.5">
				<FavoriteToggle
					isFavorited={isFavorited}
					modelName={model.name}
					onToggle={onToggleFavorite}
				/>
				{onDelete ? (
					<Tooltip>
						<TooltipTrigger
							render={(props) => (
								<button
									{...(props as ComponentPropsWithoutRef<"button">)}
									aria-label={`Delete ${model.name}`}
									className="flex size-6 items-center justify-center rounded text-foreground-muted opacity-0 transition-opacity hover:bg-error/10 hover:text-error focus-visible:opacity-100 group-hover/row:opacity-100"
									onClick={(e) => {
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
				) : null}
			</div>
		</Combobox.Item>
	);
}

function PublisherGroupHeader({ publisherSlug, count }: { count: number; publisherSlug: string }) {
	const publisher = getOllamaPublisherBySlug(publisherSlug);
	const iconSrc = getProviderIconWithFallback(publisher.slug);
	return (
		<div
			className="sticky top-0 z-raised flex items-center justify-between border-border/40 border-b bg-surface-elevated/95 px-3 py-1.5 backdrop-blur"
			data-rail-section={publisherSlug}
		>
			<span className="flex items-center gap-1.5 font-semibold text-foreground-secondary text-xs uppercase tracking-wide">
				<img
					alt=""
					className="size-3.5 rounded-[2px] object-cover"
					height={14}
					src={iconSrc}
					width={14}
				/>
				{publisher.label}
			</span>
			<span className="text-[10px] text-foreground-muted tabular-nums">{count}</span>
		</div>
	);
}

function FavoritesGroupHeader({ count }: { count: number }) {
	return (
		<div
			className="sticky top-0 z-raised flex items-center justify-between border-border/40 border-b bg-surface-elevated/95 px-3 py-1.5 backdrop-blur"
			data-rail-section={FAVORITES_RAIL_ID}
		>
			<span className="flex items-center gap-1.5 font-semibold text-foreground-secondary text-xs uppercase tracking-wide">
				<HugeiconsIcon className="size-3 fill-amber-400 text-amber-400" icon={StarIcon} />
				Favorites
			</span>
			<span className="text-[10px] text-foreground-muted tabular-nums">{count}</span>
		</div>
	);
}

function RecommendedGroupHeader({ count }: { count: number }) {
	return (
		<div
			className="sticky top-0 z-raised flex items-center justify-between border-border/40 border-b bg-surface-elevated/95 px-3 py-1.5 backdrop-blur"
			data-rail-section={RECOMMENDED_RAIL_ID}
		>
			<span className="flex items-center gap-1.5 font-semibold text-foreground-secondary text-xs uppercase tracking-wide">
				<HugeiconsIcon className="size-3 text-foreground-muted" icon={Idea01Icon} />
				Recommended
			</span>
			<span className="text-[10px] text-foreground-muted tabular-nums">{count}</span>
		</div>
	);
}

/**
 * Header for the synthetic flat "Sorted" group shown while a sort is active.
 * Same sticky chrome as {@link FavoritesGroupHeader} / {@link RecommendedGroupHeader}
 * but maker-agnostic, and it spells out the active dimension + direction, e.g.
 * "Sorted · Size · smallest first". Mirrors the STT picker's `SortedLabel`.
 */
function SortedGroupHeader({ count, sortKey }: { count: number; sortKey: OllamaSortKey }) {
	return (
		<div
			className="sticky top-0 z-raised flex items-center justify-between border-border/40 border-b bg-surface-elevated/95 px-3 py-1.5 backdrop-blur"
			data-rail-section={SORTED_RAIL_ID}
		>
			<span className="flex items-center gap-1.5 font-semibold text-foreground-secondary text-xs uppercase tracking-wide">
				<HugeiconsIcon className="size-3 text-accent" icon={ArrowUpDownIcon} />
				Sorted · {OLLAMA_SORT_HEADER_LABEL[sortKey]}
			</span>
			<span className="text-[10px] text-foreground-muted tabular-nums">{count}</span>
		</div>
	);
}

// ── Library section ───────────────────────────────────────────────────

/** Sticky section header for one publisher's worth of library hits.
 *  Mirrors {@link PublisherGroupHeader} but lives in the library subtree —
 *  uses a `library:<slug>` rail id so it can coexist with installed groups
 *  even when both contain the same publisher. */
function LibraryPublisherHeader({
	publisherSlug,
	count,
}: {
	count: number;
	publisherSlug: string;
}) {
	const publisher = getOllamaPublisherBySlug(publisherSlug);
	const iconSrc = getProviderIconWithFallback(publisher.slug);
	return (
		<div
			className="sticky top-0 z-raised flex items-center justify-between border-border/40 border-b bg-surface-elevated/95 px-3 py-1.5 backdrop-blur"
			data-rail-section={`${LIBRARY_RAIL_ID}:${publisherSlug}`}
		>
			<span className="flex items-center gap-1.5 font-semibold text-foreground-secondary text-xs uppercase tracking-wide">
				<img
					alt=""
					className="size-3.5 rounded-[2px] object-cover"
					height={14}
					src={iconSrc}
					width={14}
				/>
				{publisher.label}
			</span>
			<span className="text-[10px] text-foreground-muted tabular-nums">{count}</span>
		</div>
	);
}

function LibraryRootHeader({
	isLoading,
	totalMatched,
}: {
	isLoading: boolean;
	totalMatched: number;
}) {
	return (
		<div
			className="sticky top-0 z-raised flex items-center justify-between border-border/40 border-b bg-surface-elevated/95 px-3 py-1.5 backdrop-blur"
			data-rail-section={LIBRARY_RAIL_ID}
		>
			<span className="flex items-center gap-1.5 font-semibold text-foreground-secondary text-xs uppercase tracking-wide">
				Ollama Library
				{isLoading ? <Spinner className="size-3" /> : null}
			</span>
			<span className="text-[10px] text-foreground-muted tabular-nums">{totalMatched}</span>
		</div>
	);
}

interface LibraryRowProps {
	expanded: boolean;
	getFit: ((sizeBytes: number) => OllamaFitInfo) | undefined;
	hit: OllamaLibraryHit;
	installedNames: ReadonlySet<string>;
	onDiscard: (name: string) => void;
	onExpand: (name: string) => void;
	onPull: (name: string) => void;
	onResume: (name: string) => void;
	onStop: (name: string) => void;
	pausedPulls: Readonly<Record<string, PausedPullState>>;
	pulls: Readonly<Record<string, OllamaPullProgress>>;
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

function LibraryTagChip({
	tag,
	fit,
	pull,
	paused,
	installed,
	onDiscard,
	onPull,
	onResume,
	onStop,
}: {
	tag: OllamaLibraryTag;
	fit: OllamaFitInfo | undefined;
	pull: OllamaPullProgress | undefined;
	paused: PausedPullState | undefined;
	installed: boolean;
	onDiscard: (name: string) => void;
	onPull: (name: string) => void;
	onResume: (name: string) => void;
	onStop: (name: string) => void;
}) {
	const phase = derivePullPhase(pull, paused);
	const displayName = formatOllamaDisplayName(tag.name);
	return (
		<div className="flex items-center gap-2 rounded-md border border-border/60 bg-surface-2/40 px-2 py-1.5">
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<div className="flex items-center gap-1.5">
					<span className="truncate font-semibold text-[12px] text-foreground">{displayName}</span>
					{tag.isLatest ? (
						<span className="rounded-full border border-border/60 px-1.5 py-px text-[9px] text-foreground-muted">
							latest
						</span>
					) : null}
					{installed ? (
						<span className="rounded-full bg-emerald-500/[0.08] px-1.5 py-px text-[9px] text-emerald-300/80">
							installed
						</span>
					) : null}
				</div>
				<div className="flex items-center gap-2 text-[10px] text-foreground-muted tabular-nums">
					{tag.parameterSize ? <span>{tag.parameterSize}</span> : null}
					{tag.sizeLabel ? <span>{tag.sizeLabel}</span> : null}
					{tag.quantization ? <span className="font-mono">{tag.quantization}</span> : null}
					{tag.contextWindow ? <span>{tag.contextWindow} ctx</span> : null}
					<WontFitChip fit={fit} />
				</div>
				<PullPane paused={paused} pull={pull} />
			</div>
			{installed ? null : (
				<DownloadActions
					discardTooltip="Discard paused download"
					labels={{ download: "Pull", stop: "Stop", resume: "Resume", discard: "Discard" }}
					onDiscard={() => onDiscard(tag.name)}
					onDownload={() => onPull(tag.name)}
					onResume={() => onResume(tag.name)}
					onStop={() => onStop(tag.name)}
					phase={phase}
					size="sm"
				/>
			)}
		</div>
	);
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
					<Spinner className="size-2.5" />
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
	expanded,
	status,
	progressPercent,
	onClick,
}: {
	hit: OllamaLibraryHit;
	expanded: boolean;
	status: LibraryRowStatus;
	progressPercent: number | null;
	onClick: (e: React.MouseEvent) => void;
}) {
	const hitDisplayName = formatOllamaDisplayName(hit.name);
	const hitPublisher = getOllamaPublisher(familySlugFromName(hit.name));
	const hitIconSrc = getProviderIconWithFallback(hitPublisher.slug);
	return (
		<button className="flex w-full items-start gap-2 text-left" onClick={onClick} type="button">
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
					<img
						alt=""
						className="size-4 rounded-[2px] object-cover"
						height={16}
						src={hitIconSrc}
						width={16}
					/>
					<span className="font-semibold text-body text-foreground leading-tight">
						{hitDisplayName}
					</span>
					<span className="text-[10px] text-foreground-muted">by {hitPublisher.label}</span>
					<LibraryRowBadges progressPercent={progressPercent} status={status} />
					{(hit.capabilities ?? []).map((cap) => (
						<span
							className="rounded-full border border-border/60 px-1.5 py-px text-[9px] text-foreground-muted"
							key={cap}
						>
							{cap}
						</span>
					))}
				</div>
				{hit.description ? (
					<p className="mt-1 line-clamp-2 text-foreground-secondary text-xs leading-snug">
						{hit.description}
					</p>
				) : null}
				<div className="mt-1 flex items-center gap-2 text-[10px] text-foreground-muted">
					{hit.pulls ? <span>{hit.pulls} pulls</span> : null}
					{hit.updated ? <span>· Updated {hit.updated}</span> : null}
				</div>
				<LibraryRowProgress hit={hit} progressPercent={progressPercent} status={status} />
			</div>
			<span className="shrink-0 text-foreground-muted text-xs">{expanded ? "▾" : "▸"}</span>
		</button>
	);
}

function LibraryRowTags({
	tagsState,
	installedNames,
	getFit,
	pulls,
	pausedPulls,
	onPull,
	onStop,
	onResume,
	onDiscard,
}: Pick<
	LibraryRowProps,
	| "tagsState"
	| "installedNames"
	| "getFit"
	| "pulls"
	| "pausedPulls"
	| "onPull"
	| "onStop"
	| "onResume"
	| "onDiscard"
>) {
	return (
		<div className="mt-2 flex flex-col gap-1.5 border-border/40 border-t pt-2">
			{tagsState?.isLoading && tagsState.tags.length === 0 ? (
				<div className="flex items-center gap-2 p-1 text-foreground-muted text-xs">
					<Spinner className="size-3" />
					Loading tags…
				</div>
			) : null}
			{tagsState?.error ? (
				<div className="rounded bg-error/10 p-2 text-error text-xs">{tagsState.error}</div>
			) : null}
			{tagsState?.tags.map((tag) => (
				<LibraryTagChip
					fit={tag.sizeBytes ? getFit?.(tag.sizeBytes) : undefined}
					installed={installedNames.has(tag.name)}
					key={tag.name}
					onDiscard={onDiscard}
					onPull={onPull}
					onResume={onResume}
					onStop={onStop}
					paused={pausedPulls[tag.name]}
					pull={pulls[tag.name]}
					tag={tag}
				/>
			))}
		</div>
	);
}

function LibraryRow({
	hit,
	tagsState,
	expanded,
	installedNames,
	getFit,
	pulls,
	pausedPulls,
	onExpand,
	onPull,
	onStop,
	onResume,
	onDiscard,
}: LibraryRowProps) {
	const toggleExpand = (e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		onExpand(hit.name);
	};
	const status = deriveLibraryRowStatus(hit, installedNames, pulls, pausedPulls);
	const progressPercent = libraryRowProgressPercent(status);
	return (
		<div className="rounded-md border border-border/60 bg-surface-secondary/40 px-3 py-2.5 transition-colors hover:border-border">
			<LibraryRowHeader
				expanded={expanded}
				hit={hit}
				onClick={toggleExpand}
				progressPercent={progressPercent}
				status={status}
			/>
			{expanded ? (
				<LibraryRowTags
					getFit={getFit}
					installedNames={installedNames}
					onDiscard={onDiscard}
					onPull={onPull}
					onResume={onResume}
					onStop={onStop}
					pausedPulls={pausedPulls}
					pulls={pulls}
					tagsState={tagsState}
				/>
			) : null}
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
	model: RecommendedOllamaModel;
	onDiscard: (name: string) => void;
	onPull: (name: string) => void;
	onResume: (name: string) => void;
	onStop: (name: string) => void;
	paused: PausedPullState | undefined;
	pull: OllamaPullProgress | undefined;
}

function RecommendedRow({
	model,
	fit,
	pull,
	paused,
	onPull,
	onStop,
	onResume,
	onDiscard,
}: RecommendedRowProps) {
	const phase = derivePullPhase(pull, paused);
	const sizeLabel = formatOllamaSize(model.sizeBytes);
	const recPublisher = getOllamaPublisher((model.family ?? "").toLowerCase());
	const recIconSrc = getProviderIconWithFallback(recPublisher.slug);
	return (
		<div className="rounded-md border border-border/60 bg-surface-secondary/40 px-3 py-2.5 transition-colors hover:border-border hover:bg-surface-secondary/70">
			<div className="flex items-start gap-3">
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
						<img
							alt=""
							className="size-4 rounded-[2px] object-cover"
							height={16}
							src={recIconSrc}
							width={16}
						/>
						<span className="font-semibold text-body text-foreground leading-tight">
							{model.displayName}
						</span>
						<span className="text-[10px] text-foreground-muted">by {recPublisher.label}</span>
						<WontFitChip fit={fit} />
					</div>
					<div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-foreground-muted leading-tight">
						<span className="inline-flex shrink-0 items-center gap-1 tabular-nums">
							<HugeiconsIcon className="size-3 opacity-70" icon={Atom01Icon} />
							{model.paramSize}
						</span>
						<span aria-hidden="true" className="text-foreground-dim/40">
							·
						</span>
						<span className="inline-flex shrink-0 items-center gap-1 tabular-nums">
							<HugeiconsIcon className="size-3 opacity-70" icon={HardDriveIcon} />
							{sizeLabel}
						</span>
					</div>
					<p className="mt-1 line-clamp-2 text-foreground-secondary text-xs leading-snug">
						{model.description}
					</p>
				</div>
				<DownloadActions
					discardTooltip="Discard paused download"
					labels={{
						download: "Pull",
						stop: "Stop",
						resume: "Resume",
						discard: "Discard",
					}}
					onDiscard={() => onDiscard(model.name)}
					onDownload={() => onPull(model.name)}
					onResume={() => onResume(model.name)}
					onStop={() => onStop(model.name)}
					phase={phase}
					size="sm"
				/>
			</div>
			<PullPane paused={paused} pull={pull} />
		</div>
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
	return (
		<div className="rounded-lg bg-foreground/[0.03] px-3 py-2.5 transition-colors hover:bg-foreground/[0.06]">
			<div className="flex items-start gap-3">
				<div className="min-w-0 flex-1">
					<div className="font-semibold text-body text-foreground leading-tight">
						Pull custom model
					</div>
					<div className="text-foreground-muted text-xs">
						Any Ollama tag (e.g. <span className="font-mono">qwen3:1.7b</span>). Resolved against
						the Ollama library.
					</div>
					<div className="mt-1 truncate font-mono text-foreground-secondary text-xs">{trimmed}</div>
				</div>
				<DownloadActions
					discardTooltip="Discard paused download"
					labels={{
						download: "Pull",
						stop: "Stop",
						resume: "Resume",
						discard: "Discard",
					}}
					onDiscard={() => onDiscard(trimmed)}
					onDownload={() => onPull(trimmed)}
					onResume={() => onResume(trimmed)}
					onStop={() => onStop(trimmed)}
					phase={phase}
					size="sm"
				/>
			</div>
			<PullPane paused={paused} pull={pull} />
		</div>
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

/** Group library hits by publisher slug (Meta, Google, Microsoft, …) and
 *  sort by publisher label so the rail tile order is stable. */
function groupLibraryHitsByPublisher(
	hits: readonly OllamaLibraryHit[]
): [string, OllamaLibraryHit[]][] {
	const groups = new Map<string, OllamaLibraryHit[]>();
	for (const hit of hits) {
		const family = familySlugFromName(hit.name);
		const slug = getOllamaPublisher(family).slug;
		const bucket = groups.get(slug);
		if (bucket) {
			bucket.push(hit);
		} else {
			groups.set(slug, [hit]);
		}
	}
	return Array.from(groups.entries()).toSorted(([a], [b]) =>
		getOllamaPublisherBySlug(a).label.localeCompare(getOllamaPublisherBySlug(b).label)
	);
}

// ── List body ─────────────────────────────────────────────────────────

interface LibrarySectionState {
	error: string | null;
	expandedHit: string | null;
	/** Catalog filtered by the search query, grouped by publisher slug. */
	groupedByPublisher: [string, OllamaLibraryHit[]][];
	/** True when the user has typed something — drives the "no matches" vs
	 *  "library is empty" empty state copy. */
	hasQuery: boolean;
	isLoaded: boolean;
	isLoading: boolean;
	onExpand: (name: string) => void;
	tagsByModel: Readonly<
		Record<string, { error?: string | null; isLoading: boolean; tags: readonly OllamaLibraryTag[] }>
	>;
	/** Total number of hits matching the current query (sum of all groups). */
	totalMatched: number;
}

/** Empty-state copy for the library section — distinguishes "still loading",
 *  "load failed", "no hits for this query", and "nothing in catalog". */
function libraryEmptyMessage(state: LibrarySectionState): string {
	if (state.isLoading) {
		return "Loading library…";
	}
	if (state.error) {
		return "Couldn't reach ollama.com. Check your connection.";
	}
	if (!state.isLoaded) {
		return "Library hasn't loaded yet.";
	}
	if (state.hasQuery) {
		return "No library models match your search.";
	}
	return "Library is empty.";
}

interface ListBodyProps {
	customPullPaused: PausedPullState | undefined;
	customPullProgress: OllamaPullProgress | undefined;
	/** Installed models the user has starred — query-filtered, rendered as a
	 *  synthetic "Favorites" group pinned to the very top (repeated: each model
	 *  also keeps its row in its publisher group). */
	favoritesVisible: readonly OllamaModel[];
	getFit: ((sizeBytes: number) => OllamaFitInfo) | undefined;
	grouped: [string, OllamaModel[]][];
	hasQuery: boolean;
	installedNames: ReadonlySet<string>;
	isFavorite: (name: string) => boolean;
	library: LibrarySectionState | undefined;
	onDelete: ((name: string) => void) | undefined;
	onDiscard: (name: string) => void;
	onPull: (name: string) => void;
	onResume: (name: string) => void;
	onSelect: (name: string) => void;
	onStop: (name: string) => void;
	onToggleFavorite: (name: string) => void;
	pausedPulls: Readonly<Record<string, PausedPullState>>;
	pulls: Readonly<Record<string, OllamaPullProgress>>;
	query: string;
	recommendedVisible: readonly RecommendedOllamaModel[];
	showRecommendedSection: boolean;
	/** All installed (query-filtered) models flattened into one globally-sorted
	 *  column — rendered in place of the per-publisher `grouped` sections while a
	 *  sort is active. */
	sortedInstalled: readonly OllamaModel[];
	/** Active global sort key, or ``null`` for the default per-publisher view. */
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
							/>
						))}
					</div>
				</div>
			))}
		</>
	);
}

function ListBody(props: ListBodyProps) {
	const {
		grouped,
		favoritesVisible,
		recommendedVisible,
		showRecommendedSection,
		hasQuery,
		query,
		value,
		pulls,
		pausedPulls,
		customPullProgress,
		customPullPaused,
		getFit,
		installedNames,
		isFavorite,
		library,
		onSelect,
		onDelete,
		onPull,
		onStop,
		onResume,
		onDiscard,
		onToggleFavorite,
		sortKey,
		sortedInstalled,
	} = props;

	// `grouped` and `sortedInstalled` both derive from the same query-filtered
	// installed set, so "no installed models" is `grouped.length === 0` whether
	// or not a sort is active — no extra branch needed (keeps this function under
	// the cognitive-complexity cap).
	const installedEmpty = grouped.length === 0;
	const recommendedEmpty = recommendedVisible.length === 0;
	const customQuery = query.trim();
	const showCustom = showRecommendedSection && VALID_MODEL_NAME_RE.test(customQuery);
	const showLibrarySection = !!(
		library &&
		(library.totalMatched > 0 || library.isLoading || library.isLoaded)
	);

	if (installedEmpty && recommendedEmpty && !showCustom && !showLibrarySection) {
		return <EmptyState filtered={hasQuery} />;
	}

	return (
		<Combobox.List className="min-h-0 flex-1 overflow-y-auto p-0" data-slot="ollama-model-list">
			{favoritesVisible.length > 0 ? (
				<div>
					<FavoritesGroupHeader count={favoritesVisible.length} />
					<div className="flex flex-col gap-0.5 p-1">
						{favoritesVisible.map((m) => (
							<OllamaModelRow
								isFavorited
								isSelected={m.name === value}
								key={`fav-${m.name}`}
								model={m}
								onDelete={onDelete}
								onSelect={onSelect}
								onToggleFavorite={onToggleFavorite}
							/>
						))}
					</div>
				</div>
			) : null}
			{showRecommendedSection && (recommendedVisible.length > 0 || showCustom) ? (
				<div>
					<RecommendedGroupHeader count={recommendedVisible.length + (showCustom ? 1 : 0)} />
					<div className="flex flex-col gap-1.5 p-2">
						{showCustom ? (
							<CustomPullRow
								onDiscard={onDiscard}
								onPull={onPull}
								onResume={onResume}
								onStop={onStop}
								paused={customPullPaused}
								pull={customPullProgress}
								query={customQuery}
							/>
						) : null}
						{recommendedVisible.map((m) => (
							<RecommendedRow
								fit={getFit?.(m.sizeBytes)}
								key={m.name}
								model={m}
								onDiscard={onDiscard}
								onPull={onPull}
								onResume={onResume}
								onStop={onStop}
								paused={pausedPulls[m.name]}
								pull={pulls[m.name]}
							/>
						))}
					</div>
				</div>
			) : null}
			{/* An active sort flattens every publisher into one globally-sorted
			    column rendered under a single "Sorted · …" header. When no sort
			    is active we keep the per-publisher groups. Favorites / Recommended
			    / Library above + below are unaffected — the sort applies only to
			    the installed models. Extracted so this function stays under the
			    cognitive-complexity cap. */}
			<InstalledModelsSection
				grouped={grouped}
				isFavorite={isFavorite}
				onDelete={onDelete}
				onSelect={onSelect}
				onToggleFavorite={onToggleFavorite}
				sortedInstalled={sortedInstalled}
				sortKey={sortKey}
				value={value}
			/>
			{showLibrarySection && library ? (
				<div>
					<LibraryRootHeader isLoading={library.isLoading} totalMatched={library.totalMatched} />
					{library.error && library.totalMatched === 0 ? (
						<div className="mx-2 my-2 rounded bg-error/10 p-2 text-error text-xs">
							{library.error}
						</div>
					) : null}
					{library.totalMatched === 0 ? (
						<div className="px-3 py-4 text-center text-foreground-muted text-xs">
							{libraryEmptyMessage(library)}
						</div>
					) : null}
					{library.groupedByPublisher.map(([publisherSlug, hits]) => (
						<div key={`library-${publisherSlug}`}>
							<LibraryPublisherHeader count={hits.length} publisherSlug={publisherSlug} />
							<div className="flex flex-col gap-1.5 p-2">
								{hits.map((hit) => (
									<LibraryRow
										expanded={library.expandedHit === hit.name}
										getFit={getFit}
										hit={hit}
										installedNames={installedNames}
										key={hit.name}
										onDiscard={onDiscard}
										onExpand={library.onExpand}
										onPull={onPull}
										onResume={onResume}
										onStop={onStop}
										pausedPulls={pausedPulls}
										pulls={pulls}
										tagsState={library.tagsByModel[hit.name.toLowerCase()]}
									/>
								))}
							</div>
						</div>
					))}
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
function buildOllamaRailItems(opts: {
	favoritesVisibleCount: number;
	grouped: [string, OllamaModel[]][];
	libraryGroupedByPublisher: [string, OllamaLibraryHit[]][];
	libraryIsLoaded: boolean;
	libraryTotalMatched: number;
	recommendedVisibleCount: number;
	showRecommendedSection: boolean;
	/** When true a sort is active: the installed models render as one flat
	 *  "Sorted" column, so the per-publisher rail tiles are suppressed and a
	 *  single "Sorted" tile takes their place. Favorites / Recommended / Library
	 *  tiles stay as-is. */
	sortActive: boolean;
	sortedInstalledCount: number;
}): GroupRailItem[] {
	const railItems: GroupRailItem[] = [];
	// Favorites + Recommended are pinned to the top of the rail, before the
	// per-publisher tiles — mirrors the list section order.
	if (opts.favoritesVisibleCount > 0) {
		railItems.push({
			id: FAVORITES_RAIL_ID,
			label: "Favorites",
			icon: <HugeiconsIcon className="size-3.5 fill-amber-400 text-amber-400" icon={StarIcon} />,
			badge: opts.favoritesVisibleCount,
		});
	}
	if (opts.showRecommendedSection && opts.recommendedVisibleCount > 0) {
		railItems.push({
			id: RECOMMENDED_RAIL_ID,
			label: "Recommended",
			icon: <HugeiconsIcon className="size-3.5 text-foreground-muted" icon={Idea01Icon} />,
			badge: opts.recommendedVisibleCount,
		});
	}
	// While sorting, the installed models collapse into ONE flat "Sorted"
	// column, so we replace the per-publisher tiles with a single Sorted tile
	// (clicking it jumps to the flat group). Otherwise emit one tile per maker.
	if (opts.sortActive) {
		if (opts.sortedInstalledCount > 0) {
			railItems.push({
				id: SORTED_RAIL_ID,
				label: "Sorted",
				badge: opts.sortedInstalledCount,
				icon: <HugeiconsIcon className="size-3.5 text-accent" icon={ArrowUpDownIcon} />,
			});
		}
	} else {
		for (const [publisherSlug, entries] of opts.grouped) {
			const publisher = getOllamaPublisherBySlug(publisherSlug);
			const iconSrc = getProviderIconWithFallback(publisher.slug);
			railItems.push({
				id: publisherSlug,
				label: publisher.label,
				badge: entries.length,
				icon: (
					<img
						alt=""
						className="size-5 rounded-[3px] object-cover"
						height={20}
						src={iconSrc}
						width={20}
					/>
				),
			});
		}
	}
	if (opts.libraryIsLoaded && opts.libraryGroupedByPublisher.length > 0) {
		railItems.push({
			id: LIBRARY_RAIL_ID,
			label: "Ollama Library",
			badge: opts.libraryTotalMatched,
		});
		for (const [publisherSlug, hits] of opts.libraryGroupedByPublisher) {
			const publisher = getOllamaPublisherBySlug(publisherSlug);
			const iconSrc = getProviderIconWithFallback(publisher.slug);
			railItems.push({
				id: `${LIBRARY_RAIL_ID}:${publisherSlug}`,
				label: publisher.label,
				badge: hits.length,
				icon: (
					<img
						alt=""
						className="size-5 rounded-[3px] object-cover opacity-80"
						height={20}
						src={iconSrc}
						width={20}
					/>
				),
			});
		}
	}
	return railItems;
}

/** Compose the `LibrarySectionState` passed to `ListBody`. Returns `undefined`
 *  when no `librarySearch` prop is supplied (in which case the library section
 *  isn't rendered at all). */
function buildLibrarySectionState(opts: {
	expandedHit: string | null;
	filteredCatalogLength: number;
	hasQuery: boolean;
	libraryGroupedByPublisher: [string, OllamaLibraryHit[]][];
	librarySearch: OllamaLibrarySearchProps | undefined;
	onExpand: (name: string) => void;
}): LibrarySectionState | undefined {
	const search = opts.librarySearch;
	if (!search) {
		return;
	}
	return {
		expandedHit: opts.expandedHit,
		groupedByPublisher: opts.libraryGroupedByPublisher,
		totalMatched: opts.filteredCatalogLength,
		error: search.error ?? null,
		hasQuery: opts.hasQuery,
		isLoaded: search.isLoaded,
		isLoading: search.isLoading,
		onExpand: opts.onExpand,
		tagsByModel: search.tagsByModel,
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
	const [expandedHit, setExpandedHit] = useState<string | null>(null);
	// Active global sort key, or ``null`` for the default per-publisher grouping.
	const [sortKey, setSortKey] = useState<OllamaSortValue>(null);

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

	const grouped = groupOllamaModelsByPublisher(installedFiltered);

	// When a sort is active, the per-publisher groups collapse into one
	// globally-sorted flat column. Computed once here and threaded to both the
	// rail (count) and the list body.
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

	const recommendedVisible = recommendedModels
		? recommendedModels.filter(
				(m) => !installedNameSet.has(m.name) && matchesRecommendedQuery(m, query)
			)
		: ([] as RecommendedOllamaModel[]);

	// Client-side fuzzy filter against the full Ollama library catalog. Uses
	// fuse.js (same library the OpenRouter picker uses) so typos / partial
	// names / maker names ("google", "lama") all surface results.
	const filteredCatalog = librarySearch?.catalog
		? filterLibraryHits(librarySearch.catalog, query)
		: ([] as readonly OllamaLibraryHit[]);

	const libraryGroupedByPublisher = groupLibraryHitsByPublisher(filteredCatalog);

	// Build the shared rail tile list — one tile per family + an optional
	// "Recommended" tile at the bottom. Matches the OpenRouter + STT pickers
	// (same `GroupRail` shell).
	const railItems = buildOllamaRailItems({
		favoritesVisibleCount: favoritesVisible.length,
		grouped,
		libraryGroupedByPublisher,
		libraryIsLoaded: librarySearch?.isLoaded ?? false,
		libraryTotalMatched: filteredCatalog.length,
		recommendedVisibleCount: recommendedVisible.length,
		showRecommendedSection,
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

	// Combobox.Root's built-in filter is used so keyboard typeahead +
	// item-focus stay in sync with our visible installed rows. We mirror
	// the filtered list for our own grouping/recommended rendering.
	const filter = (m: OllamaModel, q: string) => matchesInstalledQuery(m, q);

	const customQuery = query.trim();
	const customPullProgress = customQuery ? pulls[customQuery] : undefined;
	const customPullPaused = customQuery ? pausedPulls[customQuery] : undefined;

	const fetchTags = librarySearch?.fetchTags;
	const handleExpand = (name: string) => {
		setExpandedHit((current) => (current === name ? null : name));
		fetchTags?.(name);
	};

	const librarySection = buildLibrarySectionState({
		expandedHit,
		filteredCatalogLength: filteredCatalog.length,
		hasQuery: query.trim().length > 0,
		libraryGroupedByPublisher,
		librarySearch,
		onExpand: handleExpand,
	});

	const body = (
		<ListBody
			customPullPaused={customPullPaused}
			customPullProgress={customPullProgress}
			favoritesVisible={favoritesVisible}
			getFit={systemFit}
			grouped={grouped}
			hasQuery={query.trim().length > 0}
			installedNames={installedNameSet}
			isFavorite={isFavorite}
			library={librarySection}
			onDelete={onDelete}
			onDiscard={onDiscardPull ?? noop}
			onPull={onPull ?? noop}
			onResume={onResumePull ?? noop}
			onSelect={handleSelect}
			onStop={onStopPull ?? noop}
			onToggleFavorite={toggleFavorite}
			pausedPulls={pausedPulls}
			pulls={pulls}
			query={query}
			recommendedVisible={recommendedVisible}
			showRecommendedSection={showRecommendedSection}
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
			<GroupRail activeId={activeRailId} items={railItems} onClick={handleRailClick} />
		) : undefined;

	return (
		<ModelPicker<OllamaModel, OllamaModel | null>
			disabled={disabled}
			filter={filter}
			filtersMenuSlot={<OllamaSortMenu onSortChange={setSortKey} sort={sortKey} />}
			inputValue={query}
			isItemEqualToValue={(a, b) => a?.name === b?.name}
			isLoading={isLoading}
			items={models}
			itemToStringLabel={(m) => m?.name ?? ""}
			list={selectorListSlot(body)}
			onInputValueChange={setQuery}
			onOpen={() => {
				onOpen?.();
				librarySearch?.loadCatalog();
			}}
			onValueChange={(next) => forwardOllamaSelection(next, handleSelect)}
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
