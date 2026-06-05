"use client";

import { Combobox } from "@base-ui/react/combobox";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useEffect, useMemo, useReducer, useState } from "react";
import type { TtsModelInfo, TtsModelState } from "@/entities/tts-catalog";
import { Button } from "@/shared/ui/button";
import {
  ALL_AUTHORS_RAIL_ID,
  buildAllAuthorsRailItem,
  GroupRail,
  type GroupRailItem,
  RailIconChip,
} from "../../core/GroupRail";
import { ModelPicker } from "../../core/ModelPicker";
import { useFavoriteSet } from "../../core/use-favorite-set";
import { useModelPickerCloseGuard } from "../../lib/model-picker-close-guard";
import {
  readPersistedSelectorState,
  writePersistedSelectorState,
} from "../../lib/persisted-selector-state";
import { publicAsset } from "../../lib/public-asset";
import { STT_PICKER_WIDTH_CLASS } from "../../stt/lib/dimensions";
import {
  buildTtsSearchCorpus,
  getEngineConfig,
  getEngineLabel,
  getEngineLogoSrc,
  getEngineMaker,
  groupModelsByEngine,
  type TtsListGroup,
  withTtsFavoritesGroup,
} from "../lib/tts-helpers";
import {
  type TtsPendingDelete,
  TtsDeleteQuantConfirmDialog,
} from "./TtsDeleteQuantConfirmDialog";
import { TtsMakerLogo } from "./TtsMakerLogo";
import { TtsModelList } from "./TtsModelList";
import {
  type QuantDownloadAction,
  type QuantDownloadSnapshot,
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
  return candidate.activeRailId === null || typeof candidate.activeRailId === "string";
}

type TtsSelectorUiAction =
  | { id: string | null; type: "setActiveRailId" }
  | { open: boolean; type: "setOpen" };

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

/** Default glass-card-ish trigger — selected engine glyph + display name, or the
 *  placeholder. Deliberately lighter than the STT trigger (no swap/download
 *  in-flight states) since TTS model swaps are instantaneous. */
function TtsTriggerBody({
  selectedModel,
  placeholder,
}: {
  placeholder: string;
  selectedModel: TtsModelInfo | undefined;
}) {
  if (!selectedModel) {
    return (
      <span className="font-medium text-body text-foreground-muted italic tracking-tight">
        {placeholder}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <TtsMakerLogo engine={selectedModel.engine} />
      <span className="truncate font-medium text-body text-foreground leading-tight tracking-tight">
        {selectedModel.displayName}
      </span>
      <span className="shrink-0 text-[10px] text-foreground-dim">
        {getEngineLabel(selectedModel.engine)}
      </span>
    </span>
  );
}

function DefaultTrigger({
  disabled,
  open,
  placeholder,
  selectedModel,
}: {
  disabled: boolean;
  open: boolean;
  placeholder: string;
  selectedModel: TtsModelInfo | undefined;
}) {
  return (
    <Combobox.Trigger
      nativeButton
      render={(p) => (
        <Button
          {...p}
          aria-expanded={open}
          className="group relative flex h-auto min-h-[3.25rem] w-full items-center justify-between gap-2 overflow-hidden rounded-lg bg-gradient-to-b from-[var(--color-surface-3)]/85 to-[var(--color-surface-2)]/95 px-3 py-2 text-left shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06),0_2px_6px_-3px_rgba(2,3,8,0.55)] ring-1 ring-white/[0.07] ring-inset transition-[transform,background-color,box-shadow] duration-150 ease-out hover:from-[var(--color-surface-4)]/85 hover:to-[var(--color-surface-3)]/95 hover:ring-white/[0.13] active:scale-[0.99] disabled:cursor-not-allowed data-[state=open]:ring-accent/40"
          data-slot="tts-model-selector-trigger"
          data-state={open ? "open" : "closed"}
          disabled={disabled}
          type="button"
        >
          <TtsTriggerBody
            placeholder={placeholder}
            selectedModel={selectedModel}
          />
          <HugeiconsIcon
            className="ms-2 size-4 shrink-0 text-foreground-muted transition-[transform,color] duration-200 ease-out group-data-[state=open]:rotate-180 group-data-[state=open]:text-foreground"
            icon={ArrowDown01Icon}
          />
        </Button>
      )}
    />
  );
}

/**
 * Top-level TTS voice/model picker — the TTS analogue of `SttModelSelector`.
 * Composes the shared {@link ModelPicker} shell with the engine-grouped
 * {@link TtsModelList}, a maker rail keyed by engine, per-window favorites, and
 * the selector-level delete-confirm dialog. Kept thin: TTS has no realtime /
 * hardware / sort filters and no variant bundles, so it skips the STT selector's
 * filter reducer + bundle-expansion machinery.
 */
export function TtsModelSelector({
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

  const selectedModel = useMemo(
    () => models.find((m) => m.id === value) ?? null,
    [models, value],
  );
  // Computed each render (not memoized): `isFavorite` is a fresh closure per
  // render, so memoizing on it would recompute anyway — mirrors the STT picker.
  const [uiState, dispatch] = useReducer(uiReducer, undefined, () => ({
    activeRailId: readPersistedSelectorState(
      TTS_SELECTOR_UI_STORAGE_KEY,
      isPersistedTtsSelectorUiState,
      DEFAULT_PERSISTED_TTS_SELECTOR_UI_STATE,
    ).activeRailId,
    open: false,
  }));
  const { activeRailId, open } = uiState;
  useEffect(() => {
    writePersistedSelectorState(TTS_SELECTOR_UI_STORAGE_KEY, { activeRailId });
  }, [activeRailId]);

  const engineGroups = groupModelsByEngine(models);
  const allGroups: TtsListGroup[] = withTtsFavoritesGroup(
    engineGroups,
    isFavorite,
  );
  const groups: TtsListGroup[] =
    activeRailId === ALL_AUTHORS_RAIL_ID
      ? allGroups
      : engineGroups.filter((group) => group.value === activeRailId);
  const railItems = buildRailItems(engineGroups, models.length);
  const visibleModelCount =
    activeRailId === ALL_AUTHORS_RAIL_ID
      ? models.length
      : groups.reduce((sum, group) => sum + group.items.length, 0);

  const openGuard = useModelPickerCloseGuard({
    setOpen: (nextOpen) => dispatch({ type: "setOpen", open: nextOpen }),
  });

  const handleSelect: TtsModelChange = (modelId, quantization) => {
    onChange(modelId, quantization);
  };

  // Text search delegated to Base UI's filtering pipeline (groups + keyboard).
  const filter = (model: TtsModelInfo, query: string) => {
    const q = query.trim().toLowerCase();
    return q.length === 0 || buildTtsSearchCorpus(model).includes(q);
  };

  return (
    <>
      <ModelPicker<TtsModelInfo, TtsModelInfo | null>
        disabled={disabled || isLoading}
        filter={filter}
        inline={inline}
        isItemEqualToValue={(a, b) => a?.id === b?.id}
        isLoading={isLoading}
        items={groups}
        itemToStringLabel={(item) => item?.displayName ?? ""}
        list={
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
        open={inline ? true : open}
        popupHeightClass={popupHeightClass}
        popupRef={(node) => {
          openGuard.setPopupNode(node);
        }}
        popupWidthClass={popupWidthClass}
        searchPlaceholder="Search voice models"
        selectedItemKey={value || undefined}
        sidebarSlot={
          railItems.length > 1 ? (
            <GroupRail
              activeId={activeRailId}
              favorites={favoriteAuthors}
              items={railItems}
              onClick={(id) => dispatch({ type: "setActiveRailId", id })}
              onToggleFavorite={toggleAuthorFavorite}
            />
          ) : undefined
        }
        trigger={
          inline
            ? undefined
            : (trigger ?? (
                <DefaultTrigger
                  disabled={disabled || isLoading}
                  open={open}
                  placeholder={placeholder}
                  selectedModel={selectedModel ?? undefined}
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
