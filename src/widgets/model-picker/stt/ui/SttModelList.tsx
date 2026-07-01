"use client";

import { Button as BaseButton } from "@base-ui/react/button";
import { Combobox } from "@base-ui/react/combobox";
import {
	ArrowUpDownIcon,
	FolderOpenIcon,
	ServerStack01Icon,
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
import { FavoritesGroupLabel } from "../../core/model-card/FavoritesGroupLabel";
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
import {
	type QuantDownloadAction,
	type QuantDownloadSnapshot,
	SttModelCard,
} from "./SttModelCard";
import { SttVariantBundle } from "./SttVariantBundle";

export interface SttModelListProps {
	currentQuantization: OnnxQuantization;
	/** Bundle base ids the user has currently expanded — owned by the selector. */
	expandedBundles: ReadonlySet<string>;
	/** Forwarded all the way down to ``PrecisionGroup``. */
	getDownloadSnapshot?:
		| ((
				modelId: string,
				quantization: OnnxQuantization,
		  ) => QuantDownloadSnapshot | undefined)
		| undefined;
	/** Optional live RAM/VRAM fit assessment lookup per model row. */
	getFitAssessment?:
		| ((modelId: string) => FitAssessmentEntry | null)
		| undefined;
	hasActiveFilters: boolean;
	/** Whether a model id is starred — forwarded to every card's favorite toggle. */
	isFavorite: (modelId: string) => boolean;
	/** Forwarded all the way down to ``PrecisionGroup``. */
	onDownloadAction?:
		| ((
				action: QuantDownloadAction,
				modelId: string,
				quantization: OnnxQuantization,
		  ) => void)
		| undefined;
	/** Forwarded down to the per-quant trash icon in each ``SttModelCard``. */
	onRequestDeleteQuant?:
		| ((
				modelId: string,
				quantization: OnnxQuantization,
				displayName: string,
				quantLabel: string,
		  ) => void)
		| undefined;
	/** Optional per-quant delete guard. */
	canDeleteQuant?:
		| ((modelId: string, quantization: OnnxQuantization) => boolean)
		| undefined;
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

function AuthorLabel({ family }: { family: FamilyKey }) {
	const config = getFamilyConfig(family);
	const author = getAuthorLabel(family);
	return (
		<Combobox.GroupLabel
			className="sticky top-0 z-raised flex items-center gap-2 border-border/60 border-b bg-surface-elevated/95 px-3 py-1.5 backdrop-blur-sm"
			data-rail-section={family}
		>
			{config.logoSrc ? (
				<img
					alt={`${author} logo`}
					className="size-4 shrink-0 rounded-[3px] object-contain"
					height={16}
					src={publicAsset(config.logoSrc)}
					width={16}
				/>
			) : (
				<span className="flex size-4 items-center justify-center rounded bg-foreground/[0.06] text-foreground-muted">
					<HugeiconsIcon className="size-3" icon={config.icon} />
				</span>
			)}
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
}: FavoritesGroupProps) {
	return (
		<Combobox.Group className="flex flex-col" items={items}>
			<FavoritesGroupLabel count={items.length} />
			{items.map((model) => (
				<SttModelCard
					currentQuantization={currentQuantization}
					fitAssessment={getFitAssessment?.(model.id) ?? null}
					getDownloadSnapshot={getDownloadSnapshot}
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
function SortedLabel({ sortKey }: { sortKey: SttSortKey | null }) {
	const t = useTranslations("modelPicker");
	// No `data-rail-section`: the maker rail is hidden while sorting, so we keep
	// the scroll-spy from latching onto this header and leaving the rail with no
	// active tile once the sort is cleared.
	return (
		<Combobox.GroupLabel className="sticky top-0 z-raised flex items-center gap-2 border-border/60 border-b bg-surface-elevated/95 px-3 py-1.5 backdrop-blur-sm">
			<span className="flex size-4 items-center justify-center rounded bg-foreground/[0.06] text-foreground-muted">
				<HugeiconsIcon className="size-3" icon={ArrowUpDownIcon} />
			</span>
			<span className="font-semibold text-[10px] text-foreground-muted uppercase tracking-[0.12em]">
				{t("sorted")}
			</span>
			{sortKey ? (
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
	systemInfo,
}: FavoritesGroupProps & { sortKey: SttSortKey | null }) {
	return (
		<Combobox.Group className="flex flex-col" items={items}>
			<SortedLabel sortKey={sortKey} />
			{items.map((model) => (
				<SttModelCard
					currentQuantization={currentQuantization}
					fitAssessment={getFitAssessment?.(model.id) ?? null}
					getDownloadSnapshot={getDownloadSnapshot}
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

function OpenCustomModelsFolderRow() {
	const t = useTranslations("modelPicker");
	return (
		<BaseButton
			className={cn(
				"mx-2 my-1 flex cursor-pointer items-center gap-2 rounded-lg",
				"bg-foreground/[0.03] px-3 py-2.5 text-foreground-secondary text-sm outline-none transition-colors",
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

function EmptyState({ hasActiveFilters }: { hasActiveFilters: boolean }) {
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
				{hasActiveFilters ? t("emptyHintFilters") : t("emptyHintLoading")}
			</p>
		</div>
	);
}

export function SttModelList({
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
	onDownloadAction,
	hasActiveFilters,
	expandedBundles,
	onToggleExpanded,
	onToggleFavorite,
	sortKey,
	visibleModelCount,
}: SttModelListProps) {
	return (
		<div
			className="flex min-h-0 flex-1 flex-col overflow-y-auto [overflow-y:overlay]"
			data-slot="stt-model-list"
		>
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
				<EmptyState hasActiveFilters={hasActiveFilters} />
			</Combobox.Empty>
			<Combobox.List className="p-0 pb-2">
				{(group: SttListGroup) => {
					// An active sort flattens every maker into one ordered column —
					// rendered solo (the selector hands us just this group + hides
					// the rail), so there are no per-maker headers to fight with.
					if (isSortedGroup(group.value)) {
						return (
							<SortedGroup
								currentQuantization={currentQuantization}
								getDownloadSnapshot={getDownloadSnapshot}
								getFitAssessment={getFitAssessment}
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
								systemInfo={systemInfo}
							/>
						);
					}
					// The synthetic Favorites group is maker-agnostic and flat —
					// rendered ahead of (and separately from) the per-maker groups.
					if (isFavoritesGroup(group.value)) {
						return (
							<FavoritesGroup
								currentQuantization={currentQuantization}
								getDownloadSnapshot={getDownloadSnapshot}
								getFitAssessment={getFitAssessment}
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
							<AuthorLabel family={family} />
							{bundles.map((bundle) => (
								<SttVariantBundle
									bundle={bundle}
									currentQuantization={currentQuantization}
									expanded={expandedBundles.has(bundle.baseId)}
									getDownloadSnapshot={getDownloadSnapshot}
									getFitAssessment={getFitAssessment}
									isFavorite={isFavorite}
									key={bundle.baseId}
									onDownloadAction={onDownloadAction}
									onRequestDeleteQuant={onRequestDeleteQuant}
									canDeleteQuant={canDeleteQuant}
									onSelect={onSelect}
									onToggleExpanded={onToggleExpanded}
									onToggleFavorite={onToggleFavorite}
									selectedId={selectedId}
									statesById={statesById}
									systemInfo={systemInfo}
								/>
							))}
							{family === "custom" ? <OpenCustomModelsFolderRow /> : null}
						</Combobox.Group>
					);
				}}
			</Combobox.List>
		</div>
	);
}
