"use client";

import { Combobox } from "@base-ui/react/combobox";
import {
	ArrowUpDownIcon,
	Atom01Icon,
	BinaryCodeIcon,
	Brain01Icon,
	Delete02Icon,
	HardDriveIcon,
	StarIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { useTranslations } from "use-intl";
import type {
	OllamaLibraryHit,
	OllamaLibraryTag,
	OllamaModel,
	OllamaPullProgress,
	RecommendedOllamaModel,
} from "@/shared/api/models";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { DownloadProgressBar } from "@/shared/ui/download";
import { PulseDot } from "@/shared/ui/pulse-dot";
import { FAVORITES_GROUP_VALUE } from "../../core/favorites";
import type { MetaEntry } from "../../core/model-card/CardMeta";
import { GroupHeader, NeutralHeaderIcon } from "../../core/model-card/GroupHeader";
import { ModelCard } from "../../core/model-card/ModelCard";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/Tooltip";
import {
	formatOllamaDisplayName,
	formatOllamaSize,
	getOllamaFamily,
	getOllamaPublisher,
	getOllamaPublisherBySlug,
} from "../lib/family-helpers";
import {
	libraryBaseSlug,
	paramSizeFromName,
} from "../lib/quant-shelf-helpers";
import {
	OLLAMA_SORT_HEADER_LABEL,
	type OllamaSortKey,
	type OllamaSortValue,
} from "../lib/sort-state";
import {
	activePullNameForRow,
	familySlugFromName,
	formatOllamaContextWindow,
	installedDescriptionForModel,
	ollamaDescriptionForName,
	type TypedModelQueryInfo,
} from "../lib/ollama-description-helpers";
import { makerGroupCount, type MakerGroup } from "../lib/maker-groups";
import {
	InstalledCapabilityBadges,
	OllamaMakerIcon,
	RecommendedStar,
	WontFitChip,
} from "./OllamaModelChips";
import {
	InstalledQuantShelf,
	LazyQuantShelf,
	OllamaQuantShelf,
} from "./OllamaQuantShelf";
import { defaultTagBodyClick } from "./OllamaQuantShelf.helpers";
import type {
	MakerGroupDeps,
	OllamaFitInfo,
	OllamaTagsState,
	PausedPullState,
	QuantShelfDeps,
} from "./ollama-selector-types";

// Shared synthetic-group value so the Favorites rail tile, the group header's
// `data-rail-section`, and the click-to-jump all use the same id across pickers.
const FAVORITES_RAIL_ID = FAVORITES_GROUP_VALUE;
const SORTED_RAIL_ID = "__sorted__";

const OLLAMA_DOWNLOADING_CARD_CLASSES = cn(
	"border-accent/45 bg-[linear-gradient(135deg,var(--color-surface-4)_0%,oklch(62%_0.19_260/0.15)_46%,var(--color-surface-2)_100%)] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08),0_10px_28px_-18px_var(--color-accent-glow-strong)] ring-1 ring-accent/20",
	"hover:border-accent/60 hover:bg-[linear-gradient(135deg,var(--color-surface-5)_0%,oklch(62%_0.19_260/0.18)_46%,var(--color-surface-3)_100%)]",
	"data-[highlighted]:border-accent/60 data-[highlighted]:bg-[linear-gradient(135deg,var(--color-surface-5)_0%,oklch(62%_0.19_260/0.18)_46%,var(--color-surface-3)_100%)]",
	"before:pointer-events-none before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-accent/70 before:to-transparent before:content-[''] before:animate-[hairline-pulse_1.8s_ease-in-out_infinite]",
);

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
	if (model.details?.format) {
		entries.push({
			key: "format",
			icon: BinaryCodeIcon,
			value: model.details.format.toUpperCase(),
			tooltip: "Model format",
		});
	}
	const contextWindow = formatOllamaContextWindow(model.contextLength);
	if (contextWindow) {
		entries.push({
			key: "context",
			icon: Brain01Icon,
			value: contextWindow,
			tooltip: "Context window reported by Ollama",
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
	const t = useTranslations("modelPicker");
	return (
		<Tooltip>
			<TooltipTrigger
				render={(props) => (
					<Button
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
					</Button>
				)}
			/>
			<TooltipContent side="top">{t("delete")}</TooltipContent>
		</Tooltip>
	);
}

function OllamaModelRow({
	model,
	description,
	isCatalogModel,
	isSelected,
	isFavorited,
	onDelete,
	onToggleFavorite,
	shelfDeps,
}: {
	description: string | undefined;
	/** True when this installed model is part of the curated catalog. Catalog
	 *  cards persist for the app's lifetime, so they suppress the whole-card
	 *  delete and rely on per-quant shelf deletes instead. */
	isCatalogModel: boolean;
	isFavorited: boolean;
	isSelected: boolean;
	model: OllamaModel;
	onDelete: ((name: string) => void) | undefined;
	onToggleFavorite: (name: string) => void;
	/** Quant-shelf deps. Omitted (no `librarySearch` prop) → no shelf, and the
	 *  card keeps its prior installed-only chrome. */
	shelfDeps: QuantShelfDeps | undefined;
}) {
	const displayName = formatOllamaDisplayName(model.name);
	const publisher = getOllamaPublisher(getOllamaFamily(model));
	const activePullName = shelfDeps
		? activePullNameForRow(
				shelfDeps.pulls,
				model.name,
				model.details?.parameterSize ?? paramSizeFromName(model.name),
			)
		: null;
	return (
		<ModelCard
			as="combobox-item"
			badges={
				model.capabilities?.length ? (
					<InstalledCapabilityBadges capabilities={model.capabilities} />
				) : null
			}
			className={activePullName ? OLLAMA_DOWNLOADING_CARD_CLASSES : undefined}
			data-model-id={activePullName ?? model.name}
			description={description}
			favorite={{
				isFavorited,
				label: displayName,
				onToggle: () => onToggleFavorite(model.name),
			}}
			makerIcon={<OllamaMakerIcon slug={publisher.slug} />}
			meta={buildInstalledMetaEntries(model)}
			name={displayName}
			selected={isSelected}
			shelf={
				shelfDeps ? (
					<InstalledQuantShelf deps={shelfDeps} model={model} />
				) : undefined
			}
			trailing={
				onDelete && !isCatalogModel ? (
					<OllamaDeleteButton model={model} onDelete={onDelete} />
				) : undefined
			}
			value={model.name}
		/>
	);
}

/** The dim middot count suffix shown after a section label — `· 3 models`. */
function countSubtitle(count: number): string {
	return `· ${count === 1 ? "1 model" : `${count} models`}`;
}

function PublisherGroupHeader({
	publisherSlug,
	count,
}: {
	count: number;
	publisherSlug: string;
}) {
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
function SortedGroupHeader({
	count,
	sortKey,
}: {
	count: number;
	sortKey: OllamaSortKey;
}) {
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
	pausedPulls: Readonly<Record<string, PausedPullState>>,
): LibraryRowStatus {
	const prefix = `${hit.name}:`;
	const matches = (name: string) =>
		name === hit.name || name.startsWith(prefix);

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

function LibraryRowBadges({
	status,
	progressPercent,
}: {
	status: LibraryRowStatus;
	progressPercent: number | null;
}) {
	const t = useTranslations("modelPicker");
	return (
		<>
			{status.installedCount > 0 ? (
				<span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/[0.08] px-1.5 py-px font-medium text-[10px] text-emerald-300/80">
					{"✓ "}
					{t("installedCount", { count: status.installedCount })}
				</span>
			) : null}
			{status.activePull ? (
				<span className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-1.5 py-px font-medium text-[10px] text-accent">
					<PulseDot className="size-1.5" />
					{t("downloadingPercent", { percent: progressPercent ?? 0 })}
				</span>
			) : null}
			{!status.activePull && status.pausedPull ? (
				<span className="inline-flex items-center gap-1 rounded-full bg-amber-500/[0.08] px-1.5 py-px font-medium text-[10px] text-amber-300/80">
					{t("pausedAtPercent", { percent: progressPercent ?? 0 })}
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
	const capabilityBadges =
		caps.length > 0 ? <InstalledCapabilityBadges capabilities={caps} /> : null;
	const hasBadges =
		status.installedCount > 0 ||
		Boolean(status.activePull) ||
		Boolean(status.pausedPull);
	const badges =
		hasBadges || capabilityBadges ? (
			<>
				<LibraryRowBadges progressPercent={progressPercent} status={status} />
				{capabilityBadges}
			</>
		) : undefined;
	return (
		<ModelCard
			as="div"
			badges={badges}
			className={
				status.activePull ? OLLAMA_DOWNLOADING_CARD_CLASSES : undefined
			}
			data-model-id={status.activePull?.name ?? hit.name}
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
	const t = useTranslations("modelPicker");
	const hitPublisher = getOllamaPublisher(familySlugFromName(hit.name));
	return (
		<div className="mt-1 px-2">
			<div className="flex items-center gap-2 text-[10px] text-foreground-muted">
				<span>{t("byPublisher", { publisher: hitPublisher.label })}</span>
				{hit.pulls ? (
					<span>· {t("pullsCount", { count: hit.pulls })}</span>
				) : null}
				{hit.updated ? (
					<span>· {t("updatedAt", { date: hit.updated })}</span>
				) : null}
			</div>
			<LibraryRowProgress
				hit={hit}
				progressPercent={progressPercent}
				status={status}
			/>
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
	const t = useTranslations("modelPicker");
	if (tagsState?.isLoading && (tagsState?.tags.length ?? 0) === 0) {
		return (
			<div className="flex items-center gap-2 text-foreground-muted text-xs">
				<PulseDot className="size-2" />
				{t("loadingQuantizations")}
			</div>
		);
	}
	if (tagsState?.error) {
		return (
			<div className="rounded bg-error/10 p-2 text-error text-xs">
				{tagsState.error}
			</div>
		);
	}
	return (
		<LazyQuantShelf
			baseSlug={hit.name}
			deps={shelfDeps}
			paramSize={undefined}
		/>
	);
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
	const status = deriveLibraryRowStatus(
		hit,
		installedNames,
		pulls,
		pausedPulls,
	);
	const progressPercent = libraryRowProgressPercent(status);
	return (
		<div>
			<LibraryRowHeader
				hit={hit}
				isFavorited={isFavorited}
				onBodyClick={defaultTagBodyClick(shelfDeps, hit.name)}
				onToggleFavorite={onToggleFavorite}
				progressPercent={progressPercent}
				shelf={
					<LibraryRowShelf
						hit={hit}
						shelfDeps={shelfDeps}
						tagsState={tagsState}
					/>
				}
				status={status}
			/>
			<LibraryRowFooter
				hit={hit}
				progressPercent={progressPercent}
				status={status}
			/>
		</div>
	);
}

function EmptyState({ filtered }: { filtered: boolean }) {
	return (
		<div className="flex flex-col items-center gap-1 p-6 text-center">
			<p className="font-medium text-body-sm text-foreground">
				{filtered
					? "No models match your search"
					: "No Ollama models installed"}
			</p>
			<p className="text-foreground-muted text-xs">
				{filtered
					? "Try a different search term or enter a full Ollama model tag."
					: "Pull one from the Recommended list below or enter a full Ollama model tag."}
			</p>
		</div>
	);
}

// ── Recommended rows ──────────────────────────────────────────────────

interface RecommendedRowProps {
	description: string | undefined;
	fit: OllamaFitInfo | undefined;
	isFavorited: boolean;
	model: RecommendedOllamaModel;
	onToggleFavorite: (name: string) => void;
	/** Quant-shelf deps — the badges replace the recommended row's old
	 *  Pull/Stop/Resume/Discard cluster. Pull/paused state is read from
	 *  `shelfDeps.pulls`/`pausedPulls` per tag. */
	shelfDeps: QuantShelfDeps;
}

/** The recommended model's param-count + disk-size facts as a middot meta-line. */
function buildRecommendedMetaEntries(
	model: RecommendedOllamaModel,
): MetaEntry[] {
	return [
		{
			key: "params",
			icon: Atom01Icon,
			value: model.paramSize,
			tooltip: "Parameter count",
		},
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
	description,
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
	const activePullName = activePullNameForRow(
		shelfDeps.pulls,
		model.name,
		paramSize || model.paramSize,
	);
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
			description={description ?? model.description}
			className={activePullName ? OLLAMA_DOWNLOADING_CARD_CLASSES : undefined}
			data-model-id={activePullName ?? model.name}
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

interface TypedModelRowProps {
	info: TypedModelQueryInfo;
	matchingTag: OllamaLibraryTag;
	shelfDeps: QuantShelfDeps;
	tagsState: OllamaTagsState;
}

function typedModelSelfTag(
	info: TypedModelQueryInfo,
	matchingTag: OllamaLibraryTag,
): OllamaLibraryTag {
	const tag: OllamaLibraryTag = { ...matchingTag, name: info.modelName };
	if (info.paramSize) {
		tag.parameterSize = info.paramSize;
	}
	return tag;
}

function buildTypedModelMetaEntries(
	info: TypedModelQueryInfo,
	matchingTag: OllamaLibraryTag,
): MetaEntry[] | undefined {
	const entries: MetaEntry[] = [];
	if (info.paramSize) {
		entries.push({
			key: "params",
			icon: Atom01Icon,
			value: info.paramSize.toUpperCase(),
			tooltip: "Parameter count parsed from the tag",
		});
	}
	if (matchingTag.quantization) {
		entries.push({
			key: "quant",
			icon: BinaryCodeIcon,
			value: matchingTag.quantization,
			tooltip: "Quantization",
		});
	}
	if (matchingTag.sizeBytes) {
		entries.push({
			key: "size",
			icon: HardDriveIcon,
			value: matchingTag.sizeLabel ?? formatOllamaSize(matchingTag.sizeBytes),
			tooltip: "Download size",
		});
	}
	if (entries.length === 0) {
		return undefined;
	}
	return entries;
}

function TypedModelFetchStatus({ tagsState }: { tagsState: OllamaTagsState }) {
	const t = useTranslations("modelPicker");
	if (tagsState?.isLoading && tagsState.tags.length === 0) {
		return (
			<div className="flex items-center gap-2 text-foreground-muted text-xs">
				<PulseDot className="size-2" />
				{t("fetchingQuantizations")}
			</div>
		);
	}
	if (tagsState?.error) {
		return (
			<div className="rounded bg-error/10 p-2 text-error text-xs">
				{t("fetchQuantizationsError")}
			</div>
		);
	}
	return null;
}

function TypedModelShelf({
	info,
	matchingTag,
	shelfDeps,
	tagsState,
}: TypedModelRowProps) {
	const forceKeepNames = new Set([info.modelName]);
	return (
		<div className="flex flex-col gap-2">
			<LazyQuantShelf
				baseSlug={info.baseSlug}
				deps={shelfDeps}
				extraTags={[typedModelSelfTag(info, matchingTag)]}
				forceKeepNames={forceKeepNames}
				paramSize={info.paramSize}
			/>
			<TypedModelFetchStatus tagsState={tagsState} />
		</div>
	);
}

function TypedModelRow({
	info,
	matchingTag,
	shelfDeps,
	tagsState,
}: TypedModelRowProps) {
	const activePullName = activePullNameForRow(
		shelfDeps.pulls,
		info.modelName,
		info.paramSize,
	);
	const publisher = getOllamaPublisher(familySlugFromName(info.baseSlug));
	return (
		<ModelCard
			as="div"
			className={activePullName ? OLLAMA_DOWNLOADING_CARD_CLASSES : undefined}
			data-model-id={activePullName ?? info.modelName}
			description={
				<span className="truncate font-mono text-foreground-secondary">
					{info.modelName}
				</span>
			}
			makerIcon={<OllamaMakerIcon slug={publisher.slug} />}
			meta={buildTypedModelMetaEntries(info, matchingTag)}
			name={formatOllamaDisplayName(info.modelName)}
			onBodyClick={defaultTagBodyClick(shelfDeps, info.modelName)}
			shelf={
				<TypedModelShelf
					info={info}
					matchingTag={matchingTag}
					shelfDeps={shelfDeps}
					tagsState={tagsState}
				/>
			}
		/>
	);
}

// ── List body ─────────────────────────────────────────────────────────

interface ListBodyProps {
	/** Recommended (not-installed) models the user has starred — pinned into the
	 *  Favorites group alongside installed favorites, matching the STT picker. */
	favoriteRecommended: readonly RecommendedOllamaModel[];
	/** Installed models the user has starred — pinned as a synthetic "Favorites"
	 *  group at the very top (repeated: each also keeps its maker-group row). */
	favoritesVisible: readonly OllamaModel[];
	hasQuery: boolean;
	/** Shared row deps for every maker group (installed + recommended + library). */
	makerDeps: MakerGroupDeps;
	/** Installed + recommended (+ library on search) merged into one group per
	 *  maker, sorted by maker label. */
	makerGroups: readonly MakerGroup[];
	onDelete: ((name: string) => void) | undefined;
	onToggleFavorite: (name: string) => void;
	shelfDeps: QuantShelfDeps;
	/** Whether pull handlers are wired — gates the typed model search-result row. */
	showTypedModelCard: boolean;
	/** Installed models flattened into one globally-sorted column, rendered in
	 *  place of the maker groups while a sort is active. */
	sortedInstalled: readonly OllamaModel[];
	/** Active global sort key, or ``null`` for the default maker-grouped view. */
	sortKey: OllamaSortValue;
	typedModelInfo: TypedModelQueryInfo | null;
	typedModelMatch: OllamaLibraryTag | undefined;
	typedModelTagsState: OllamaTagsState;
	value: string;
}

interface InstalledModelsSectionProps {
	descriptionsByBase: ReadonlyMap<string, string>;
	isCatalogModel: (name: string) => boolean;
	isFavorite: (name: string) => boolean;
	onDelete: ((name: string) => void) | undefined;
	onToggleFavorite: (name: string) => void;
	shelfDeps: QuantShelfDeps;
	sortedInstalled: readonly OllamaModel[];
	sortKey: OllamaSortKey;
	value: string;
}

/**
 * The installed-models section of the sorted list. Favorites / Recommended /
 * Library are rendered by `ListBody` around it and are unaffected — the sort
 * applies only to installed models.
 */
function InstalledModelsSection({
	descriptionsByBase,
	isCatalogModel,
	isFavorite,
	onDelete,
	onToggleFavorite,
	shelfDeps,
	sortedInstalled,
	sortKey,
	value,
}: InstalledModelsSectionProps) {
	return (
		<div>
			<SortedGroupHeader count={sortedInstalled.length} sortKey={sortKey} />
			<div className="flex flex-col gap-0.5 p-1">
				{sortedInstalled.map((m) => (
					<OllamaModelRow
						description={installedDescriptionForModel(m, descriptionsByBase)}
						isCatalogModel={isCatalogModel(m.name)}
						isFavorited={isFavorite(m.name)}
						isSelected={m.name === value}
						key={m.name}
						model={m}
						onDelete={onDelete}
						onToggleFavorite={onToggleFavorite}
						shelfDeps={shelfDeps}
					/>
				))}
			</div>
		</div>
	);
}

/** One maker's section: installed rows first (selectable), then recommended
 *  rows (curated, star-badged), then library hits (only present on search). */
function MakerGroupSection({
	group,
	deps,
}: {
	deps: MakerGroupDeps;
	group: MakerGroup;
}) {
	return (
		<div>
			<PublisherGroupHeader
				count={makerGroupCount(group)}
				publisherSlug={group.slug}
			/>
			<div className="flex flex-col gap-1.5 p-1.5">
				{group.installed.map((m) => (
					<OllamaModelRow
						description={installedDescriptionForModel(
							m,
							deps.descriptionsByBase,
						)}
						isCatalogModel={deps.isCatalogModel(m.name)}
						isFavorited={deps.isFavorite(m.name)}
						isSelected={m.name === deps.value}
						key={m.name}
						model={m}
						onDelete={deps.onDelete}
						onToggleFavorite={deps.onToggleFavorite}
						shelfDeps={deps.shelfDeps}
					/>
				))}
				{group.recommended.map((m) => (
					<RecommendedRow
						description={ollamaDescriptionForName(
							m.name,
							deps.descriptionsByBase,
						)}
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

export function ListBody(props: ListBodyProps) {
	const {
		favoriteRecommended,
		favoritesVisible,
		hasQuery,
		makerDeps,
		makerGroups,
		onDelete,
		onToggleFavorite,
		shelfDeps,
		showTypedModelCard,
		sortedInstalled,
		sortKey,
		typedModelInfo,
		typedModelMatch,
		typedModelTagsState,
		value,
	} = props;

	const showTypedModel =
		showTypedModelCard &&
		typedModelInfo !== null &&
		typedModelMatch !== undefined;

	if (
		makerGroups.length === 0 &&
		favoritesVisible.length === 0 &&
		favoriteRecommended.length === 0 &&
		!showTypedModel
	) {
		return <EmptyState filtered={hasQuery} />;
	}

	return (
		<Combobox.List
			className="min-h-0 flex-1 overflow-y-auto [overflow-y:overlay] p-0"
			data-slot="ollama-model-list"
		>
			{/* A global sort flattens EVERY model into one sorted column (matching the
			    STT picker), so the Favorites group — which is intrinsically unsorted /
			    starred-order — is suppressed while sorting; the favorited models still
			    appear in the flat sorted column. */}
			{sortKey === null &&
			favoritesVisible.length + favoriteRecommended.length > 0 ? (
				<div>
					<FavoritesGroupHeader
						count={favoritesVisible.length + favoriteRecommended.length}
					/>
					<div className="flex flex-col gap-1.5 p-1.5">
						{favoritesVisible.map((m) => (
							<OllamaModelRow
								description={installedDescriptionForModel(
									m,
									makerDeps.descriptionsByBase,
								)}
								isCatalogModel={makerDeps.isCatalogModel(m.name)}
								isFavorited
								isSelected={m.name === value}
								key={`fav-${m.name}`}
								model={m}
								onDelete={onDelete}
								onToggleFavorite={onToggleFavorite}
								shelfDeps={shelfDeps}
							/>
						))}
						{favoriteRecommended.map((m) => (
							<RecommendedRow
								description={ollamaDescriptionForName(
									m.name,
									makerDeps.descriptionsByBase,
								)}
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
			{showTypedModel && typedModelInfo && typedModelMatch ? (
				<div className="p-1.5">
					<TypedModelRow
						info={typedModelInfo}
						matchingTag={typedModelMatch}
						shelfDeps={shelfDeps}
						tagsState={typedModelTagsState}
					/>
				</div>
			) : null}
			{/* Default view: one section per maker, merging that maker's installed +
			    recommended models so every model sits under its real maker. An active
			    sort instead flattens all installed models into
			    one globally-sorted column. */}
			{sortKey === null ? (
				makerGroups.map((group) => (
					<MakerGroupSection deps={makerDeps} group={group} key={group.slug} />
				))
			) : (
				<InstalledModelsSection
					descriptionsByBase={makerDeps.descriptionsByBase}
					isCatalogModel={makerDeps.isCatalogModel}
					isFavorite={makerDeps.isFavorite}
					onDelete={onDelete}
					onToggleFavorite={onToggleFavorite}
					shelfDeps={shelfDeps}
					sortedInstalled={sortedInstalled}
					sortKey={sortKey}
					value={value}
				/>
			)}
		</Combobox.List>
	);
}
