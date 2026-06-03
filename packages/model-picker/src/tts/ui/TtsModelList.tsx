"use client";

import { Combobox } from "@base-ui/react/combobox";
import { ServerStack01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { TtsModelInfo, TtsModelState } from "@/entities/tts-catalog";
import { isFavoritesGroupValue } from "../../core/favorites";
import { FavoritesGroupLabel, GROUP_HEADER_CLASSES } from "../../core/model-card";
import {
	type TtsEngineKey,
	type TtsListGroup,
	getEngineLabel,
	getEngineMaker,
} from "../lib/tts-helpers";
import { TtsMakerLogo } from "./TtsMakerLogo";
import { type QuantDownloadAction, type QuantDownloadSnapshot, TtsModelCard } from "./TtsModelCard";

export interface TtsModelListProps {
	currentQuantization: string;
	getDownloadSnapshot?:
		| ((modelId: string, quantization: string) => QuantDownloadSnapshot | undefined)
		| undefined;
	hasActiveFilters: boolean;
	isFavorite: (modelId: string) => boolean;
	onDownloadAction?:
		| ((action: QuantDownloadAction, modelId: string, quantization: string) => void)
		| undefined;
	onRequestDeleteQuant?:
		| ((modelId: string, quantization: string, displayName: string, quantLabel: string) => void)
		| undefined;
	onSelect: (modelId: string, quantization?: string) => void;
	onToggleFavorite: (modelId: string) => void;
	selectedId: string | undefined;
	statesById: Record<string, TtsModelState>;
	/** Total filtered model count — read aloud via Combobox.Status. */
	visibleModelCount: number;
}

/** Sticky engine group header — same chrome as the STT `AuthorLabel` so headers
 *  dock identically while scrolling, carrying `data-rail-section` for the rail
 *  jump + scroll-spy. */
function EngineLabel({ engine }: { engine: TtsEngineKey }) {
	return (
		<Combobox.GroupLabel className={GROUP_HEADER_CLASSES} data-rail-section={engine}>
			<TtsMakerLogo engine={engine} />
			<span className="font-semibold text-[10px] text-foreground-muted uppercase tracking-[0.12em]">
				{getEngineMaker(engine)}
			</span>
			<span className="text-[10px] text-foreground-dim">· {getEngineLabel(engine)}</span>
		</Combobox.GroupLabel>
	);
}

function EmptyState({ hasActiveFilters }: { hasActiveFilters: boolean }) {
	return (
		<div className="mx-auto flex w-full max-w-[280px] flex-col items-center gap-2 px-4 py-8 text-center">
			<div className="flex size-10 items-center justify-center rounded-full bg-surface-secondary">
				<HugeiconsIcon className="size-5 text-foreground-muted" icon={ServerStack01Icon} />
			</div>
			<p className="text-balance font-semibold text-body">No voices found</p>
			<p className="text-balance text-foreground-muted text-xs-tight">
				{hasActiveFilters
					? "Try clearing filters or adjusting your search."
					: "Waiting for the catalog to load…"}
			</p>
		</div>
	);
}

/** The per-card props every group (engine + the synthetic Favorites) forwards
 *  to its cards — shared so both branches map cards identically. */
type ModelCardsProps = Pick<
	TtsModelListProps,
	| "currentQuantization"
	| "getDownloadSnapshot"
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
	onDownloadAction,
	hasActiveFilters,
	onToggleFavorite,
	visibleModelCount,
}: TtsModelListProps) {
	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-slot="tts-model-list">
			<Combobox.Status className="sr-only">
				{visibleModelCount === 1 ? "1 voice available" : `${visibleModelCount} voices available`}
			</Combobox.Status>
			<Combobox.Empty className="block">
				<EmptyState hasActiveFilters={hasActiveFilters} />
			</Combobox.Empty>
			<Combobox.List className="p-0 pb-2">
				{(group: TtsListGroup) => (
					<Combobox.Group className="flex flex-col" items={group.items} key={group.value}>
						{isFavoritesGroupValue(group.value) ? (
							<FavoritesGroupLabel count={group.items.length} noun="voice model" />
						) : (
							<EngineLabel engine={group.value} />
						)}
						<ModelCards
							currentQuantization={currentQuantization}
							getDownloadSnapshot={getDownloadSnapshot}
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
	);
}
