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

export const MODEL_VARIANT_INFO: Record<ModelVariant, ModelVariantInfo> = {
	free: {
		id: "free",
		label: "Free",
		description: "Free version with possible rate limits",
		bgClass: "bg-emerald-500/10 dark:bg-emerald-500/15",
		textClass: "text-emerald-700 dark:text-emerald-400",
		borderClass: "border-emerald-500/30 dark:border-emerald-500/40",
		gradientClass: "from-emerald-500/5 via-transparent to-transparent",
	},
	extended: {
		id: "extended",
		label: "Extended",
		description: "Extended context window version",
		bgClass: "bg-blue-500/10 dark:bg-blue-500/15",
		textClass: "text-blue-700 dark:text-blue-400",
		borderClass: "border-blue-500/30 dark:border-blue-500/40",
		gradientClass: "from-blue-500/5 via-transparent to-transparent",
	},
	exacto: {
		id: "exacto",
		label: "Exacto",
		description: "High precision/accuracy version",
		bgClass: "bg-rose-500/10 dark:bg-rose-500/15",
		textClass: "text-rose-700 dark:text-rose-400",
		borderClass: "border-rose-500/30 dark:border-rose-500/40",
		gradientClass: "from-rose-500/5 via-transparent to-transparent",
	},
	nitro: {
		id: "nitro",
		label: "Nitro",
		description: "Higher throughput routing",
		bgClass: "bg-amber-500/10 dark:bg-amber-500/15",
		textClass: "text-amber-700 dark:text-amber-400",
		borderClass: "border-amber-500/30 dark:border-amber-500/40",
		gradientClass: "from-amber-500/5 via-transparent to-transparent",
	},
	floor: {
		id: "floor",
		label: "Floor",
		description: "Lowest price routing",
		bgClass: "bg-cyan-500/10 dark:bg-cyan-500/15",
		textClass: "text-cyan-700 dark:text-cyan-400",
		borderClass: "border-cyan-500/30 dark:border-cyan-500/40",
		gradientClass: "from-cyan-500/5 via-transparent to-transparent",
	},
	thinking: {
		id: "thinking",
		label: "Thinking",
		description: "Reasoning/thinking enabled",
		bgClass: "bg-violet-500/10 dark:bg-violet-500/15",
		textClass: "text-violet-700 dark:text-violet-400",
		borderClass: "border-violet-500/30 dark:border-violet-500/40",
		gradientClass: "from-violet-500/5 via-transparent to-transparent",
	},
	online: {
		id: "online",
		label: "Online",
		description: "Real-time/online capable",
		bgClass: "bg-sky-500/10 dark:bg-sky-500/15",
		textClass: "text-sky-700 dark:text-sky-400",
		borderClass: "border-sky-500/30 dark:border-sky-500/40",
		gradientClass: "from-sky-500/5 via-transparent to-transparent",
	},
};

export function parseModelVariant(modelId: string): {
	baseModelId: string;
	variant: ModelVariant | undefined;
} {
	for (const variant of MODEL_VARIANTS) {
		const suffix = `:${variant}`;
		if (modelId.endsWith(suffix)) {
			return {
				baseModelId: modelId.slice(0, -suffix.length),
				variant,
			};
		}
	}
	return { baseModelId: modelId, variant: undefined };
}

export function getModelVariant(modelId: string): ModelVariant | undefined {
	return parseModelVariant(modelId).variant;
}

export function getBaseModelId(modelId: string): string {
	return parseModelVariant(modelId).baseModelId;
}

export function hasVariant(modelId: string, variant: ModelVariant): boolean {
	return modelId.endsWith(`:${variant}`);
}

export function hasAnyVariant(modelId: string): boolean {
	return MODEL_VARIANTS.some((v) => modelId.endsWith(`:${v}`));
}

export function setModelVariant(modelId: string, variant: ModelVariant | undefined): string {
	const baseId = getBaseModelId(modelId);
	return variant ? `${baseId}:${variant}` : baseId;
}

export function getAvailableVariants(modelIds: string[]): ModelVariant[] {
	const variants = new Set<ModelVariant>();
	for (const modelId of modelIds) {
		const variant = getModelVariant(modelId);
		if (variant) {
			variants.add(variant);
		}
	}
	return Array.from(variants).sort((a, b) => {
		const aIndex = MODEL_VARIANTS.indexOf(a);
		const bIndex = MODEL_VARIANTS.indexOf(b);
		return aIndex - bIndex;
	});
}

export function filterByVariant(modelIds: string[], variant: ModelVariant | undefined): string[] {
	if (!variant) {
		return modelIds.filter((id) => !hasAnyVariant(id));
	}
	return modelIds.filter((id) => hasVariant(id, variant));
}
