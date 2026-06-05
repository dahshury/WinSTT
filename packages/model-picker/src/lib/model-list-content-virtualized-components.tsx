"use client";

import { Button as BaseButton } from "@base-ui/react/button";
import { Combobox } from "@base-ui/react/combobox";
import {
  ArrowRight01Icon,
  BookOpen02Icon,
  CpuIcon,
  MessageOutgoing02Icon,
  ServerStack01Icon,
  StarIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import type { OpenRouterEndpoint, OpenRouterModel } from "@/shared/api/models";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, surfaceHoverBg, useSurface } from "@/shared/lib/surface";
import { Collapsible } from "../core/Collapsible";
import { GroupHeader, ModelCard, NeutralHeaderIcon } from "../core/model-card";
import { EndpointFeatureIcons } from "../ui/EndpointFeatureIcons";
import { ModelModalityIcons } from "../ui/ModelModalityIcons";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/Tooltip";
import {
  computeModelHeaderState,
  FAVORITES_SECTION_ID,
  getChevronClassName,
  getEmptyStateBody,
  getEmptyStateLabel,
  getEndpointProviderSlug,
  getExpandAriaLabel,
  getFeaturedEndpoint,
  getPricingClassName,
  getPricingLabel,
  getProviderCardClassName,
  getProviderCountTooltip,
  getSelectionDotClassName,
  isPositiveNumber,
  isProviderSelected,
  type ModelVariantKey,
  resolveMakerIconSrc,
  shouldRenderInlineMeta,
  shouldShowStatsRow,
  VARIANT_GRADIENT_MAP,
  type VirtualizedItem,
} from "./model-list-content-virtualized-utils";
import {
  formatContextLength,
  getPricingTier,
  type getVariantClasses,
  getVariantIcon,
} from "./model-selector-display-utils";
import { formatMaker, formatModelName } from "./model-selector-utils";
import { MODEL_VARIANT_INFO } from "./model-variant-utils";
import { publicAsset } from "./public-asset";

// Quiet neutral top hairline. Once a 4px per-variant rainbow ribbon; now a
// faint 1px structural seam (the variant meaning lives in the meta-line token).
function VariantAccentStrip({
  variant,
  gradient,
}: {
  variant: ModelVariantKey;
  gradient: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-md bg-gradient-to-r",
        gradient,
        VARIANT_GRADIENT_MAP[variant],
      )}
    />
  );
}

function ProviderStatChip({
  icon,
  value,
  tooltipTitle,
  tooltipBody,
}: {
  icon: typeof BookOpen02Icon;
  value: number | null | undefined;
  tooltipTitle: string;
  tooltipBody: string;
}) {
  if (!isPositiveNumber(value)) {
    return null;
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={(props) => (
          <div
            {...(props as ComponentPropsWithoutRef<"div">)}
            className="flex min-w-0 cursor-default items-center gap-1"
          >
            <HugeiconsIcon
              className="size-3 shrink-0 text-foreground-muted"
              icon={icon}
            />
            <span className="truncate font-medium text-foreground-secondary">
              {formatContextLength(value)}
            </span>
          </div>
        )}
      />
      <TooltipContent className="max-w-xs" side="top">
        <p className="font-semibold text-body-sm">{tooltipTitle}</p>
        <p className="text-foreground-muted text-xs-tight leading-relaxed">
          {tooltipBody}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

function ProviderStatsRow({
  contextLength,
  maxOut,
}: {
  contextLength: number | null | undefined;
  maxOut: number | null | undefined;
}) {
  if (!shouldShowStatsRow(contextLength, maxOut)) {
    return null;
  }
  return (
    <div className="grid grid-cols-2 gap-x-2 text-[10px] tabular-nums">
      <div className="min-w-0">
        <ProviderStatChip
          icon={BookOpen02Icon}
          tooltipBody="Maximum tokens this provider can read in a single request — prompt plus prior conversation."
          tooltipTitle="Context window"
          value={contextLength}
        />
      </div>
      <div className="min-w-0">
        <ProviderStatChip
          icon={MessageOutgoing02Icon}
          tooltipBody="Maximum tokens this provider can generate in a single response."
          tooltipTitle="Max output"
          value={maxOut}
        />
      </div>
    </div>
  );
}

function ProviderPricingTooltip({
  pricingInfo,
}: {
  pricingInfo: ReturnType<typeof getPricingTier>;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={(props) => (
          <div
            {...(props as ComponentPropsWithoutRef<"div">)}
            className={getPricingClassName(pricingInfo, false)}
          >
            {getPricingLabel(pricingInfo)}
          </div>
        )}
      />
      <TooltipContent className="max-w-xs" side="top">
        <p className="font-semibold text-body-sm">Pricing</p>
        <p className="text-foreground-muted text-xs-tight leading-relaxed">
          Approximate cost per 1M tokens for this provider (input/output).
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

interface ProviderCardProps {
  endpoint: OpenRouterEndpoint;
  isSelected: boolean;
  model: OpenRouterModel;
  onSelect: (modelId: string | undefined, providerSlug?: string) => void;
  providerSlug: string;
}

function ProviderCard({
  model,
  endpoint,
  providerSlug,
  isSelected,
  onSelect,
}: ProviderCardProps) {
  const pricingInfo = getPricingTier(endpoint.pricing);
  const selectProvider = () => onSelect(model.id, providerSlug);
  const level = Math.min(useSurface() + 1, 8);
  return (
    <Combobox.Item
      className={getProviderCardClassName(
        isSelected,
        cn(surfaceBg(level), surfaceHoverBg(Math.min(level + 1, 8))),
      )}
      onClick={selectProvider}
      value={`${model.id}@${endpoint.provider_name}`}
    >
      <span className={getSelectionDotClassName(isSelected)} />

      <div className="flex min-w-0 items-center gap-1.5 pe-3">
        <HugeiconsIcon
          className="size-3 shrink-0 text-foreground-muted"
          icon={CpuIcon}
        />
        <span className="truncate font-semibold text-[12px] leading-tight tracking-tight">
          {endpoint.provider_name}
        </span>
      </div>

      <ProviderStatsRow
        contextLength={endpoint.context_length}
        maxOut={endpoint.max_completion_tokens}
      />

      <div className="mt-auto flex items-center justify-between gap-1.5 border-border/50 border-t pt-1">
        <ProviderPricingTooltip pricingInfo={pricingInfo} />
        <EndpointFeatureIcons
          className="gap-1"
          endpoint={endpoint}
          flat
          maxIcons={4}
          size="sm"
        />
      </div>
    </Combobox.Item>
  );
}

interface ProvidersRowProps {
  endpoints: OpenRouterEndpoint[];
  isOpen: boolean;
  model: OpenRouterModel;
  onSelectModel: (modelId: string | undefined, providerSlug?: string) => void;
  parsedModelId: string | undefined;
  parsedProviderSlug: string | undefined;
}

function ProvidersGrid({
  model,
  endpoints,
  parsedModelId,
  parsedProviderSlug,
  onSelectModel,
}: Omit<ProvidersRowProps, "isOpen">) {
  return (
    <div className="ms-6 me-2 mb-1 grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
      {endpoints.map((endpoint) => {
        const providerSlug = getEndpointProviderSlug(endpoint);
        const selected = isProviderSelected(
          model,
          providerSlug,
          parsedModelId,
          parsedProviderSlug,
        );
        return (
          <ProviderCard
            endpoint={endpoint}
            isSelected={selected}
            key={`${model.id}-${providerSlug}`}
            model={model}
            onSelect={onSelectModel}
            providerSlug={providerSlug}
          />
        );
      })}
    </div>
  );
}

function ProvidersRow({
  model,
  endpoints,
  isOpen,
  parsedModelId,
  parsedProviderSlug,
  onSelectModel,
}: ProvidersRowProps) {
  return (
    <Collapsible data-slot="providers-row" isOpen={isOpen}>
      <ProvidersGrid
        endpoints={endpoints}
        model={model}
        onSelectModel={onSelectModel}
        parsedModelId={parsedModelId}
        parsedProviderSlug={parsedProviderSlug}
      />
    </Collapsible>
  );
}

function MakerIcon({ maker }: { maker: string | undefined }) {
  const level = Math.min(useSurface() + 1, 8);
  const providerIcon = resolveMakerIconSrc(maker);
  if (!providerIcon) {
    return null;
  }
  return (
    <span
      className={cn(
        "flex size-4 shrink-0 items-center justify-center overflow-hidden rounded border border-border/50 p-0.5",
        surfaceBg(level),
      )}
    >
      <img
        alt={`${formatMaker(maker)} icon`}
        className="size-full object-contain"
        height={16}
        loading="lazy"
        src={providerIcon}
        width={16}
      />
    </span>
  );
}

function ContextChip({
  contextLength,
}: {
  contextLength: number | null | undefined;
}) {
  if (!isPositiveNumber(contextLength)) {
    return null;
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={(props) => (
          <div
            {...(props as ComponentPropsWithoutRef<"div">)}
            className="inline-flex shrink-0 cursor-default items-center gap-1 text-[11px] text-foreground-muted tabular-nums"
          >
            <HugeiconsIcon
              className="size-3 opacity-70"
              icon={BookOpen02Icon}
            />
            <span>{formatContextLength(contextLength)}</span>
          </div>
        )}
      />
      <TooltipContent className="max-w-xs" side="top">
        <p className="font-semibold text-body-sm">Context window</p>
        <p className="text-foreground-muted text-xs-tight leading-relaxed">
          Maximum tokens this model can read in a single request: prompt plus
          prior conversation.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

function PricingChip({
  pricingInfo,
}: {
  pricingInfo: ReturnType<typeof getPricingTier> | null;
}) {
  if (!pricingInfo) {
    return null;
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={(props) => (
          <div
            {...(props as ComponentPropsWithoutRef<"div">)}
            className={getPricingClassName(pricingInfo, true)}
          >
            {getPricingLabel(pricingInfo)}
          </div>
        )}
      />
      <TooltipContent className="max-w-xs" side="top">
        <p className="font-semibold text-body-sm">Pricing</p>
        <p className="text-foreground-muted text-xs-tight leading-relaxed">
          Approximate cost per 1M tokens (input/output). Expand to compare
          per-provider pricing.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

function FeaturedEndpointChip({
  endpoint,
}: {
  endpoint: OpenRouterEndpoint | null;
}) {
  if (!endpoint) {
    return null;
  }
  return (
    <div className="flex items-center">
      <EndpointFeatureIcons
        className="gap-1"
        endpoint={endpoint}
        flat
        maxIcons={4}
        size="sm"
      />
    </div>
  );
}

function ModalitiesChip({
  modalities,
}: {
  modalities: readonly string[] | undefined;
}) {
  if (!modalities || modalities.length === 0) {
    return null;
  }
  return (
    <div className="flex items-center">
      <ModelModalityIcons
        className="gap-1"
        flat
        maxIcons={4}
        modalities={modalities}
        size="sm"
      />
    </div>
  );
}

/** A faint middot separator between facts in the metadata line. */
function MetaSeparator() {
  return (
    <span aria-hidden="true" className="text-foreground-dim/40">
      ·
    </span>
  );
}

/**
 * The metadata line beneath the model name — variant, context, price, feature
 * glyphs, and input modalities collapsed into ONE calm, left-aligned middot
 * strip (the `CardMetaRow` pattern shared with the STT card). Replaces the old
 * dense right-edge `divide-x` capsule so the facts read as a single scannable
 * row, subordinate to the name by size (11px) and tone (muted) rather than a
 * cluster of competing bordered chips.
 */
function InlineModelMeta({
  model,
  pricingInfo,
  hasProviders,
  uniqueEndpoints,
  hasEndpoints,
  variant,
  variantClasses,
}: {
  model: OpenRouterModel;
  pricingInfo: ReturnType<typeof getPricingTier> | null;
  hasProviders: boolean;
  uniqueEndpoints: OpenRouterEndpoint[];
  hasEndpoints: boolean;
  variant?: OpenRouterModel["variant"];
  variantClasses?: ReturnType<typeof getVariantClasses> | null;
}) {
  const featuredEndpoint = getFeaturedEndpoint(
    uniqueEndpoints,
    hasEndpoints,
    hasProviders,
  );
  const modalities = model.architecture?.input_modalities;
  const hasVariantToken = !!(variant && variantClasses);
  if (
    !(
      hasVariantToken ||
      shouldRenderInlineMeta(
        model.context_length,
        pricingInfo,
        featuredEndpoint,
        modalities,
      )
    )
  ) {
    return null;
  }

  const facts: ReactNode[] = [];
  const pushFact = (node: ReactNode | null) => {
    if (!node) {
      return;
    }
    if (facts.length > 0) {
      facts.push(<MetaSeparator key={`sep-${facts.length}`} />);
    }
    facts.push(node);
  };

  const hasContext = isPositiveNumber(model.context_length);
  pushFact(
    hasVariantToken ? (
      <VariantBadge
        key="variant"
        variant={variant}
        variantClasses={variantClasses}
      />
    ) : null,
  );
  pushFact(
    hasContext ? (
      <ContextChip contextLength={model.context_length} key="context" />
    ) : null,
  );
  pushFact(
    pricingInfo ? <PricingChip key="price" pricingInfo={pricingInfo} /> : null,
  );
  pushFact(
    featuredEndpoint ? (
      <FeaturedEndpointChip endpoint={featuredEndpoint} key="features" />
    ) : null,
  );
  pushFact(
    modalities && modalities.length > 0 ? (
      <ModalitiesChip key="modalities" modalities={modalities} />
    ) : null,
  );

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-foreground-muted leading-tight"
      data-slot="inline-model-meta"
    >
      {facts}
    </div>
  );
}

/**
 * Variant token (Free / Thinking / Nitro / …). Now a QUIET neutral chip that
 * lives in the metadata line beneath the name — not on the name row where it
 * competed with the title. `free` keeps a muted-emerald "cheap" tint; every
 * other variant is fully gray, so the icon shape + label carry the meaning.
 */
function VariantBadge({
  variant,
  variantClasses,
}: {
  variant: OpenRouterModel["variant"];
  variantClasses: ReturnType<typeof getVariantClasses> | null;
}) {
  if (!(variant && variantClasses)) {
    return null;
  }
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-px font-medium text-[10px] uppercase tracking-wide",
        variantClasses.bg,
        variantClasses.text,
      )}
    >
      {getVariantIcon(variant, "size-2.5")}
      {MODEL_VARIANT_INFO[variant]?.label}
    </span>
  );
}

function ModelDescription({
  description,
}: {
  description: string | undefined;
}) {
  if (!description) {
    return null;
  }
  // Rendered as a block `<span>` (not a `<p>`) because it now drops into the
  // universal `ModelCard`'s `description` slot, which itself wraps the node in a
  // `<p>` — a nested `<p>` is invalid HTML. The `ps-[22px]` indent is gone too:
  // the universal card aligns the description as a column child (matching STT),
  // so it no longer needs to hang under the name past the maker icon.
  return (
    <Tooltip>
      <TooltipTrigger
        render={(props) => (
          <span
            {...(props as ComponentPropsWithoutRef<"span">)}
            className="line-clamp-2 cursor-default text-[11px] text-foreground-muted leading-snug"
          >
            {description}
          </span>
        )}
      />
      <TooltipContent
        className="!max-w-[min(32rem,calc(100vw-2rem))] max-h-[60vh] overflow-y-auto"
        side="bottom"
      >
        <p className="whitespace-pre-wrap break-words text-xs-tight leading-relaxed">
          {description}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

function ProvidersExpandButton({
  modelId,
  isExpanded,
  providerCount,
  onToggleExpanded,
}: {
  modelId: string;
  isExpanded: boolean;
  providerCount: number;
  onToggleExpanded: (modelId: string, nextOpen?: boolean) => void;
}) {
  const toggleProvidersList = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onToggleExpanded(modelId, !isExpanded);
  };
  const level = Math.min(useSurface() + 1, 8);
  return (
    <Tooltip>
      <TooltipTrigger
        render={(props) => (
          <BaseButton
            {...(props as ComponentPropsWithoutRef<"button">)}
            aria-expanded={isExpanded}
            aria-label={getExpandAriaLabel(isExpanded, providerCount)}
            className={cn(
              "inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 py-1 font-medium text-[10px] ring-1 transition-colors duration-150",
              isExpanded
                ? "bg-accent/10 text-accent ring-accent/40"
                : cn(
                    surfaceBg(level),
                    surfaceHoverBg(Math.min(level + 1, 8)),
                    "text-foreground-muted ring-divider hover:text-foreground hover:ring-border",
                  ),
            )}
            onClick={toggleProvidersList}
            type="button"
          >
            <HugeiconsIcon className="size-3" icon={ServerStack01Icon} />
            <span className="tabular-nums">{providerCount}</span>
            <HugeiconsIcon
              className={getChevronClassName(isExpanded)}
              icon={ArrowRight01Icon}
            />
          </BaseButton>
        )}
      />
      <TooltipContent className="max-w-xs" side="top">
        <p className="font-semibold text-body-sm">Hosting providers</p>
        <p className="text-foreground-muted text-xs-tight leading-relaxed">
          {getProviderCountTooltip(providerCount)}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The name line. The model name OWNS this line at full body size + semibold
 * (`text-body`, dominant) — the variant badge has moved off it into the meta
 * line below, so the title no longer shares a row with competing metadata.
 */
function ModelHeaderTitleRow({ model }: { model: OpenRouterModel }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <MakerIcon maker={model.maker} />
      <h3 className="min-w-0 truncate font-semibold text-body text-foreground leading-tight tracking-tight">
        {formatModelName(model.model_name ?? model.name, model.maker)}
      </h3>
    </div>
  );
}

interface ModelHeaderProps {
  hasProviders: boolean;
  isExpanded: boolean;
  isFavorite?: ((id: string) => boolean) | undefined;
  model: OpenRouterModel;
  onToggleExpanded: (modelId: string, nextOpen?: boolean) => void;
  onToggleFavorite?: ((id: string) => void) | undefined;
  parsedModelId: string | undefined;
  parsedProviderSlug: string | undefined;
}

function ModelVariantStrip({
  variant,
  variantClasses,
}: {
  variant: OpenRouterModel["variant"];
  variantClasses: ReturnType<typeof getVariantClasses> | null;
}) {
  if (!(variant && variantClasses)) {
    return null;
  }
  return (
    <VariantAccentStrip gradient={variantClasses.gradient} variant={variant} />
  );
}

function ModelHeaderProvidersButton({
  hasProviders,
  isExpanded,
  modelId,
  providerCount,
  onToggleExpanded,
}: {
  hasProviders: boolean;
  isExpanded: boolean;
  modelId: string;
  providerCount: number;
  onToggleExpanded: (modelId: string, nextOpen?: boolean) => void;
}) {
  if (!hasProviders) {
    return null;
  }
  return (
    <ProvidersExpandButton
      isExpanded={isExpanded}
      modelId={modelId}
      onToggleExpanded={onToggleExpanded}
      providerCount={providerCount}
    />
  );
}

function ModelHeader({
  model,
  isExpanded,
  hasProviders,
  parsedModelId,
  parsedProviderSlug,
  onToggleExpanded,
  isFavorite,
  onToggleFavorite,
}: ModelHeaderProps) {
  const state = computeModelHeaderState(
    model,
    parsedModelId,
    parsedProviderSlug,
    hasProviders,
  );
  // The OpenRouter model row is now a thin adapter over the universal
  // `ModelCard` — the SAME card the STT picker renders — so the two pickers
  // share one visual identity. Selection still flows through the combobox value
  // (`value={model.id}` + the root's `onValueChange`); the maker logo, formatted
  // name, meta strip, description, provider-grid expand button, and the
  // three-state selection indicator all map onto the card's slots. The provider
  // grid (`item.type === "providers"`) remains a peer row owned by the list.
  return (
    <ModelCard
      data-model-id={model.id}
      description={
        model.description ? (
          <ModelDescription description={model.description} />
        ) : undefined
      }
      favorite={
        onToggleFavorite
          ? {
              isFavorited: isFavorite?.(model.id) ?? false,
              label: formatModelName(
                model.model_name ?? model.name,
                model.maker,
              ),
              onToggle: () => onToggleFavorite(model.id),
            }
          : undefined
      }
      footer={
        <ModelHeaderProvidersButton
          hasProviders={hasProviders}
          isExpanded={isExpanded}
          modelId={model.id}
          onToggleExpanded={onToggleExpanded}
          providerCount={state.uniqueEndpoints.length}
        />
      }
      indirectlySelected={state.isProviderSelected}
      metaSlot={
        <InlineModelMeta
          hasEndpoints={state.hasEndpoints}
          hasProviders={hasProviders}
          model={model}
          pricingInfo={state.pricingInfo}
          uniqueEndpoints={state.uniqueEndpoints}
          variant={model.variant}
          variantClasses={state.variantClasses}
        />
      }
      name={formatModelName(model.model_name ?? model.name, model.maker)}
      selected={state.isSelected}
      // No leading indicator at all — selection is shown ONLY by the card's
      // accent highlight (CARD_SELECTED), exactly like the STT picker. `false`
      // renders nothing and (unlike null/undefined) overrides ModelCard's
      // default check, so there's no checkbox before the name in any state.
      selectionIndicator={false}
      value={model.id}
    />
  );
}

/** The leading icon for a maker group header: the provider's brand logo when we
 *  have one, else a neutral chip — matching the STT picker's AuthorLabel. */
function MakerHeaderIcon({ maker }: { maker: string }) {
  const iconSrc = resolveMakerIconSrc(maker);
  if (!iconSrc) {
    return <NeutralHeaderIcon icon={CpuIcon} />;
  }
  return (
    <img
      alt=""
      className="size-4 shrink-0 rounded-[3px] object-cover"
      height={16}
      src={publicAsset(iconSrc)}
      width={16}
    />
  );
}

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
