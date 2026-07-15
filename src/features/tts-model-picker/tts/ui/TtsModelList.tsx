"use client";

import { Button as BaseButton } from "@base-ui/react/button";
import { Combobox } from "@base-ui/react/combobox";
import { ServerStack01Icon, SparklesIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import type { TtsModelInfo, TtsModelState } from "@/entities/tts-catalog";
import { cn } from "@/shared/lib/cn";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { isFavoritesGroupValue } from "@/shared/ui/model-picker/core/favorites";
import { GROUP_HEADER_CLASSES } from "@/shared/ui/model-picker/core/model-card/card-constants";
import { FavoritesGroupLabel } from "@/shared/ui/model-picker/core/model-card/FavoritesGroupLabel";
import {
	type TtsEngineKey,
	type TtsListGroup,
	TTS_SORTED_GROUP_VALUE,
	getEngineLabel,
	getEngineMaker,
} from "@/entities/tts-catalog";
import { TTS_SORT_HEADER_LABEL, type TtsSortValue } from "../lib/sort-state";
import { TtsMakerLogo } from "./TtsMakerLogo";
import {
	type QuantDownloadAction,
	type QuantDownloadSnapshot,
	TtsModelCard,
} from "./TtsModelCard";

export interface TtsModelListProps {
	currentQuantization: string;
	getDownloadSnapshot?:
		| ((
				modelId: string,
				quantization: string,
		  ) => QuantDownloadSnapshot | undefined)
		| undefined;
	/** Per-quant Suggested gating (only while the flag is ON): the fitting
	 *  quant set per model id, `null` = no verdict for that model. */
	getFittingQuants?:
		| ((modelId: string) => ReadonlySet<string> | null)
		| undefined;
	hasActiveFilters: boolean;
	/** Whether a text query is active. Base UI's `Combobox.Empty` only renders
	 *  for an empty SEARCH result, so the query-less "Suggested hid everything"
	 *  empty state is rendered manually — this flag keeps the two exclusive. */
	hasSearch?: boolean | undefined;
	/** Disables the Suggested flag — the empty-state "show all" tap. */
	onShowAllSuggested?: (() => void) | undefined;
	/** Suggested ON with no explicit sort — the flat column carries the
	 *  "Suggested · best for your machine" header instead of a sort label. */
	suggestedFlattenActive?: boolean | undefined;
	/** How many models the Suggested flag alone hides (empty-state hint). */
	suggestedHiddenCount?: number | undefined;
	isFavorite: (modelId: string) => boolean;
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
	onSelect: (modelId: string, quantization?: string) => void;
	onToggleFavorite: (modelId: string) => void;
	selectedId: string | undefined;
	statesById: Record<string, TtsModelState>;
	sort: TtsSortValue;
	/** Total filtered model count — read aloud via Combobox.Status. */
	visibleModelCount: number;
}

/** Sticky engine group header — same chrome as the STT `AuthorLabel` so headers
 *  dock identically while scrolling, carrying `data-rail-section` for the rail
 *  jump + scroll-spy. */
function EngineLabel({ engine }: { engine: TtsEngineKey }) {
	return (
		<Combobox.GroupLabel
			className={GROUP_HEADER_CLASSES}
			data-rail-section={engine}
		>
			<TtsMakerLogo engine={engine} />
			<span className="font-semibold text-[10px] text-foreground-muted uppercase tracking-[0.12em]">
				{getEngineMaker(engine)}
			</span>
			<span className="text-[10px] text-foreground-dim">
				· {getEngineLabel(engine)}
			</span>
		</Combobox.GroupLabel>
	);
}

function EmptyState({
	hasActiveFilters,
	onShowAllSuggested,
	suggestedHiddenCount = 0,
}: {
	hasActiveFilters: boolean;
	onShowAllSuggested?: (() => void) | undefined;
	suggestedHiddenCount?: number | undefined;
}) {
	const t = useTranslations("modelPicker");
	const showSuggestedHint = suggestedHiddenCount > 0 && onShowAllSuggested;
	return (
		<div className="mx-auto flex w-full max-w-[280px] flex-col items-center gap-2 px-4 py-8 text-center">
			<div className="flex size-10 items-center justify-center rounded-full bg-surface-secondary">
				<HugeiconsIcon
					className="size-5 text-foreground-muted"
					icon={ServerStack01Icon}
				/>
			</div>
			<p className="text-balance font-semibold text-body">
				{t("noVoicesFound")}
			</p>
			<p className="text-balance text-foreground-muted text-xs-tight">
				{hasActiveFilters ? t("emptyHintFilters") : t("emptyHintLoading")}
			</p>
			{showSuggestedHint ? (
				<BaseButton
					className={cn(
						"cursor-pointer text-balance text-accent text-xs-tight underline-offset-2 outline-none",
						"hover:underline focus-visible:underline",
					)}
					data-slot="suggested-hidden-hint"
					onClick={onShowAllSuggested}
					type="button"
				>
					{t("suggestedHiddenHint", { count: suggestedHiddenCount })}
				</BaseButton>
			) : null}
		</div>
	);
}

/**
 * Header for the synthetic flat sorted group. An explicit sort spells out its
 * dimension ("Quality · highest first"); the Suggested flatten (flag ON, no
 * explicit sort) carries "Suggested · best for your machine" with the sparkle
 * glyph — mirroring the STT list's `SortedLabel`.
 */
function SortedLabel({
	sort,
	suggested,
}: {
	sort: TtsSortValue;
	suggested: boolean;
}) {
	const t = useTranslations("modelPicker");
	const isSuggestedHeader = sort === null && suggested;
	if (isSuggestedHeader) {
		return (
			<Combobox.GroupLabel className={GROUP_HEADER_CLASSES}>
				<span className="flex size-4 items-center justify-center rounded bg-foreground/[0.06] text-foreground-muted">
					<HugeiconsIcon className="size-3" icon={SparklesIcon} />
				</span>
				<span className="font-semibold text-[10px] text-foreground-muted uppercase tracking-[0.12em]">
					{t("suggested")}
				</span>
				<span className="text-[10px] text-foreground-dim">
					· {t("suggestedSortHeader")}
				</span>
			</Combobox.GroupLabel>
		);
	}
	if (sort === null) {
		return null;
	}
	return (
		<Combobox.GroupLabel className={GROUP_HEADER_CLASSES}>
			<span className="font-semibold text-[10px] text-foreground-muted uppercase tracking-[0.12em]">
				{TTS_SORT_HEADER_LABEL[sort]}
			</span>
		</Combobox.GroupLabel>
	);
}

/** The per-card props every group (engine + the synthetic Favorites) forwards
 *  to its cards — shared so both branches map cards identically. */
type ModelCardsProps = Pick<
	TtsModelListProps,
	| "currentQuantization"
	| "getDownloadSnapshot"
	| "getFittingQuants"
	| "isFavorite"
	| "onDownloadAction"
	| "onRequestDeleteQuant"
	| "onSelect"
	| "onToggleFavorite"
	| "selectedId"
	| "statesById"
> & { items: readonly TtsModelInfo[] };

/** Maps a group's models to flat {@link TtsModelCard}s. One definition shared by
 *  the per-engine groups and the synthetic Favorites group (DRY). */
function ModelCards({ items, statesById, ...rest }: ModelCardsProps) {
	return (
		<>
			{items.map((model) => (
				<TtsModelCard
					currentQuantization={rest.currentQuantization}
					getDownloadSnapshot={rest.getDownloadSnapshot}
					getFittingQuants={rest.getFittingQuants}
					isFavorite={rest.isFavorite}
					key={model.id}
					model={model}
					onDownloadAction={rest.onDownloadAction}
					onRequestDeleteQuant={rest.onRequestDeleteQuant}
					onSelect={rest.onSelect}
					onToggleFavorite={rest.onToggleFavorite}
					selectedId={rest.selectedId}
					state={statesById[model.id]}
				/>
			))}
		</>
	);
}

/** The grouped TTS model list. Each engine renders as a sticky-header section of
 *  flat {@link TtsModelCard}s — no variant bundling (TTS engines ship distinct
 *  models, not Whisper-style `.en` siblings). Starred models are repeated in a
 *  synthetic "Favorites" group pinned to the top, mirroring the STT picker. */
export function TtsModelList({
	statesById,
	selectedId,
	currentQuantization,
	isFavorite,
	onSelect,
	onRequestDeleteQuant,
	getDownloadSnapshot,
	getFittingQuants,
	onDownloadAction,
	hasActiveFilters,
	hasSearch = false,
	onShowAllSuggested,
	onToggleFavorite,
	suggestedFlattenActive = false,
	suggestedHiddenCount = 0,
	visibleModelCount,
	sort,
}: TtsModelListProps) {
	return (
		<ScrollArea
			className="min-h-0 flex-1"
			data-slot="tts-model-list-shell"
			rubberBandOnTouch={false}
			verticalOnly
			verticalScrollbarClassName="mt-8 mb-1"
			viewportClassName="flex min-h-0 flex-col"
		>
			<div className="flex min-h-full flex-col" data-slot="tts-model-list">
				<Combobox.Status className="sr-only">
					{visibleModelCount === 1
						? "1 voice available"
						: `${visibleModelCount} voices available`}
				</Combobox.Status>
				<Combobox.Empty className="block">
					<EmptyState
						hasActiveFilters={hasActiveFilters}
						onShowAllSuggested={onShowAllSuggested}
						suggestedHiddenCount={suggestedHiddenCount}
					/>
				</Combobox.Empty>
				{/* Base UI's Combobox.Empty only shows for an empty SEARCH result;
				    when the menu filters (typically Suggested) empty the list with
				    no query active, surface the same empty state manually so the
				    "N models hidden by Suggested — tap to show all" escape hatch
				    stays reachable. */}
				{!hasSearch && visibleModelCount === 0 ? (
					<EmptyState
						hasActiveFilters={hasActiveFilters}
						onShowAllSuggested={onShowAllSuggested}
						suggestedHiddenCount={suggestedHiddenCount}
					/>
				) : null}
				<Combobox.List className="p-0 pb-2">
					{(group: TtsListGroup) => (
						<Combobox.Group
							className="flex flex-col"
							items={group.items}
							key={group.value}
						>
							{group.value === TTS_SORTED_GROUP_VALUE ? (
								<SortedLabel sort={sort} suggested={suggestedFlattenActive} />
							) : isFavoritesGroupValue(group.value) ? (
								<FavoritesGroupLabel
									count={group.items.length}
									noun="voice model"
								/>
							) : (
								<EngineLabel engine={group.value} />
							)}
							<ModelCards
								currentQuantization={currentQuantization}
								getDownloadSnapshot={getDownloadSnapshot}
								getFittingQuants={getFittingQuants}
								isFavorite={isFavorite}
								items={group.items}
								onDownloadAction={onDownloadAction}
								onRequestDeleteQuant={onRequestDeleteQuant}
								onSelect={onSelect}
								onToggleFavorite={onToggleFavorite}
								selectedId={selectedId}
								statesById={statesById}
							/>
						</Combobox.Group>
					)}
				</Combobox.List>
			</div>
		</ScrollArea>
	);
}
