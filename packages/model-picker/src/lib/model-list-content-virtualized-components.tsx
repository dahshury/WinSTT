"use client";

import { ServerStack01Icon, StarIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { GroupHeader, NeutralHeaderIcon } from "../core/model-card";
import {
  FAVORITES_SECTION_ID,
  getEmptyStateBody,
  getEmptyStateLabel,
  type VirtualizedItem,
} from "./model-list-content-virtualized-utils";
import { MakerHeaderIcon, ModelHeader } from "./model-list-model-header";
import { ProvidersRow } from "./model-list-provider-grid";

/** The sticky section-header chrome for a group: amber star for the synthetic
 *  Favorites group, the maker's brand logo for a real maker group. Shared by the
 *  in-list rows AND the floating pinned-header overlay so they look identical. */
export function SectionHeader({
  count,
  label,
  sectionId,
}: {
  count: number;
  label: string;
  sectionId: string;
}) {
  const subtitle = `· ${count === 1 ? "1 model" : `${count} models`}`;
  return sectionId === FAVORITES_SECTION_ID ? (
    <GroupHeader
      data-rail-section={sectionId}
      icon={<NeutralHeaderIcon icon={StarIcon} tone="favorites" />}
      label={label}
      subtitle={subtitle}
    />
  ) : (
    <GroupHeader
      data-rail-section={sectionId}
      icon={<MakerHeaderIcon maker={sectionId} />}
      label={label}
      subtitle={subtitle}
    />
  );
}

export function VirtualizedRow({
  item,
  parsedModelId,
  parsedProviderSlug,
  onToggleModelExpanded,
  onSelectModel,
  isFavoriteModel,
  onToggleModelFavorite,
}: {
  item: VirtualizedItem;
  parsedModelId: string | undefined;
  parsedProviderSlug: string | undefined;
  onToggleModelExpanded: (modelId: string, nextOpen?: boolean) => void;
  onSelectModel: (modelId: string | undefined, providerSlug?: string) => void;
  isFavoriteModel?: ((id: string) => boolean) | undefined;
  onToggleModelFavorite?: ((id: string) => void) | undefined;
}) {
  if (item.type === "header") {
    return (
      <SectionHeader
        count={item.count}
        label={item.label}
        sectionId={item.sectionId}
      />
    );
  }
  if (item.type === "model") {
    return (
      <div key={`model-${item.model.id}`}>
        <ModelHeader
          hasProviders={item.hasProviders}
          isExpanded={item.isExpanded}
          isFavorite={isFavoriteModel}
          model={item.model}
          onToggleExpanded={onToggleModelExpanded}
          onToggleFavorite={onToggleModelFavorite}
          parsedModelId={parsedModelId}
          parsedProviderSlug={parsedProviderSlug}
        />
      </div>
    );
  }
  return (
    <div key={`providers-${item.model.id}`}>
      <ProvidersRow
        endpoints={item.endpoints}
        isOpen={item.isOpen}
        model={item.model}
        onSelectModel={onSelectModel}
        parsedModelId={parsedModelId}
        parsedProviderSlug={parsedProviderSlug}
      />
    </div>
  );
}

export function EmptyState({
  hasActiveFilters,
}: {
  hasActiveFilters: boolean;
}): ReactNode {
  const level = Math.min(useSurface() + 1, 8);
  return (
    <div className="mx-auto flex w-full max-w-[280px] flex-col items-center gap-2 text-center">
      <div
        className={cn(
          "flex size-10 items-center justify-center rounded-full",
          surfaceBg(level),
        )}
      >
        <HugeiconsIcon
          className="size-5 text-foreground-muted"
          icon={ServerStack01Icon}
        />
      </div>
      <p className="text-balance font-semibold text-body">
        {getEmptyStateLabel(hasActiveFilters)}
      </p>
      <p className="text-balance text-foreground-muted text-xs-tight">
        {getEmptyStateBody(hasActiveFilters)}
      </p>
    </div>
  );
}
