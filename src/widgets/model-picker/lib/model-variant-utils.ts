/**
 * OpenRouter Model Variant Utilities
 *
 * Model variants are suffixes appended to model IDs that specify different
 * routing or pricing behaviors:
 * - :free - Free version of the model
 * - :extended - Extended context version
 * - :nitro - Higher throughput (sort by throughput)
 * - :floor - Lowest price (sort by price)
 * - :thinking - Reasoning/thinking enabled models
 * - :online - Online/real-time capable models
 */

export const MODEL_VARIANTS = [
	"free",
	"extended",
	"exacto",
	"nitro",
	"floor",
	"thinking",
	"online",
] as const;

export type ModelVariant = (typeof MODEL_VARIANTS)[number];

export interface ModelVariantInfo {
	bgClass: string;
	borderClass: string;
	description: string;
	gradientClass: string;
	icon?: string;
	id: ModelVariant;
	label: string;
	textClass: string;
}

// fluidfunctionalism: variants are a quiet GRAY meta token, not a 7-hue rainbow.
// Every variant now shares the same neutral treatment (faint foreground-tinted
// fill + muted foreground text), so the variant badge, the (now-neutral) top
// strip, and the variant filter chips all read as restrained gray differentiation
// — the icon shape + label carry the meaning, color does not. The ONE exception
// kept slightly tinted is `free` (a genuine "cheap" signal), desaturated to a
// muted emerald in line with the picker's free-pricing scale.
const NEUTRAL_VARIANT_CHROME = {
	bgClass: "bg-foreground/[0.04]",
	textClass: "text-foreground-muted",
	borderClass: "border-border/60",
	gradientClass: "from-foreground/[0.06] via-transparent to-transparent",
} as const;

const FREE_VARIANT_CHROME = {
	bgClass: "bg-emerald-500/[0.08]",
	textClass: "text-emerald-300/80",
	borderClass: "border-emerald-500/20",
	gradientClass: "from-emerald-500/[0.06] via-transparent to-transparent",
} as const;

export const MODEL_VARIANT_INFO: Record<ModelVariant, ModelVariantInfo> = {
	free: {
		id: "free",
		label: "Free",
		description: "Free version with possible rate limits",
		...FREE_VARIANT_CHROME,
	},
	extended: {
		id: "extended",
		label: "Extended",
		description: "Extended context window version",
		...NEUTRAL_VARIANT_CHROME,
	},
	exacto: {
		id: "exacto",
		label: "Exacto",
		description: "High precision/accuracy version",
		...NEUTRAL_VARIANT_CHROME,
	},
	nitro: {
		id: "nitro",
		label: "Nitro",
		description: "Higher throughput routing",
		...NEUTRAL_VARIANT_CHROME,
	},
	floor: {
		id: "floor",
		label: "Floor",
		description: "Lowest price routing",
		...NEUTRAL_VARIANT_CHROME,
	},
	thinking: {
		id: "thinking",
		label: "Thinking",
		description: "Reasoning/thinking enabled",
		...NEUTRAL_VARIANT_CHROME,
	},
	online: {
		id: "online",
		label: "Online",
		description: "Real-time/online capable",
		...NEUTRAL_VARIANT_CHROME,
	},
};

export function hasVariant(modelId: string, variant: ModelVariant): boolean {
	return modelId.endsWith(`:${variant}`);
}

export function hasAnyVariant(modelId: string): boolean {
	return MODEL_VARIANTS.some((v) => modelId.endsWith(`:${v}`));
}
