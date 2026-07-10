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
} from "../../core/GroupRail";
import {
	ALL_AUTHORS_RAIL_ID,
	buildAllAuthorsRailItem,
} from "../../core/group-rail-items";
import { ModelPicker } from "../../core/ModelPicker";
import { useFavoriteSet } from "../../core/use-favorite-set";
import { useModelPickerCloseGuard } from "../../lib/model-picker-close-guard";
import {
	readPersistedSelectorState,
	writePersistedSelectorState,
} from "@/shared/lib/persisted-selector-state";
import { publicAsset } from "@/shared/lib/public-asset";
import { STT_PICKER_WIDTH_CLASS } from "../../stt/lib/dimensions";
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
	withTtsFavoritesGroup,
} from "../lib/tts-helpers";
import { buildTtsSpec } from "../lib/build-tts-spec";
import {
	type TtsPendingDelete,
	TtsDeleteQuantConfirmDialog,
} from "./TtsDeleteQuantConfirmDialog";
import { AuthorBadge } from "../../ui/AuthorBadge";
import {
	SelectedModelSummary,
	type SelectedModelMetaItem,
} from "../../ui/SelectedModelSummary";
import { TtsModelList } from "./TtsModelList";
import type {
	QuantDownloadAction,
	QuantDownloadSnapshot,
} from "./TtsModelCard";

type TtsModelChange = (modelId: string, quantization?: string) => void;

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
	open: boolean;
	/** Text-search query, owned here (not inside `ModelPicker`) so a query can
	 *  span ALL authors — it overrides the active rail, so e.g. "piper" finds
	 *  Piper voices even while the Kokoro rail is selected. Mirrors the STT
	 *  picker's lifted-search fix. */
	search: string;
}

interface PersistedTtsSelectorUiState {
	activeRailId: string | null;
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
		candidate.activeRailId === null ||
		typeof candidate.activeRailId === "string"
	);
}

type TtsSelectorUiAction =
	| { id: string | null; type: "setActiveRailId" }
	| { open: boolean; type: "setOpen" }
	| { search: string; type: "setSearch" };

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

function TtsTriggerButton({
	buttonProps,
	currentQuantization,
	disabled,
	open,
	placeholder,
	models = [],
	selectedModel,
	state,
}: {
	buttonProps: ComponentPropsWithoutRef<"button">;
	currentQuantization: string;
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
	const ariaLabel = swap ? ttsSwitchingAriaLabel(swap, models) : undefined;
	return (
		<Button
			{...buttonProps}
			aria-expanded={open}
			aria-label={ariaLabel}
			className={`${MODEL_TRIGGER_GLASS_CLASSES} ${buildSwitchingClassName(isSwitching)}`}
			data-slot="tts-model-selector-trigger"
			data-state={open ? "open" : "closed"}
			data-switching={isSwitching}
			disabled={disabled}
			type="button"
		>
			<span
				aria-hidden="true"
				className="pointer-events-none absolute inset-x-3 top-0 h-px bg-gradient-to-r from-transparent via-accent/55 to-transparent opacity-0 transition-opacity duration-200 group-data-[state=open]:opacity-100 group-data-[switching=true]:opacity-100"
			/>
			{swap ? (
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
			{isSwitching ? (
				<SwitchingPill />
			) : (
				<HugeiconsIcon
					className="ms-2 size-4 shrink-0 text-foreground-muted transition-[transform,color] duration-200 ease-out group-data-[state=open]:rotate-180 group-data-[state=open]:text-foreground"
					icon={ArrowDown01Icon}
				/>
			)}
			{isSwitching ? <SwapSweepBar /> : null}
		</Button>
	);
}

function DefaultTrigger({
	currentQuantization,
	disabled,
	open,
	placeholder,
	models,
	selectedModel,
	state,
}: {
	currentQuantization: string;
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
	onActivate,
	disabled,
	placeholder,
	models,
	selectedModel,
	state,
}: {
	currentQuantization: string;
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
 * the selector-level delete-confirm dialog. Kept thin: TTS has no realtime /
 * hardware / sort filters and no variant bundles, so it skips the STT selector's
 * filter reducer + bundle-expansion machinery.
 */
function TtsModelSelectorPanel({
	models,
	value,
	currentQuantization,
	onChange,
	onDeleteQuant,
	onDownloadAction,
	onDownloadSnapshot,
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
	// Computed each render (not memoized): `isFavorite` is a fresh closure per
	// render, so memoizing on it would recompute anyway — mirrors the STT picker.
	const [uiState, dispatch] = useReducer(uiReducer, undefined, () => ({
		activeRailId: readPersistedSelectorState(
			TTS_SELECTOR_UI_STORAGE_KEY,
			isPersistedTtsSelectorUiState,
			DEFAULT_PERSISTED_TTS_SELECTOR_UI_STATE,
		).activeRailId,
		open: false,
		search: "",
	}));
	const { activeRailId, open, search } = uiState;
	const hasSearch = search.trim().length > 0;
	const effectiveOpen = inline ? true : open;
	const shouldBuildList = effectiveOpen;
	useEffect(() => {
		writePersistedSelectorState(TTS_SELECTOR_UI_STORAGE_KEY, { activeRailId });
	}, [activeRailId]);

	const engineGroups = shouldBuildList ? groupModelsByEngine(models) : [];
	// During an active search, order engines + their voices best-match-first so
	// the closest hit leads (mirrors the STT / OpenRouter pickers).
	const rankedEngineGroups = hasSearch
		? rankGroupsBySearch(
				engineGroups,
				search,
				ttsSearchRankable,
				(group, items) => ({ ...group, items }),
			)
		: engineGroups;
	const allGroups: TtsListGroup[] = withTtsFavoritesGroup(
		rankedEngineGroups,
		isFavorite,
	);
	// A text query spans ALL authors: it overrides the selected rail so e.g.
	// "piper" still surfaces Piper voices while the Kokoro rail is active.
	// Without this, the rail (engine) filter AND the text query both constrain
	// the list, so searching for a maker not under the current rail yields a
	// confusing empty "No models found". The rail only narrows when idle.
	const groups: TtsListGroup[] =
		hasSearch || activeRailId === ALL_AUTHORS_RAIL_ID
			? allGroups
			: engineGroups.filter((group) => group.value === activeRailId);
	const railItems = buildRailItems(engineGroups, models.length);
	const visibleModelCount =
		hasSearch || activeRailId === ALL_AUTHORS_RAIL_ID
			? models.length
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
		// query (which would otherwise override the rail, per `groups` above) so the
		// click actually narrows the list to the chosen engine. Mirrors the STT picker.
		if (hasSearch) {
			dispatch({ type: "setSearch", search: "" });
		}
		dispatch({ type: "setActiveRailId", id });
	};

	return (
		<>
			<ModelPicker<TtsModelInfo, TtsModelInfo | null>
				disabled={disabled || isLoading}
				filter={filter}
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
							hasActiveFilters={false}
							isFavorite={isFavorite}
							onDownloadAction={onDownloadAction}
							onRequestDeleteQuant={handleRequestDelete}
							onSelect={handleSelect}
							onToggleFavorite={toggleFavorite}
							selectedId={value}
							statesById={statesById}
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
	statesById,
}: TtsModelSelectorProps) {
	const selectedModel = models.find((m) => m.id === value) ?? null;
	return (
		<TtsModelSelectorTriggerButton
			currentQuantization={currentQuantization}
			disabled={disabled || isLoading}
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
