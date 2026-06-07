"use client";

import { BookOpen02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import type { OpenRouterEndpoint, OpenRouterModel } from "@/shared/api/models";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { EndpointFeatureIcons } from "../ui/EndpointFeatureIcons";
import { ModelModalityIcons } from "../ui/ModelModalityIcons";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/Tooltip";
import {
  getFeaturedEndpoint,
  getPricingClassName,
  getPricingLabel,
  isPositiveNumber,
  resolveMakerIconSrc,
  shouldRenderInlineMeta,
} from "./model-list-content-virtualized-utils";
import {
  formatContextLength,
  getPricingTier,
  type getVariantClasses,
  getVariantIcon,
} from "./model-selector-display-utils";
import { formatMaker } from "./model-selector-utils";
import { MODEL_VARIANT_INFO } from "./model-variant-utils";

export function MakerIcon({ maker }: { maker: string | undefined }) {
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
export function InlineModelMeta({
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
export function VariantBadge({
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

export function ModelDescription({
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
