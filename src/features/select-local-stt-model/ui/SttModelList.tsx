"use client";

import { Button as BaseButton } from "@base-ui/react/button";
import { Combobox } from "@base-ui/react/combobox";
import {
	ArrowUpDownIcon,
	FolderOpenIcon,
	ServerStack01Icon,
	SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import type { ModelInfo } from "@/entities/model-catalog";
import type {
	FitAssessmentEntry,
	ModelStateEntry,
	SystemInfoEntry,
} from "@/shared/api/ipc-client";
import { openCustomModelsFolder } from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";
import { cn } from "@/shared/lib/cn";
import { fireAndForget } from "@/shared/lib/fire-and-forget";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { FavoritesGroupLabel } from "@/shared/ui/model-picker/core/model-card/FavoritesGroupLabel";
import { GROUP_HEADER_CLASSES } from "@/shared/ui/model-picker/core/model-card/card-constants";
import { MakerLogo } from "@/shared/ui/model-picker/ui/MakerLogo";
import type { QuantDownloadCallbacks } from "@/shared/ui/model-picker/core/model-card/QuantShelf";
import { publicAsset } from "@/shared/lib/public-asset";
import {
	bundleVariants,
	type FamilyKey,
	getAuthorLabel,
	getFamilyConfig,
	isFavoritesGroup,
	isSortedGroup,
	type SttListGroup,
} from "../lib/family-helpers";
import { STT_SORT_HEADER_LABEL, type SttSortKey } from "../lib/sort-state";
import { SttModelCard } from "./SttModelCard";
import { SttVariantBundle } from "./SttVariantBundle";

export interface SttModelListProps
	extends QuantDownloadCallbacks<OnnxQuantization> {
	compact?: boolean;
	currentQuantization: OnnxQuantization;
	/** Bundle base ids the user has currently expanded — owned by the selector. */
	expandedBundles: ReadonlySet<string>;
	/** Optional live RAM/VRAM fit assessment lookup per model row. */
	getFitAssessment?:
		| ((modelId: string) => FitAssessmentEntry | null)
		| undefined;
	hasActiveFilters: boolean;
	/** Whether a text query is active. Base UI's `Combobox.Empty` only renders
	 *  for an empty SEARCH result, so the query-less "Suggested hid everything"
	 *  empty state is rendered manually — this flag keeps the two exclusive. */
	hasSearch?: boolean | undefined;
	/** Disables the Suggested flag — the empty-state "show all" tap. */
	onShowAllSuggested?: (() => void) | undefined;
	/** Suggested ON with no explicit sort — the flat column carries the
	 *  "Suggested · best for your machine" header instead of "Sorted". */
	suggestedFlattenActive?: boolean | undefined;
	/** How many models the Suggested flag alone hides (empty-state hint). */
	suggestedHiddenCount?: number | undefined;
	/** Whether a model id is starred — forwarded to every card's favorite toggle. */
	isFavorite: (modelId: string) => boolean;
	onSelect: (modelId: string, quantization?: OnnxQuantization) => void;
	/** Toggle handler for the variant-bundle chevron. */
	onToggleExpanded: (baseId: string) => void;
	/** Star / unstar a model — drives the synthetic Favorites group. */
	onToggleFavorite: (modelId: string) => void;
	selectedId: string | undefined;
	/** Active global sort key, or ``null`` in the default grouped view. When set
	 *  the list renders a single flat "Sorted by …" column instead of the
	 *  per-maker groups. */
	sortKey: SttSortKey | null;
	statesById: Record<string, ModelStateEntry>;
	systemInfo: SystemInfoEntry | null;
	/** Total filtered model count — read aloud via Combobox.Status. */
	visibleModelCount: number;
}

function AuthorLabel({
	family,
	compact = false,
}: {
	family: FamilyKey;
	compact?: boolean;
}) {
	const config = getFamilyConfig(family);
	const author = getAuthorLabel(family);
	return (
		<Combobox.GroupLabel
			className={cn(GROUP_HEADER_CLASSES, compact ? "h-7" : "h-8")}
			data-rail-section={family}
		>
			<MakerLogo
				alt={`${author} logo`}
				fallback={<HugeiconsIcon className="size-3" icon={config.icon} />}
				src={config.logoSrc ? publicAsset(config.logoSrc) : null}
			/>
			<span className="font-semibold text-[10px] text-foreground-muted uppercase tracking-[0.12em]">
				{author}
			</span>
			<span className="text-[10px] text-foreground-dim">· {config.label}</span>
		</Combobox.GroupLabel>
	);
}

/** Props the Favorites group needs to render each starred model as a flat card.
 *  A subset of {@link SttModelListProps} — the favorites view never bundles
 *  variants, so it skips the expansion machinery. */
interface FavoritesGroupProps {
	currentQuantization: OnnxQuantization;
	getFitAssessment: SttModelListProps["getFitAssessment"];
	getFittingQuants: SttModelListProps["getFittingQuants"];
	getDownloadSnapshot: SttModelListProps["getDownloadSnapshot"];
	isFavorite: (modelId: string) => boolean;
	items: readonly ModelInfo[];
	onDownloadAction: SttModelListProps["onDownloadAction"];
	onRequestDeleteQuant: SttModelListProps["onRequestDeleteQuant"];
	canDeleteQuant: SttModelListProps["canDeleteQuant"];
	onSelect: SttModelListProps["onSelect"];
	onToggleFavorite: (modelId: string) => void;
	selectedId: string | undefined;
	statesById: Record<string, ModelStateEntry>;
	systemInfo: SystemInfoEntry | null;
	compact?: boolean;
}

/**
 * The pinned "Favorites" group at the top of the list. Renders each starred
 * model as a FLAT card — deliberately NOT bundled like the maker groups, so a
 * starred ``.en`` / lite-whisper / Canary sibling is never hidden under a
 * chevron the user would have to expand to reach. ``siblings={items}`` is still
 * passed so {@link variantDisplayName} keeps a size token when two favorited
 * variants would otherwise collapse to the same name.
 */
function FavoritesGroup({
	currentQuantization,
	getFitAssessment,
	getFittingQuants,
	getDownloadSnapshot,
	isFavorite,
	items,
	onDownloadAction,
	onRequestDeleteQuant,
	canDeleteQuant,
	onSelect,
	onToggleFavorite,
	selectedId,
	statesById,
	systemInfo,
	compact = false,
}: FavoritesGroupProps) {
	return (
		<Combobox.Group className="flex flex-col" items={items}>
			<FavoritesGroupLabel count={items.length} compact={compact} />
			{items.map((model) => (
				<SttModelCard
					compact={compact}
					currentQuantization={currentQuantization}
					fitAssessment={getFitAssessment?.(model.id) ?? null}
					getDownloadSnapshot={getDownloadSnapshot}
					getFittingQuants={getFittingQuants}
					isFavorite={isFavorite}
					key={model.id}
					model={model}
					onDownloadAction={onDownloadAction}
					onRequestDeleteQuant={onRequestDeleteQuant}
					canDeleteQuant={canDeleteQuant}
					onSelect={onSelect}
					onToggleFavorite={onToggleFavorite}
					selectedId={selectedId}
					siblings={items}
					state={statesById[model.id]}
					statesById={statesById}
					systemInfo={systemInfo}
				/>
			))}
		</Combobox.Group>
	);
}

/**
 * Header for the synthetic flat "Sorted" group. Same sticky-label chrome as
 * {@link AuthorLabel} / {@link FavoritesLabel} and spells out the active
 * dimension + direction, e.g. "Sorted · Speed · fastest first".
 */
function SortedLabel({
	sortKey,
	suggested = false,
	compact = false,
}: {
	sortKey: SttSortKey | null;
	suggested?: boolean;
	compact?: boolean;
}) {
	const t = useTranslations("modelPicker");
	// The Suggested flatten (flag ON, no explicit sort) carries its own header:
	// "Suggested · best for your machine". An explicit sort key overrides it.
	const isSuggestedHeader = sortKey === null && suggested;
	// No `data-rail-section`: the maker rail is hidden while sorting, so we keep
	// the scroll-spy from latching onto this header and leaving the rail with no
	// active tile once the sort is cleared.
	return (
		<Combobox.GroupLabel
			className={cn(GROUP_HEADER_CLASSES, compact ? "h-7" : "h-8")}
		>
			<span className="flex size-4 items-center justify-center rounded bg-foreground/[0.06] text-foreground-muted">
				<HugeiconsIcon
					className="size-3"
					icon={isSuggestedHeader ? SparklesIcon : ArrowUpDownIcon}
				/>
			</span>
			<span className="font-semibold text-[10px] text-foreground-muted uppercase tracking-[0.12em]">
				{isSuggestedHeader ? t("suggested") : t("sorted")}
			</span>
			{isSuggestedHeader ? (
				<span className="text-[10px] text-foreground-dim">
					· {t("suggestedSortHeader")}
				</span>
			) : sortKey ? (
				<span className="text-[10px] text-foreground-dim">
					· {STT_SORT_HEADER_LABEL[sortKey]}
				</span>
			) : null}
		</Combobox.GroupLabel>
	);
}

/**
 * The flat, globally-sorted column shown while a sort is active. Like
 * {@link FavoritesGroup} it renders every model as a FLAT card (NOT bundled) —
 * bundling would re-group variants and break the global ordering, and it would
 * hide a fast/small sibling under a chevron. ``siblings={items}`` keeps the size
 * token on names that would otherwise collide.
 */
function SortedGroup({
	currentQuantization,
	getFitAssessment,
	getFittingQuants,
	getDownloadSnapshot,
	isFavorite,
	items,
	onDownloadAction,
	onRequestDeleteQuant,
	canDeleteQuant,
	onSelect,
	onToggleFavorite,
	selectedId,
	sortKey,
	statesById,
	suggested,
	systemInfo,
	compact = false,
}: FavoritesGroupProps & { sortKey: SttSortKey | null; suggested: boolean }) {
	return (
		<Combobox.Group className="flex flex-col" items={items}>
			<SortedLabel compact={compact} sortKey={sortKey} suggested={suggested} />
			{items.map((model) => (
				<SttModelCard
					compact={compact}
					currentQuantization={currentQuantization}
					fitAssessment={getFitAssessment?.(model.id) ?? null}
					getDownloadSnapshot={getDownloadSnapshot}
					getFittingQuants={getFittingQuants}
					isFavorite={isFavorite}
					key={model.id}
					model={model}
					onDownloadAction={onDownloadAction}
					onRequestDeleteQuant={onRequestDeleteQuant}
					canDeleteQuant={canDeleteQuant}
					onSelect={onSelect}
					onToggleFavorite={onToggleFavorite}
					selectedId={selectedId}
					siblings={items}
					state={statesById[model.id]}
					statesById={statesById}
					systemInfo={systemInfo}
				/>
			))}
		</Combobox.Group>
	);
}

/**
 * Footer row for the "custom" family group: a CTA that opens the on-disk
 * drop folder. Lives inside the group so it scrolls with the custom-models
 * section and stays out of the way for users who don't use custom models.
 */
// Fire-and-forget; the main process toasts on failure (rare — would
// require the OS shell to reject opening %APPDATA%). We deliberately
// don't await because the click handler doesn't need to block.
const handleOpenCustomModelsFolder = () => {
	fireAndForget(openCustomModelsFolder(), "openCustomModelsFolder");
};

function OpenCustomModelsFolderRow({ compact = false }: { compact?: boolean }) {
	const t = useTranslations("modelPicker");
	return (
		<BaseButton
			className={cn(
				"mx-2 my-1 flex cursor-pointer items-center rounded-lg",
				"bg-foreground/[0.03] text-foreground-secondary outline-none transition-colors",
				compact ? "gap-1.5 px-2 py-1.5 text-xs" : "gap-2 px-3 py-2.5 text-sm",
				"hover:bg-foreground/[0.06] hover:text-foreground",
			)}
			onClick={handleOpenCustomModelsFolder}
			type="button"
		>
			<HugeiconsIcon className="size-4 shrink-0" icon={FolderOpenIcon} />
			<span className="flex-1 truncate text-left">
				{t("openCustomModelsFolder")}
			</span>
			<span className="text-[10px] text-foreground-dim">
				{t("dropOnnxBundlesHere")}
			</span>
		</BaseButton>
	);
}

type EmptyStateReason = "filters" | "loading";

interface SuggestedEmptyHint {
	hiddenCount: number;
	onShowAll: () => void;
}

function EmptyState({
	reason,
	suggestedHint,
}: {
	reason: EmptyStateReason;
	suggestedHint: SuggestedEmptyHint | undefined;
}) {
	const t = useTranslations("modelPicker");
	return (
		<div className="mx-auto flex w-full max-w-[280px] flex-col items-center gap-2 px-4 py-8 text-center">
			<div className="flex size-10 items-center justify-center rounded-full bg-surface-secondary">
				<HugeiconsIcon
					className="size-5 text-foreground-muted"
					icon={ServerStack01Icon}
				/>
			</div>
			<p className="text-balance font-semibold text-body">
				{t("noModelsFound")}
			</p>
			<p className="text-balance text-foreground-muted text-xs-tight">
				{reason === "filters" ? t("emptyHintFilters") : t("emptyHintLoading")}
			</p>
			{suggestedHint ? (
				<BaseButton
					className={cn(
						"cursor-pointer text-balance text-accent text-xs-tight underline-offset-2 outline-none",
						"hover:underline focus-visible:underline",
					)}
					data-slot="suggested-hidden-hint"
					onClick={suggestedHint.onShowAll}
					type="button"
				>
					{t("suggestedHiddenHint", {
						count: suggestedHint.hiddenCount,
					})}
				</BaseButton>
			) : null}
		</div>
	);
}

type SttModelGroupsProps = Omit<
	SttModelListProps,
	| "hasActiveFilters"
	| "hasSearch"
	| "onShowAllSuggested"
	| "suggestedHiddenCount"
	| "visibleModelCount"
>;

/**
 * Model-group rendering is independent from query/empty-state presentation.
 * Keeping those concerns in separate components prevents search-state flags
 * from forming artificial combinations with per-model policy predicates.
 */
function SttModelGroups({
	compact = false,
	statesById,
	systemInfo,
	selectedId,
	currentQuantization,
	isFavorite,
	onSelect,
	onRequestDeleteQuant,
	canDeleteQuant,
	getDownloadSnapshot,
	getFitAssessment,
	getFittingQuants,
	onDownloadAction,
	expandedBundles,
	onToggleExpanded,
	onToggleFavorite,
	sortKey,
	suggestedFlattenActive = false,
}: SttModelGroupsProps) {
	return (
		<Combobox.List className={compact ? "p-0 pb-1" : "p-0 pb-2"}>
			{(group: SttListGroup) => {
				// An active sort flattens every maker into one ordered column —
				// rendered solo (the selector hands us just this group + hides
				// the rail), so there are no per-maker headers to fight with.
				if (isSortedGroup(group.value)) {
					return (
						<SortedGroup
							compact={compact}
							currentQuantization={currentQuantization}
							getDownloadSnapshot={getDownloadSnapshot}
							getFitAssessment={getFitAssessment}
							getFittingQuants={getFittingQuants}
							isFavorite={isFavorite}
							items={group.items}
							key={group.value}
							onDownloadAction={onDownloadAction}
							onRequestDeleteQuant={onRequestDeleteQuant}
							canDeleteQuant={canDeleteQuant}
							onSelect={onSelect}
							onToggleFavorite={onToggleFavorite}
							selectedId={selectedId}
							sortKey={sortKey}
							statesById={statesById}
							suggested={suggestedFlattenActive}
							systemInfo={systemInfo}
						/>
					);
				}
				// The synthetic Favorites group is maker-agnostic and flat —
				// rendered ahead of (and separately from) the per-maker groups.
				if (isFavoritesGroup(group.value)) {
					return (
						<FavoritesGroup
							compact={compact}
							currentQuantization={currentQuantization}
							getDownloadSnapshot={getDownloadSnapshot}
							getFitAssessment={getFitAssessment}
							getFittingQuants={getFittingQuants}
							isFavorite={isFavorite}
							items={group.items}
							key={group.value}
							onDownloadAction={onDownloadAction}
							onRequestDeleteQuant={onRequestDeleteQuant}
							canDeleteQuant={canDeleteQuant}
							onSelect={onSelect}
							onToggleFavorite={onToggleFavorite}
							selectedId={selectedId}
							statesById={statesById}
							systemInfo={systemInfo}
						/>
					);
				}
				// Bundling happens INSIDE the group render so it stays
				// responsive to the menu-filtered set the selector hands
				// us — a filter that hides a multilingual variant lets
				// its .en sibling render solo automatically.
				const family: FamilyKey = group.value;
				const bundles = bundleVariants(group.items);
				return (
					<Combobox.Group
						className="flex flex-col"
						items={group.items}
						key={group.value}
					>
						<AuthorLabel compact={compact} family={family} />
						{bundles.map((bundle) => (
							<SttVariantBundle
								compact={compact}
								bundle={bundle}
								currentQuantization={currentQuantization}
								expanded={expandedBundles.has(bundle.baseId)}
								getDownloadSnapshot={getDownloadSnapshot}
								getFitAssessment={getFitAssessment}
								getFittingQuants={getFittingQuants}
								isFavorite={isFavorite}
								key={bundle.baseId}
								onDownloadAction={onDownloadAction}
								onRequestDeleteQuant={onRequestDeleteQuant}
								canDeleteQuant={canDeleteQuant}
								onSelect={onSelect}
								onToggleExpanded={onToggleExpanded}
								onToggleFavorite={onToggleFavorite}
								// The WHOLE group, not `bundle.variants`: two models in
								// different bundles can still collide to the same name
								// once their size token is stripped.
								peers={group.items}
								selectedId={selectedId}
								statesById={statesById}
								systemInfo={systemInfo}
							/>
						))}
						{family === "custom" ? (
							<OpenCustomModelsFolderRow compact={compact} />
						) : null}
					</Combobox.Group>
				);
			}}
		</Combobox.List>
	);
}

export function SttModelList({
	hasActiveFilters,
	hasSearch = false,
	compact = false,
	onShowAllSuggested,
	suggestedHiddenCount = 0,
	visibleModelCount,
	...modelGroupsProps
}: SttModelListProps) {
	const reason: EmptyStateReason = hasActiveFilters ? "filters" : "loading";
	const suggestedHint =
		suggestedHiddenCount > 0 && onShowAllSuggested
			? {
					hiddenCount: suggestedHiddenCount,
					onShowAll: onShowAllSuggested,
				}
			: undefined;
	return (
		<ScrollArea
			className="min-h-0 flex-1"
			data-slot="stt-model-list-shell"
			rubberBandOnTouch={false}
			verticalOnly
			verticalScrollbarClassName={compact ? "mt-6 mb-0.5" : "mt-8 mb-1"}
			viewportClassName="flex min-h-0 flex-col"
		>
			<div className="flex min-h-full flex-col" data-slot="stt-model-list">
				{/* Live region for assistive tech — Combobox.Status content is
				announced politely (`aria-live="polite"`) every time the
				filtered count changes, so screen-reader users hear
				"3 models available" instead of guessing why their list
				shrank. Hidden visually via the `sr-only` utility. */}
				<Combobox.Status className="sr-only">
					{visibleModelCount === 1
						? "1 model available"
						: `${visibleModelCount} models available`}
				</Combobox.Status>
				<Combobox.Empty className="block">
					<EmptyState reason={reason} suggestedHint={suggestedHint} />
				</Combobox.Empty>
				{/* Base UI's Combobox.Empty only shows for an empty SEARCH result;
					when the menu filters (typically Suggested) empty the list with
					no query active, surface the same empty state manually so the
					"N models hidden by Suggested — tap to show all" escape hatch
					stays reachable. */}
				{!hasSearch && visibleModelCount === 0 ? (
					<EmptyState reason={reason} suggestedHint={suggestedHint} />
				) : null}
				<SttModelGroups {...modelGroupsProps} />
			</div>
		</ScrollArea>
	);
}
