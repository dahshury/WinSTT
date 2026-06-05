"use client";

import { Combobox } from "@base-ui/react/combobox";
import { ArrowUpDownIcon } from "@hugeicons/core-free-icons";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { VList, type VListHandle } from "virtua";
import type { OpenRouterModel } from "@/shared/api/models";
import { GroupHeader, NeutralHeaderIcon } from "../core/model-card";
import {
  EmptyState,
  SectionHeader,
  VirtualizedRow,
} from "../lib/model-list-content-virtualized-components";
import {
  applyScrollToMakerRequest,
  applyVirtualScrollMakerUpdate,
  buildVirtualItems,
  getRowKey,
  findActiveVirtualIndex,
} from "../lib/model-list-content-virtualized-utils";

export interface ModelListContentVirtualizedProps {
  expandedModels: Set<string>;
  groupedModels: [string, OpenRouterModel[]][];
  hasActiveFilters: boolean;
  isFavoriteModel?: ((id: string) => boolean) | undefined;
  onActiveMakerChange?: ((maker: string | null) => void) | undefined;
  onSelectModel: (modelId: string | undefined, providerSlug?: string) => void;
  onToggleModelExpanded: (modelId: string, nextOpen?: boolean) => void;
  onToggleModelFavorite?: ((id: string) => void) | undefined;
  parsedModelId: string | undefined;
  parsedProviderSlug: string | undefined;
  scrollToMakerRequest?:
    | {
        maker: string;
        modelId?: string | undefined;
        nonce: number;
      }
    | null
    | undefined;
  /** When a global sort is active, the header label to show above the flat list
   *  (e.g. "Context · largest first"). ``undefined`` keeps the default grouped view. */
  showFavoritesGroup?: boolean | undefined;
  sortHeaderLabel?: string | undefined;
}

export function ModelListContentVirtualized({
  groupedModels,
  expandedModels,
  parsedModelId,
  parsedProviderSlug,
  onToggleModelExpanded,
  onSelectModel,
  hasActiveFilters,
  scrollToMakerRequest,
  onActiveMakerChange,
  sortHeaderLabel,
  isFavoriteModel,
  onToggleModelFavorite,
  showFavoritesGroup = true,
}: ModelListContentVirtualizedProps): ReactNode {
  const virtualizerHandleRef = useRef<VListHandle>(null);
  // Section id whose header is currently pinned as the floating overlay (the
  // in-list header unmounts under VList virtualization, so we re-render it).
  const [stickySectionId, setStickySectionId] = useState<string | null>(null);

  // Favorited models collect into a pinned "Favorites" group at the top — but
  // only in the grouped view (a global sort flattens the list, where a pinned
  // group would be meaningless). The card star itself stays available in both.
  // Maker section headers are added only in the grouped view (`!sortHeaderLabel`).
  const virtualItems = buildVirtualItems(
    groupedModels,
    expandedModels,
    sortHeaderLabel || !showFavoritesGroup ? undefined : isFavoriteModel,
    !sortHeaderLabel,
  );
  const stickyHeaderItem =
    stickySectionId === null
      ? undefined
      : virtualItems.find(
          (it) => it.type === "header" && it.sectionId === stickySectionId,
        );

  const lastNotifiedMakerRef = useRef<string | null>(null);
  const handleVirtualScroll = (offset: number) => {
    const handle = virtualizerHandleRef.current;
    lastNotifiedMakerRef.current = applyVirtualScrollMakerUpdate(
      handle,
      virtualItems,
      offset,
      lastNotifiedMakerRef.current,
      onActiveMakerChange,
    );
    // Pin the active section's header as a floating overlay only once scrolled
    // PAST its own header row (top item is a model/providers row) — so a header
    // docked at the very top isn't duplicated by the overlay.
    if (handle && virtualItems.length > 0) {
      const top =
        virtualItems[
          findActiveVirtualIndex(handle, virtualItems.length, offset)
        ];
      setStickySectionId(
        top && top.type !== "header" ? (top.sectionId ?? null) : null,
      );
    }
  };

  const lastNonceRef = useRef<number | null>(null);
  useEffect(() => {
    lastNonceRef.current = applyScrollToMakerRequest(
      scrollToMakerRequest,
      lastNonceRef.current,
      virtualItems,
      virtualizerHandleRef.current?.scrollToIndex,
    );
  }, [scrollToMakerRequest, virtualItems]);

  if (groupedModels.length === 0) {
    return (
      <Combobox.List
        className="min-h-0 flex-1 overflow-hidden p-0"
        data-slot="model-list-content"
        data-state="empty"
      >
        <div className="flex items-center justify-center p-8">
          <EmptyState hasActiveFilters={hasActiveFilters} />
        </div>
      </Combobox.List>
    );
  }

  return (
    <Combobox.List
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden p-0"
      data-slot="model-list-content"
    >
      {sortHeaderLabel ? (
        // The shared `GroupHeader` chrome, identical to the STT picker's
        // sticky section headers. No `data-rail-section`: the maker rail is
        // not tied to a maker section target (matching the STT sorted-header
        // convention).
        <GroupHeader
          icon={<NeutralHeaderIcon icon={ArrowUpDownIcon} />}
          label="Sorted"
          subtitle={`· ${sortHeaderLabel}`}
        />
      ) : null}
      {stickyHeaderItem && stickyHeaderItem.type === "header" ? (
        // Floating pinned header — re-renders the active group's header at the
        // top while the real in-list header is virtualized away, so groups
        // "stick" while scrolling like the STT picker. Click-through.
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 z-raised"
        >
          <SectionHeader
            count={stickyHeaderItem.count}
            label={stickyHeaderItem.label}
            sectionId={stickyHeaderItem.sectionId}
          />
        </div>
      ) : null}
      <VList
        className="min-h-0 flex-1 overscroll-contain"
        data-slot="model-list-scroll-container"
        onScroll={handleVirtualScroll}
        ref={virtualizerHandleRef}
        style={{ touchAction: "pan-y", WebkitOverflowScrolling: "touch" }}
      >
        {virtualItems.map((item) => (
          <VirtualizedRow
            isFavoriteModel={isFavoriteModel}
            item={item}
            key={getRowKey(item)}
            onSelectModel={onSelectModel}
            onToggleModelExpanded={onToggleModelExpanded}
            onToggleModelFavorite={onToggleModelFavorite}
            parsedModelId={parsedModelId}
            parsedProviderSlug={parsedProviderSlug}
          />
        ))}
      </VList>
    </Combobox.List>
  );
}
