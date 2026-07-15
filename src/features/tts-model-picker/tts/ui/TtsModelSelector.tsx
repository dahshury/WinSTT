"use client";

import { Combobox } from "@base-ui/react/combobox";
import {
	ArrowDown01Icon,
	BinaryCodeIcon,
	Copy01Icon,
	GlobeIcon,
	HardDriveDownloadIcon,
	UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	type ComponentPropsWithoutRef,
	type MouseEvent,
	type ReactNode,
	useEffect,
	useReducer,
	useState,
} from "react";
import type { ModelSuggestion } from "@/entities/model-suggestion";
import {
	type TtsModelInfo,
	type TtsModelState,
	type TtsSwapTransition,
	useTtsSwapStore,
} from "@/entities/tts-catalog";
import { formatBytes } from "@/shared/lib/format-bytes";
import { matchesFuzzySearch } from "@/shared/lib/fuzzy-search";
import {
	rankGroupsBySearch,
	type SearchRankable,
} from "@/shared/lib/model-search";
import { Button } from "@/shared/ui/button";
import { ModelSpecHoverCard } from "@/shared/ui/model-spec-card";
import { PulseDot } from "@/shared/ui/pulse-dot";
import {
	buildSwitchingClassName,
	MODEL_TRIGGER_GLASS_CLASSES,
	SwapSweepBar,
	SwitchingFromToRow,
	SwitchingPill,
	SwitchingQuantBadge,
} from "@/shared/ui/switching-trigger";
import {
	GroupRail,
	type GroupRailItem,
	RailIconChip,
} from "@/shared/ui/model-picker/core/GroupRail";
import {
	ALL_AUTHORS_RAIL_ID,
	buildAllAuthorsRailItem,
} from "@/shared/ui/model-picker/core/group-rail-items";
import { makeNameComparator } from "@/shared/ui/model-picker/core/lib/sort-state";
import { ModelPicker } from "@/shared/ui/model-picker/core/ModelPicker";
import { useFavoriteSet } from "@/shared/ui/model-picker/core/use-favorite-set";
import { SuggestedFilterChip } from "@/shared/ui/model-picker/ui/SuggestedFilterChip";
import { useModelPickerCloseGuard } from "@/shared/ui/model-picker/lib/model-picker-close-guard";
import {
	readPersistedSelectorState,
	writePersistedSelectorState,
} from "@/shared/lib/persisted-selector-state";
import { publicAsset } from "@/shared/lib/public-asset";
import { STT_PICKER_WIDTH_CLASS } from "@/shared/ui/model-picker/lib/dimensions";
import {
	collectTtsLanguages,
	collectTtsQuantizations,
	EMPTY_TTS_FILTER_STATE,
	filterTtsModels,
	hasActiveTtsFilters,
	isTtsFilterState,
	normalizeTtsFilterState,
	type PersistedTtsFilterState,
	type TtsFilterState,
} from "../lib/filter-state";
import {
	sortTtsModels,
	TTS_SORT_KEYS,
	type TtsSortValue,
} from "../lib/sort-state";
import {
	buildTtsSearchCorpus,
	cloningLabel,
	getEngineConfig,
	getEngineLabel,
	getEngineLogoSrc,
	getEngineMaker,
	groupModelsByEngine,
	ttsLanguageMeta,
	type TtsListGroup,
	TTS_SORTED_GROUP_VALUE,
	withTtsFavoritesGroup,
} from "@/entities/tts-catalog";
import { buildTtsSpec } from "../lib/build-tts-spec";
import {
	type TtsPendingDelete,
	TtsDeleteQuantConfirmDialog,
} from "./TtsDeleteQuantConfirmDialog";
import { AuthorBadge } from "@/shared/ui/model-picker/ui/AuthorBadge";
import {
	SelectedModelSummary,
	type SelectedModelMetaItem,
} from "@/shared/ui/model-picker/ui/SelectedModelSummary";
import { TtsModelList } from "./TtsModelList";
import { TtsFiltersMenu } from "./TtsFiltersMenu";
import type {
	QuantDownloadAction,
	QuantDownloadSnapshot,
} from "./TtsModelCard";

type TtsModelChange = (modelId: string, quantization?: string) => void;

interface TtsTriggerDownloadProgress {
	averagePercent: number | null;
	count: number;
	modelId: string;
	percent: number | null;
}

const DEFAULT_TTS_POPUP_HEIGHT = "h-[min(620px,var(--available-height))]";
const DEFAULT_TTS_POPUP_WIDTH = STT_PICKER_WIDTH_CLASS;
const TTS_SELECTOR_UI_STORAGE_KEY = "winstt:model-picker:tts-ui";

export interface TtsModelSelectorProps {
	currentQuantization: string;
	disabled?: boolean;
	/** Render as an inline panel (no trigger/popup) that fills its host — used by
	 *  a detached picker window. */
	inline?: boolean;
	isLoading?: boolean;
	models: readonly TtsModelInfo[];
	onChange: TtsModelChange;
	/** When set, the trigger opens a detached picker window (passing its
	 *  on-screen rect) INSTEAD of the in-window popup — used by the settings
	 *  panel so the picker can extend beyond the settings window, the same way
	 *  the STT main picker does. The inline popup is fully suppressed in this
	 *  mode. Ignored when `inline` is set (the detached window renders inline). */
	onOpenDetached?: (rect: DOMRect) => void;
	/** Per-quant delete handler — fired after the user confirms in the
	 *  selector-level alert dialog. When omitted, no trash icon is rendered. */
	onDeleteQuant?: (modelId: string, quantization: string) => void;
	/** Per-quant download action — start / pause / resume / cancel. */
	onDownloadAction?: (
		action: QuantDownloadAction,
		modelId: string,
		quantization: string,
	) => void;
	/** Per-quant download snapshot lookup (active downloads only). */
	onDownloadSnapshot?: (
		modelId: string,
		quantization: string,
	) => QuantDownloadSnapshot | undefined;
	/** Host-computed Suggested verdict per model (spec-based recommender:
	 *  per-quant fit against the cross-modality memory budgets + the language
	 *  DE-RANK). `undefined` = the host has no verdict yet (budgets not
	 *  loaded) or doesn't participate — the Suggested filter is then inert
	 *  and its chip hidden. Threaded the same way as the STT picker's
	 *  `getSuggestion`. */
	getSuggestion?: ((modelId: string) => ModelSuggestion | null) | undefined;
	placeholder?: string;
	popupHeightClass?: string;
	popupWidthClass?: string;
	statesById: Record<string, TtsModelState>;
	/** Replaces the default trigger (e.g. a compact status-bar chip). Must render
	 *  a `Combobox.Trigger` internally. */
	trigger?: ReactNode;
	value: string;
}

interface TtsSelectorUiState {
	activeRailId: string | null;
	filters: TtsFilterState;
	open: boolean;
	/** Text-search query, owned here (not inside `ModelPicker`) so a query can
	 *  span ALL authors — it overrides the active rail, so e.g. "piper" finds
	 *  Piper voices even while the Kokoro rail is selected. Mirrors the STT
	 *  picker's lifted-search fix. */
	search: string;
	sort: TtsSortValue;
}

interface PersistedTtsSelectorUiState {
	activeRailId: string | null;
	/** May predate the `suggestedOnly` flag — normalized (missing key → ON)
	 *  via {@link normalizeTtsFilterState} on read. */
	filters?: PersistedTtsFilterState;
	sort?: TtsSortValue;
}

const DEFAULT_PERSISTED_TTS_SELECTOR_UI_STATE: PersistedTtsSelectorUiState = {
	activeRailId: ALL_AUTHORS_RAIL_ID,
};

function isPersistedTtsSelectorUiState(
	value: unknown,
): value is PersistedTtsSelectorUiState {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as Partial<PersistedTtsSelectorUiState>;
	return (
		(candidate.activeRailId === null ||
			typeof candidate.activeRailId === "string") &&
		(candidate.filters === undefined || isTtsFilterState(candidate.filters)) &&
		(candidate.sort === undefined ||
			candidate.sort === null ||
			TTS_SORT_KEYS.includes(candidate.sort))
	);
}

type TtsSelectorUiAction =
	| { id: string | null; type: "setActiveRailId" }
	| { filters: TtsFilterState; type: "setFilters" }
	| { open: boolean; type: "setOpen" }
	| { search: string; type: "setSearch" }
	| { sort: TtsSortValue; type: "setSort" };

function uiReducer(
	state: TtsSelectorUiState,
	action: TtsSelectorUiAction,
): TtsSelectorUiState {
	switch (action.type) {
		case "setActiveRailId":
			return state.activeRailId === action.id
				? state
				: { ...state, activeRailId: action.id };
		case "setOpen":
			return state.open === action.open
				? state
				: { ...state, open: action.open };
		case "setSearch":
			return state.search === action.search
				? state
				: { ...state, search: action.search };
		case "setFilters":
			return { ...state, filters: action.filters };
		case "setSort":
			return state.sort === action.sort
				? state
				: { ...state, sort: action.sort };
		default:
			return state;
	}
}

/** Maker-rail tiles: the pinned All authors tile + one tile per engine, each
 *  showing the maker's brand logo (the glyph chip is only the fallback for an
 *  engine that ships no logo). Mirrors the STT rail. */
function buildRailItems(
	groups: readonly TtsListGroup[],
	allModelCount: number,
): GroupRailItem[] {
	const items: GroupRailItem[] = [buildAllAuthorsRailItem(allModelCount)];
	for (const group of groups) {
		const engine = group.value;
		const logoSrc = getEngineLogoSrc(engine);
		items.push({
			id: engine,
			label: `${getEngineMaker(engine)} · ${getEngineLabel(engine)}`,
			badge: group.items.length,
			icon: logoSrc ? (
				<img
					alt=""
					className="size-5 rounded-[3px] object-contain"
					height={20}
					src={publicAsset(logoSrc)}
					width={20}
				/>
			) : (
				<RailIconChip>
					<HugeiconsIcon
						className="size-3"
						icon={getEngineConfig(engine).icon}
					/>
				</RailIconChip>
			),
		});
	}
	return items;
}

/** The connected spec badge for the closed TTS trigger — the TTS analogue of the
 *  STT / Ollama meta: capability glyphs (multilingual, voice cloning) lead as
 *  icon-only segments, then the numeric facts (voices · quant · size). Voices is
 *  the TTS-distinctive count that stands in for the STT picker's parameter chip. */
function selectedTtsMeta(
	model: TtsModelInfo,
	currentQuantization: string,
	state: TtsModelState | undefined,
): SelectedModelMetaItem[] {
	const effectiveQuant =
		currentQuantization === ""
			? (state?.effectiveQuantization ?? model.availableQuantizations[0] ?? "")
			: currentQuantization;
	const bytes =
		model.sizeBytesByQuantization[effectiveQuant] ??
		model.sizeBytesByQuantization[currentQuantization] ??
		state?.estimatedBytes ??
		null;
	const sizeLabel = bytes && bytes > 0 ? formatBytes(bytes) : null;
	const items: SelectedModelMetaItem[] = [];
	if (model.languages.length > 1) {
		items.push({
			key: "multilingual",
			label: "",
			icon: GlobeIcon,
			tone: "teal",
			title: "Multilingual",
			description: ttsLanguageMeta(model.languages).tooltip,
		});
	}
	const cloning = cloningLabel(model.cloning);
	if (cloning) {
		items.push({
			key: "cloning",
			label: "",
			icon: Copy01Icon,
			tone: "accent",
			title: cloning.label,
			description: cloning.tooltip,
		});
	}
	const voiceLabel =
		model.numVoices === 1 ? "1 voice" : `${model.numVoices} voices`;
	items.push({
		key: "voices",
		label: voiceLabel,
		icon: UserMultiple02Icon,
		title: "Voices",
		description: `${voiceLabel} bundled with this model`,
	});
	items.push({
		key: "quant",
		label: effectiveQuant === "" ? "Auto" : effectiveQuant.toUpperCase(),
		icon: BinaryCodeIcon,
		tone: "warning",
		title: "Selected quantization",
	});
	if (sizeLabel) {
		items.push({
			key: "size",
			label: sizeLabel,
			icon: HardDriveDownloadIcon,
			tone: "success",
			title: "Download size",
			description: `Download size: ${sizeLabel}`,
		});
	}
	return items;
}

/** TTS quant label for the switching badge — mirrors the selected-model meta
 *  chip (`"" → Auto`, else upper-cased). */
function ttsQuantLabel(quant: string): string {
	return quant === "" ? "Auto" : quant.toUpperCase();
}

/** Engine/maker chip — the same {@link AuthorBadge} the selected summary uses. */
function TtsEngineChip({
	engine,
	muted = false,
}: {
	engine: TtsModelInfo["engine"];
	muted?: boolean;
}) {
	const logo = getEngineLogoSrc(engine);
	return (
		<AuthorBadge
			icon={getEngineConfig(engine).icon}
			label={getEngineLabel(engine)}
			logoSrc={logo ? publicAsset(logo) : null}
			muted={muted}
		/>
	);
}

/** Engine chip + name slot used inside `SwitchingFromToRow`. Dim + struck on the
 *  `from` leg, accent-emphasized on the `to` leg — mirrors the STT trigger. */
function TtsSwitchingLabel({
	displayName,
	engine,
	side,
}: {
	displayName: string;
	engine: TtsModelInfo["engine"] | undefined;
	side: "from" | "to";
}) {
	const nameClass =
		side === "from"
			? "min-w-0 max-w-[8rem] truncate font-medium text-body text-foreground-dim leading-tight tracking-tight line-through decoration-foreground-dim/40"
			: "min-w-0 truncate font-semibold text-accent text-body leading-tight tracking-tight";
	return (
		<>
			{engine ? (
				<TtsEngineChip engine={engine} muted={side === "from"} />
			) : null}
			<span className={nameClass}>{displayName}</span>
		</>
	);
}

/** The in-flight swap row for the TTS trigger. A pure precision swap (same model
 *  on both legs) collapses to `model · FP16 → INT4`; a model change shows the
 *  `from → to` model row with the target precision appended. */
function TtsSwitchingBody({
	active,
	ariaLabel,
	models,
	selectedModel,
}: {
	active: TtsSwapTransition;
	ariaLabel: string | undefined;
	models: readonly TtsModelInfo[];
	selectedModel: TtsModelInfo | undefined;
}) {
	const toModel =
		models.find((m) => m.id === active.toModelId) ?? selectedModel;
	const fromModel = active.fromModelId
		? models.find((m) => m.id === active.fromModelId)
		: undefined;
	const sameModel = active.fromModelId === active.toModelId;
	const quantBadge =
		active.toQuant === null ? null : (
			<SwitchingQuantBadge
				from={
					active.fromQuant === null
						? undefined
						: ttsQuantLabel(active.fromQuant)
				}
				to={ttsQuantLabel(active.toQuant)}
			/>
		);
	// Pure precision swap → model once + the precision transition.
	if (sameModel && quantBadge && toModel) {
		return (
			<output
				aria-label={ariaLabel}
				aria-live="polite"
				className="flex min-w-0 flex-1 items-center gap-1.5"
				data-slot="tts-switching-quant"
			>
				<TtsEngineChip engine={toModel.engine} />
				<span className="min-w-0 truncate font-semibold text-body text-foreground leading-tight tracking-tight">
					{toModel.displayName}
				</span>
				<PulseDot className="size-2.5 shrink-0 text-accent" />
				{quantBadge}
			</output>
		);
	}
	return (
		<SwitchingFromToRow
			ariaLabel={ariaLabel}
			from={
				fromModel ? (
					<TtsSwitchingLabel
						displayName={fromModel.displayName}
						engine={fromModel.engine}
						side="from"
					/>
				) : undefined
			}
			to={
				<span className="flex min-w-0 items-center gap-1.5">
					<TtsSwitchingLabel
						displayName={toModel?.displayName ?? active.toModelId}
						engine={toModel?.engine}
						side="to"
					/>
					{active.toQuant === null ? null : (
						<SwitchingQuantBadge to={ttsQuantLabel(active.toQuant)} />
					)}
				</span>
			}
		/>
	);
}

function ttsSwitchingAriaLabel(
	active: TtsSwapTransition,
	models: readonly TtsModelInfo[],
): string {
	const toName =
		models.find((m) => m.id === active.toModelId)?.displayName ??
		active.toModelId;
	if (active.fromModelId === active.toModelId && active.toQuant !== null) {
		const from =
			active.fromQuant === null
				? ""
				: ` from ${ttsQuantLabel(active.fromQuant)}`;
		return `Switching ${toName} precision${from} to ${ttsQuantLabel(active.toQuant)}`;
	}
	const quant =
		active.toQuant === null ? "" : ` at ${ttsQuantLabel(active.toQuant)}`;
	return `Switching to ${toName}${quant}`;
}

/** Default glass-card-ish trigger — engine chip + display name + the connected
 *  spec badge (right-aligned), sharing the STT / Ollama badge strategy. During a
 *  model / precision swap it flips to the shared switching view (from → to +
 *  `FP16 → INT4` badge), matching the STT and Ollama triggers. */
function TtsTriggerBody({
	selectedModel,
	placeholder,
	currentQuantization,
	state,
}: {
	currentQuantization: string;
	placeholder: string;
	selectedModel: TtsModelInfo | undefined;
	state: TtsModelState | undefined;
}) {
	if (!selectedModel) {
		return (
			<span className="font-medium text-body text-foreground-muted italic tracking-tight">
				{placeholder}
			</span>
		);
	}
	const engineLogo = getEngineLogoSrc(selectedModel.engine);
	return (
		<ModelSpecHoverCard spec={buildTtsSpec(selectedModel)}>
			<div className="flex min-w-0 flex-1">
				<SelectedModelSummary
					leading={
						<AuthorBadge
							icon={getEngineConfig(selectedModel.engine).icon}
							label={getEngineLabel(selectedModel.engine)}
							logoSrc={engineLogo ? publicAsset(engineLogo) : null}
						/>
					}
					meta={selectedTtsMeta(selectedModel, currentQuantization, state)}
					metaPlacement="right"
					name={{
						full: selectedModel.displayName,
						main: selectedModel.displayName,
					}}
				/>
			</div>
		</ModelSpecHoverCard>
	);
}

/** Collapse the per-quant badge snapshots into the single status surface in the
 * closed selector. This deliberately mirrors the STT trigger's aggregate view:
 * one download names its model, while concurrent downloads show a count and
 * their mean progress. */
function summarizeTtsDownloads(
	models: readonly TtsModelInfo[],
	getSnapshot: TtsModelSelectorProps["onDownloadSnapshot"],
): TtsTriggerDownloadProgress | null {
	if (!getSnapshot) {
		return null;
	}
	const active: Array<{ modelId: string; percent: number | null }> = [];
	for (const model of models) {
		for (const quant of model.availableQuantizations) {
			const snapshot = getSnapshot(model.id, quant);
			if (snapshot) {
				active.push({ modelId: model.id, percent: snapshot.progress });
			}
		}
	}
	const primary = active[0];
	if (!primary) {
		return null;
	}
	const knownPercents = active.flatMap(({ percent }) =>
		percent === null ? [] : [percent],
	);
	return {
		modelId: primary.modelId,
		percent: primary.percent,
		count: active.length,
		averagePercent:
			knownPercents.length === active.length
				? Math.round(
						knownPercents.reduce((sum, percent) => sum + percent, 0) /
							knownPercents.length,
					)
				: null,
	};
}

function TtsDownloadingBody({
	currentQuantization,
	download,
	models,
	placeholder,
	selectedModel,
	state,
}: {
	currentQuantization: string;
	download: TtsTriggerDownloadProgress;
	models: readonly TtsModelInfo[];
	placeholder: string;
	selectedModel: TtsModelInfo | undefined;
	state: TtsModelState | undefined;
}) {
	const target = models.find((model) => model.id === download.modelId);
	const multi = download.count >= 2;
	const targetLabel = multi
		? `${download.count} downloads`
		: (target?.displayName ?? "model");
	const percent = multi ? download.averagePercent : download.percent;
	return (
		<output
			aria-live="polite"
			className="flex min-w-0 flex-1 items-center gap-2"
			data-slot="tts-downloading-body"
		>
			<TtsTriggerBody
				currentQuantization={currentQuantization}
				placeholder={placeholder}
				selectedModel={selectedModel}
				state={state}
			/>
			<span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-surface-secondary/60 px-2 py-0.5 font-medium text-[10px] text-foreground-secondary leading-none">
				<PulseDot className="size-1.5 text-accent" />
				<span className="truncate">↓ {targetLabel}</span>
				<span className="font-mono text-foreground tabular-nums">
					{percent === null ? "Starting…" : `${percent}%`}
				</span>
			</span>
		</output>
	);
}

function TtsTriggerButton({
	buttonProps,
	currentQuantization,
	downloadProgress,
	disabled,
	open,
	placeholder,
	models = [],
	selectedModel,
	state,
}: {
	buttonProps: ComponentPropsWithoutRef<"button">;
	currentQuantization: string;
	downloadProgress: TtsTriggerDownloadProgress | null;
	disabled: boolean;
	open: boolean;
	placeholder: string;
	/** Catalog used to resolve the swap's from/to ids → display names. */
	models?: readonly TtsModelInfo[];
	selectedModel: TtsModelInfo | undefined;
	state: TtsModelState | undefined;
}) {
	const swap = useTtsSwapStore((s) => s.active);
	const isSwitching = swap !== null;
	const isDownloadingTarget =
		swap !== null && downloadProgress?.modelId === swap.toModelId;
	const isBackgroundDownload = swap === null && downloadProgress !== null;
	const isDownloading = isDownloadingTarget || isBackgroundDownload;
	const isTriggerActive = isSwitching || isDownloading;
	const downloadTarget = downloadProgress
		? models.find((model) => model.id === downloadProgress.modelId)
		: undefined;
	const reportedPercent =
		downloadProgress && downloadProgress.count >= 2
			? downloadProgress.averagePercent
			: downloadProgress?.percent;
	const ariaLabel = isDownloading
		? `Downloading ${downloadProgress?.count && downloadProgress.count >= 2 ? `${downloadProgress.count} models` : (downloadTarget?.displayName ?? "model")} (${reportedPercent == null ? "starting" : `${reportedPercent} percent`}). Currently selected: ${selectedModel?.displayName ?? "none"}.`
		: swap
			? ttsSwitchingAriaLabel(swap, models)
			: undefined;
	return (
		<Button
			{...buttonProps}
			aria-expanded={open}
			aria-label={ariaLabel}
			className={`${MODEL_TRIGGER_GLASS_CLASSES} ${buildSwitchingClassName(isTriggerActive)}`}
			data-slot="tts-model-selector-trigger"
			data-state={open ? "open" : "closed"}
			data-switching={isTriggerActive}
			disabled={disabled}
			type="button"
		>
			<span
				aria-hidden="true"
				className="pointer-events-none absolute inset-x-3 top-0 h-px bg-gradient-to-r from-transparent via-accent/55 to-transparent opacity-0 transition-opacity duration-200 group-data-[state=open]:opacity-100 group-data-[switching=true]:opacity-100"
			/>
			{isDownloading && downloadProgress ? (
				<TtsDownloadingBody
					currentQuantization={currentQuantization}
					download={downloadProgress}
					models={models}
					placeholder={placeholder}
					selectedModel={selectedModel}
					state={state}
				/>
			) : swap ? (
				<TtsSwitchingBody
					active={swap}
					ariaLabel={ariaLabel}
					models={models}
					selectedModel={selectedModel}
				/>
			) : (
				<TtsTriggerBody
					currentQuantization={currentQuantization}
					placeholder={placeholder}
					selectedModel={selectedModel}
					state={state}
				/>
			)}
			{isTriggerActive ? (
				<SwitchingPill
					label={isDownloading ? "Downloading" : "Switching"}
					showDot={!isDownloading}
				/>
			) : (
				<HugeiconsIcon
					className="ms-2 size-4 shrink-0 text-foreground-muted transition-[transform,color] duration-200 ease-out group-data-[state=open]:rotate-180 group-data-[state=open]:text-foreground"
					icon={ArrowDown01Icon}
				/>
			)}
			{isTriggerActive ? <SwapSweepBar /> : null}
		</Button>
	);
}

function DefaultTrigger({
	currentQuantization,
	downloadProgress,
	disabled,
	open,
	placeholder,
	models,
	selectedModel,
	state,
}: {
	currentQuantization: string;
	downloadProgress: TtsTriggerDownloadProgress | null;
	disabled: boolean;
	open: boolean;
	placeholder: string;
	models: readonly TtsModelInfo[];
	selectedModel: TtsModelInfo | undefined;
	state: TtsModelState | undefined;
}) {
	return (
		<Combobox.Trigger
			nativeButton
			render={(p) => (
				<TtsTriggerButton
					buttonProps={p as ComponentPropsWithoutRef<"button">}
					currentQuantization={currentQuantization}
					downloadProgress={downloadProgress}
					disabled={disabled}
					models={models}
					open={open}
					placeholder={placeholder}
					selectedModel={selectedModel}
					state={state}
				/>
			)}
		/>
	);
}

/** Standalone trigger button — same glass-card visual as {@link DefaultTrigger}
 *  but WITHOUT the `Combobox.Trigger` wrapper. For the settings panel, which
 *  opens the detached picker BrowserWindow on click instead of an in-window
 *  popup (mirrors `SttModelSelectorTriggerButton`). */
function TtsModelSelectorTriggerButton({
	currentQuantization,
	downloadProgress,
	onActivate,
	disabled,
	placeholder,
	models,
	selectedModel,
	state,
}: {
	currentQuantization: string;
	downloadProgress: TtsTriggerDownloadProgress | null;
	onActivate: (event: MouseEvent<HTMLButtonElement>) => void;
	disabled: boolean;
	placeholder: string;
	models: readonly TtsModelInfo[];
	selectedModel: TtsModelInfo | undefined;
	state: TtsModelState | undefined;
}) {
	return (
		<TtsTriggerButton
			buttonProps={{ type: "button", onClick: onActivate }}
			currentQuantization={currentQuantization}
			downloadProgress={downloadProgress}
			disabled={disabled}
			models={models}
			open={false}
			placeholder={placeholder}
			selectedModel={selectedModel}
			state={state}
		/>
	);
}

// Text search delegated to Base UI's filtering pipeline (groups + keyboard).
const filter = (model: TtsModelInfo, query: string) =>
	matchesFuzzySearch(buildTtsSearchCorpus(model), query);

/** Stable A→Z tie-break for equal bang-for-buck scores — mirrors the sort
 *  keys' universal name tie-breaker. */
const bySuggestionName = makeNameComparator((m: TtsModelInfo) => m.displayName);

/** The Suggested flat column: best bang-for-buck first (the engine's headline
 *  score = weighted harmonic mean of effective quality × speed at the best
 *  fitting quant, language mismatches de-ranked), name A→Z on ties. Models
 *  without a verdict sink to the end. */
function sortByBangForBuck(
	models: readonly TtsModelInfo[],
	getSuggestion: (modelId: string) => ModelSuggestion | null,
): TtsModelInfo[] {
	return models.toSorted((a, b) => {
		const scoreA = getSuggestion(a.id)?.score ?? 0;
		const scoreB = getSuggestion(b.id)?.score ?? 0;
		return scoreB - scoreA || bySuggestionName(a, b);
	});
}

/** Relevance projection for ranked search — engine label (maker) + name fields
 *  earn the exact/prefix/substring tiers; visibility stays Base UI's `filter`. */
function ttsSearchRankable(model: TtsModelInfo): SearchRankable {
	return {
		maker: getEngineLabel(model.engine),
		names: [model.displayName, model.id],
	};
}

/**
 * Top-level TTS voice/model picker — the TTS analogue of `SttModelSelector`.
 * Composes the shared {@link ModelPicker} shell with the engine-grouped
 * {@link TtsModelList}, a maker rail keyed by engine, per-window favorites, and
 * the selector-level delete-confirm dialog and TTS-specific sort/filter menu.
 * TTS deliberately omits STT-only hardware/streaming filters while exposing
 * voice capabilities, languages, precisions, availability, and cache state.
 */
function TtsModelSelectorPanel({
	models,
	value,
	currentQuantization,
	onChange,
	onDeleteQuant,
	onDownloadAction,
	onDownloadSnapshot,
	getSuggestion,
	statesById,
	disabled = false,
	isLoading = false,
	placeholder = "Select a voice model",
	popupHeightClass = DEFAULT_TTS_POPUP_HEIGHT,
	popupWidthClass = DEFAULT_TTS_POPUP_WIDTH,
	trigger,
	inline = false,
}: TtsModelSelectorProps) {
	const [pendingDelete, setPendingDelete] = useState<TtsPendingDelete | null>(
		null,
	);
	const handleRequestDelete = onDeleteQuant
		? (
				modelId: string,
				quantization: string,
				displayName: string,
				quantLabel: string,
			) => {
				setPendingDelete({ modelId, quantization, displayName, quantLabel });
			}
		: undefined;
	const handleConfirmDelete = () => {
		if (pendingDelete && onDeleteQuant) {
			onDeleteQuant(pendingDelete.modelId, pendingDelete.quantization);
		}
		setPendingDelete(null);
	};

	// Per-window starred-model set → drives the per-card star + the synthetic
	// "Favorites" group. Plus a separate starred-AUTHOR set so engine rail tiles
	// can be favorited (starred engines float to the top of the side rail) —
	// the same two-favorites model the STT picker uses.
	const { isFavorite, toggleFavorite } = useFavoriteSet(
		"winstt:tts-favorite-models",
	);
	const { favorites: favoriteAuthors, toggleFavorite: toggleAuthorFavorite } =
		useFavoriteSet("winstt:tts-favorite-authors");

	const selectedModel = models.find((m) => m.id === value) ?? null;
	const triggerDownloadProgress = summarizeTtsDownloads(
		models,
		onDownloadSnapshot,
	);
	// Computed each render (not memoized): `isFavorite` is a fresh closure per
	// render, so memoizing on it would recompute anyway — mirrors the STT picker.
	const [uiState, dispatch] = useReducer(uiReducer, undefined, () => {
		const persisted = readPersistedSelectorState(
			TTS_SELECTOR_UI_STORAGE_KEY,
			isPersistedTtsSelectorUiState,
			DEFAULT_PERSISTED_TTS_SELECTOR_UI_STATE,
		);
		return {
			activeRailId: persisted.activeRailId,
			// Pre-feature blobs lack `suggestedOnly` — normalize defaults it ON.
			filters: persisted.filters
				? normalizeTtsFilterState(persisted.filters)
				: { ...EMPTY_TTS_FILTER_STATE },
			open: false,
			search: "",
			sort: persisted.sort ?? null,
		};
	});
	const { activeRailId, filters, open, search, sort } = uiState;
	const hasSearch = search.trim().length > 0;
	const effectiveOpen = inline ? true : open;
	const shouldBuildList = effectiveOpen;
	useEffect(() => {
		writePersistedSelectorState(TTS_SELECTOR_UI_STORAGE_KEY, {
			activeRailId,
			filters,
			sort,
		});
	}, [activeRailId, filters, sort]);

	// Suggested (spec-based recommender). The host injects the verdict; when
	// absent the flag is inert (predicate null) and the chip stays hidden.
	// A model with NO suggestion entry stays visible (lenient — mirrors the
	// STT picker's unknown-verdict rule). Language mismatches are DE-RANKED
	// by the adapter (score × factor), never hidden here.
	const suggestionsAvailable = getSuggestion !== undefined;
	const suggestedPredicate = getSuggestion
		? (m: TtsModelInfo) => getSuggestion(m.id)?.visible !== false
		: null;
	const suggestedFilterOn = suggestionsAvailable && filters.suggestedOnly;
	const filteredModels = shouldBuildList
		? filterTtsModels(models, filters, statesById, suggestedPredicate)
		: [];
	// How many models the Suggested flag alone is hiding — drives the
	// empty-state "N models hidden by Suggested — tap to show all" hint.
	const suggestedHiddenCount =
		shouldBuildList && suggestedFilterOn
			? filterTtsModels(
					models,
					{ ...filters, suggestedOnly: false },
					statesById,
					suggestedPredicate,
				).length - filteredModels.length
			: 0;
	const engineGroups = groupModelsByEngine(filteredModels);
	// During an active search, order engines + their voices best-match-first so
	// the closest hit leads (mirrors the STT / OpenRouter pickers).
	const rankedEngineGroups =
		hasSearch && sort === null
			? rankGroupsBySearch(
					engineGroups,
					search,
					ttsSearchRankable,
					(group, items) => ({ ...group, items }),
				)
			: engineGroups;
	// With Suggested ON and NO explicit sort, the all-authors view flattens
	// into a single bang-for-buck-sorted column (best for this machine first).
	// A user-chosen sort key overrides the ordering — but never the hiding or
	// the per-quant badge gating.
	const suggestedFlattenActive =
		suggestedFilterOn && sort === null && getSuggestion !== undefined;
	const allGroups: TtsListGroup[] = suggestedFlattenActive
		? [
				{
					value: TTS_SORTED_GROUP_VALUE,
					items: sortByBangForBuck(filteredModels, getSuggestion),
				},
			]
		: sort === null
			? withTtsFavoritesGroup(rankedEngineGroups, isFavorite)
			: [
					{
						value: TTS_SORTED_GROUP_VALUE,
						items: sortTtsModels(filteredModels, sort),
					},
				];
	// A text query spans ALL authors: it overrides the selected rail so e.g.
	// "piper" still surfaces Piper voices while the Kokoro rail is active.
	// Without this, the rail (engine) filter AND the text query both constrain
	// the list, so searching for a maker not under the current rail yields a
	// confusing empty "No models found". The rail only narrows when idle.
	const groups: TtsListGroup[] =
		hasSearch || sort !== null || activeRailId === ALL_AUTHORS_RAIL_ID
			? allGroups
			: engineGroups.filter((group) => group.value === activeRailId);
	const filtersActive = hasActiveTtsFilters(filters);
	const availableLanguages = shouldBuildList ? collectTtsLanguages(models) : [];
	const availableQuantizations = shouldBuildList
		? collectTtsQuantizations(models)
		: [];
	const railItems = buildRailItems(engineGroups, filteredModels.length);
	const visibleModelCount =
		hasSearch || sort !== null || activeRailId === ALL_AUTHORS_RAIL_ID
			? filteredModels.length
			: groups.reduce((sum, group) => sum + group.items.length, 0);

	const openGuard = useModelPickerCloseGuard({
		setOpen: (nextOpen) => dispatch({ type: "setOpen", open: nextOpen }),
	});

	const handleSelect: TtsModelChange = (modelId, quantization) => {
		onChange(modelId, quantization);
		// The search is controlled here (so it can span authors), so Base UI's own
		// "clear input on commit" no longer runs — reset it ourselves so a later
		// reopen / inline reuse starts clean. Mirrors the STT picker.
		if (hasSearch) {
			dispatch({ type: "setSearch", search: "" });
		}
	};

	const handleRailClick = (id: string) => {
		// Picking an engine/maker is a "browse this maker" intent — drop any active
		// query or global sort (which would otherwise override the rail, per `groups`
		// above) so the click actually narrows the list to the chosen engine.
		if (hasSearch) {
			dispatch({ type: "setSearch", search: "" });
		}
		if (sort !== null && id !== ALL_AUTHORS_RAIL_ID) {
			dispatch({ type: "setSort", sort: null });
		}
		dispatch({ type: "setActiveRailId", id });
	};

	return (
		<>
			<ModelPicker<TtsModelInfo, TtsModelInfo | null>
				disabled={disabled || isLoading}
				filter={filter}
				filtersLeadingSlot={
					suggestionsAvailable ? (
						<SuggestedFilterChip
							active={filters.suggestedOnly}
							onToggle={() =>
								dispatch({
									type: "setFilters",
									filters: {
										...filters,
										suggestedOnly: !filters.suggestedOnly,
									},
								})
							}
						/>
					) : undefined
				}
				filtersMenuSlot={
					<TtsFiltersMenu
						availableLanguages={availableLanguages}
						availableQuantizations={availableQuantizations}
						filters={filters}
						onFiltersChange={(next) =>
							dispatch({ type: "setFilters", filters: next })
						}
						onSortChange={(next) => dispatch({ type: "setSort", sort: next })}
						showSuggestedFilter={suggestionsAvailable}
						sort={sort}
					/>
				}
				inline={inline}
				inputValue={search}
				onInputValueChange={(next) =>
					dispatch({ type: "setSearch", search: next })
				}
				isItemEqualToValue={(a, b) => a?.id === b?.id}
				isLoading={isLoading}
				items={shouldBuildList ? groups : []}
				itemToStringLabel={(item) => item?.displayName ?? ""}
				list={
					shouldBuildList ? (
						<TtsModelList
							currentQuantization={currentQuantization}
							getDownloadSnapshot={onDownloadSnapshot}
							// Per-quant badge gating: while Suggested is ON, badges outside
							// the fitting set render disabled/greyed.
							getFittingQuants={
								suggestedFilterOn && getSuggestion
									? (modelId: string) =>
											getSuggestion(modelId)?.fittingQuants ?? null
									: undefined
							}
							hasActiveFilters={filtersActive}
							hasSearch={hasSearch}
							isFavorite={isFavorite}
							onDownloadAction={onDownloadAction}
							onRequestDeleteQuant={handleRequestDelete}
							onSelect={handleSelect}
							onShowAllSuggested={() =>
								dispatch({
									type: "setFilters",
									filters: { ...filters, suggestedOnly: false },
								})
							}
							onToggleFavorite={toggleFavorite}
							selectedId={value}
							sort={sort}
							statesById={statesById}
							suggestedFlattenActive={suggestedFlattenActive}
							suggestedHiddenCount={suggestedHiddenCount}
							visibleModelCount={visibleModelCount}
						/>
					) : null
				}
				onOpenChange={openGuard.handleOpenChange}
				onValueChange={(next) => {
					if (next && next.available !== false) {
						const supportsCurrent =
							next.availableQuantizations.includes(currentQuantization);
						const fallback = supportsCurrent
							? undefined
							: (next.availableQuantizations[0] ?? "");
						handleSelect(next.id, fallback);
					}
				}}
				open={effectiveOpen}
				popupHeightClass={popupHeightClass}
				popupRef={(node) => {
					openGuard.setPopupNode(node);
				}}
				popupWidthClass={popupWidthClass}
				searchPlaceholder="Search voice models"
				selectedItemKey={value || undefined}
				sidebarSlot={
					shouldBuildList && railItems.length > 1 ? (
						<GroupRail
							activeId={activeRailId}
							favorites={favoriteAuthors}
							items={railItems}
							onClick={handleRailClick}
							onToggleFavorite={toggleAuthorFavorite}
						/>
					) : undefined
				}
				trigger={
					inline
						? undefined
						: (trigger ?? (
								<DefaultTrigger
									currentQuantization={currentQuantization}
									disabled={disabled || isLoading}
									downloadProgress={triggerDownloadProgress}
									models={models}
									open={open}
									placeholder={placeholder}
									selectedModel={selectedModel ?? undefined}
									state={
										selectedModel ? statesById[selectedModel.id] : undefined
									}
								/>
							))
				}
				value={selectedModel}
			/>
			<TtsDeleteQuantConfirmDialog
				onCancel={() => setPendingDelete(null)}
				onConfirm={handleConfirmDelete}
				pending={pendingDelete}
			/>
		</>
	);
}

/** Detached-open mode (settings panel): render only the standalone trigger
 *  button that opens the floating picker window on click; the in-window popup is
 *  fully suppressed. Mirrors `SttModelSelectorDetachedTrigger`. */
function TtsModelSelectorDetachedTrigger({
	models,
	value,
	currentQuantization,
	disabled = false,
	isLoading = false,
	placeholder = "Select a voice model",
	onOpenDetached,
	onDownloadSnapshot,
	statesById,
}: TtsModelSelectorProps) {
	const selectedModel = models.find((m) => m.id === value) ?? null;
	const triggerDownloadProgress = summarizeTtsDownloads(
		models,
		onDownloadSnapshot,
	);
	return (
		<TtsModelSelectorTriggerButton
			currentQuantization={currentQuantization}
			disabled={disabled || isLoading}
			downloadProgress={triggerDownloadProgress}
			models={models}
			onActivate={(event) =>
				onOpenDetached?.(event.currentTarget.getBoundingClientRect())
			}
			placeholder={placeholder}
			selectedModel={selectedModel ?? undefined}
			state={selectedModel ? statesById[selectedModel.id] : undefined}
		/>
	);
}

/**
 * Top-level TTS voice/model picker. When `onOpenDetached` is supplied (and not
 * `inline`), it renders a standalone trigger that opens the detached
 * model-picker window; otherwise it renders the full in-window popup panel.
 */
export function TtsModelSelector(props: TtsModelSelectorProps) {
	if (props.onOpenDetached && !props.inline) {
		return <TtsModelSelectorDetachedTrigger {...props} />;
	}
	return <TtsModelSelectorPanel {...props} />;
}
