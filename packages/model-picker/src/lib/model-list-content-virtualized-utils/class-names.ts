import type { OpenRouterModel } from "@/shared/api/models";
import { cn } from "@/shared/lib/cn";
import { getPricingTier } from "../model-selector-display-utils";
import type { SelectionFlags } from "./header";

type ModelVariantKey = NonNullable<OpenRouterModel["variant"]>;

// fluidfunctionalism: the decorative top variant strip is redundant with the
// variant badge, so every variant now paints the SAME quiet neutral hairline
// instead of a 7-hue rainbow ribbon. Color is reserved for selection; the strip
// is just a faint structural seam at the card's top edge.
const NEUTRAL_VARIANT_HAIRLINE = "from-foreground/[0.10] via-foreground/[0.04]";
export const VARIANT_GRADIENT_MAP: Record<ModelVariantKey, string> = {
	free: NEUTRAL_VARIANT_HAIRLINE,
	nitro: NEUTRAL_VARIANT_HAIRLINE,
	thinking: NEUTRAL_VARIANT_HAIRLINE,
	extended: NEUTRAL_VARIANT_HAIRLINE,
	exacto: NEUTRAL_VARIANT_HAIRLINE,
	floor: NEUTRAL_VARIANT_HAIRLINE,
	online: NEUTRAL_VARIANT_HAIRLINE,
};

const MODEL_CARD_BASE_CLASSES = cn(
	"group/card relative flex items-stretch rounded-md border p-0 transition-[color,background-color,border-color,box-shadow] duration-200",
	"border-border bg-surface-secondary/60",
	"hover:border-border-hover hover:bg-surface-hover/60 hover:shadow-md"
);
// Restrained selection accent — matches the canonical FF card-selected string
// (also used by the STT picker) so a selected OpenRouter model reads with the
// same warm Docker-blue wash + ring across both pickers.
const MODEL_CARD_SELECTED_CLASSES = cn(
	"border-accent/55 bg-accent/[0.09] shadow-surface-3 ring-1 ring-accent/25",
	"hover:border-accent/70 hover:bg-accent/[0.12]"
);

export function isAnyModelSelected(flags: SelectionFlags): boolean {
	return flags.isSelected || flags.isProviderSelected;
}

export function getModelCardClassName(flags: SelectionFlags): string {
	return cn(MODEL_CARD_BASE_CLASSES, isAnyModelSelected(flags) && MODEL_CARD_SELECTED_CLASSES);
}

const PROVIDER_CARD_BASE_CLASSES = cn(
	"group/provider relative flex h-full cursor-pointer flex-col gap-1 rounded-md p-2 ring-1 ring-divider transition-[color,background-color,box-shadow] duration-200",
	"hover:shadow-sm hover:ring-border"
);
const PROVIDER_CARD_SELECTED_CLASSES = "bg-accent/10 ring-1 ring-accent/40";

// `idleSurface` carries the substrate-relative surfaceBg/hover the caller computes
// from `useSurface()` (this helper can't call hooks) so each provider card reads
// as its OWN lifted surface instead of a flat token that blends into the popup bg.
export function getProviderCardClassName(isSelected: boolean, idleSurface = ""): string {
	return cn(PROVIDER_CARD_BASE_CLASSES, isSelected ? PROVIDER_CARD_SELECTED_CLASSES : idleSurface);
}

const SELECTION_DOT_BASE =
	"absolute end-1.5 top-1.5 size-2 rounded-full transition-[background-color,box-shadow] duration-200";
const SELECTION_DOT_SELECTED = "bg-accent shadow-[0_0_4px_var(--color-accent-glow-strong)]";
const SELECTION_DOT_IDLE = "bg-transparent ring-1 ring-border/50 group-hover/provider:ring-border";

export function getSelectionDotClassName(isSelected: boolean): string {
	return cn(SELECTION_DOT_BASE, isSelected ? SELECTION_DOT_SELECTED : SELECTION_DOT_IDLE);
}

export function getNonFreeBaseTextColor(_withForegroundFallback: boolean): string {
	// fluidfunctionalism: paid pricing is a single muted scale — the $/M numbers
	// carry the magnitude, so the text stays calmly muted regardless of context.
	return "text-foreground-muted";
}

export function getPricingBaseTextColor(
	pricingInfo: ReturnType<typeof getPricingTier>,
	withForegroundFallback: boolean
): string {
	if (pricingInfo.tier === "free") {
		// Muted emerald — a gentle "cheap" signal, not a glowing badge.
		return "text-emerald-300/80";
	}
	return getNonFreeBaseTextColor(withForegroundFallback);
}

export function getPricingExtraClass(
	pricingInfo: ReturnType<typeof getPricingTier>
): string | false {
	return pricingInfo.tier === "free" ? false : pricingInfo.className;
}

export function getPricingClassName(
	pricingInfo: ReturnType<typeof getPricingTier>,
	withForegroundFallback: boolean
): string {
	return cn(
		"flex cursor-default items-center font-semibold text-[11px] tabular-nums",
		getPricingBaseTextColor(pricingInfo, withForegroundFallback),
		getPricingExtraClass(pricingInfo)
	);
}

export function getPricingLabel(pricingInfo: ReturnType<typeof getPricingTier>): string {
	return pricingInfo.tier === "free" ? "Free" : pricingInfo.label;
}

export function getProvidersRowState(isOpen: boolean): "open" | "closed" {
	return isOpen ? "open" : "closed";
}

export function getProvidersGridTemplateRows(isOpen: boolean): string {
	return isOpen ? "1fr" : "0fr";
}

export function getExpandAriaLabel(isExpanded: boolean, providerCount: number): string {
	const verb = isExpanded ? "Hide" : "Show";
	return `${verb} ${providerCount} hosting providers`;
}

const EXPAND_BUTTON_BASE = cn(
	"flex w-11 shrink-0 flex-col items-center justify-center gap-0.5 self-stretch border-border border-s font-medium text-[10px] transition-colors duration-150",
	// Idle hover is neutral (FF: accent is reserved for the active/expanded state
	// + selection + focus). The expanded state below carries the lone accent.
	"text-foreground-muted hover:bg-foreground/[0.08] hover:text-foreground active:bg-foreground/[0.10]"
);

export function getExpandButtonClassName(isExpanded: boolean): string {
	return cn(EXPAND_BUTTON_BASE, isExpanded && "bg-accent/10 text-accent");
}

export function getChevronClassName(isExpanded: boolean): string {
	return cn("size-3 transition-transform duration-200", isExpanded && "rotate-90");
}

export function getProviderCountTooltip(providerCount: number): string {
	const verb = providerCount === 1 ? " hosts" : "s host";
	return `${providerCount} provider${verb} this model. Tap to compare pricing, latency, and features.`;
}

export interface SelectionState {
	kind: "selected" | "provider" | "none";
}

export function getSelectionState(
	isSelected: boolean,
	isProviderSelected: boolean
): SelectionState {
	if (isSelected) {
		return { kind: "selected" };
	}
	if (isProviderSelected) {
		return { kind: "provider" };
	}
	return { kind: "none" };
}

export function getSelectionProviderTooltip(selectedProviderName: string | undefined): string {
	return selectedProviderName ? `Provider: ${selectedProviderName}` : "Provider selected";
}

export type { ModelVariantKey };
