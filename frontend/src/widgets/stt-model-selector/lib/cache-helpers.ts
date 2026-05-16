import {
	CheckmarkCircle02Icon,
	CloudDownloadIcon,
	Download04Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { CacheState, ModelCacheInfo, ModelStateEntry } from "@/shared/api/ipc-client";

interface CachePillConfig {
	/** Tailwind classes for the cache pill (background + foreground + border). */
	className: string;
	icon: IconSvgElement;
	label: (cache: ModelCacheInfo) => string;
}

const CACHE_PILL_CONFIG: Record<CacheState, CachePillConfig> = {
	cached: {
		icon: CheckmarkCircle02Icon,
		label: () => "Downloaded",
		className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
	},
	partial: {
		icon: Download04Icon,
		label: (cache) => `${Math.round(cache.progress * 100)}%`,
		className: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
	},
	not_cached: {
		icon: CloudDownloadIcon,
		label: () => "Not downloaded",
		className: "bg-surface-secondary text-foreground-muted border-border",
	},
};

/**
 * Resolve the cache info for a specific quantization. Falls back to the flat
 * overall `cache` for legacy aliases that report no per-quant breakdown.
 */
export function resolveQuantCache(
	entry: ModelStateEntry | undefined,
	quantization: string
): ModelCacheInfo | undefined {
	if (!entry) {
		return;
	}
	return entry.cache_by_quantization?.[quantization] ?? entry.cache;
}

export function getCachePillConfig(
	cache: ModelCacheInfo | undefined
): { icon: IconSvgElement; label: string; className: string } | null {
	if (!cache) {
		return null;
	}
	const config = CACHE_PILL_CONFIG[cache.state];
	return { icon: config.icon, label: config.label(cache), className: config.className };
}

export function isCached(cache: ModelCacheInfo | undefined): boolean {
	return cache?.state === "cached";
}
