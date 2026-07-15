import {
	CheckmarkCircle02Icon,
	CloudDownloadIcon,
	Download04Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { CacheState, ModelCacheInfo } from "@/shared/api/ipc-client";

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
		className:
			"bg-cache-complete/15 text-cache-complete border-cache-complete/30",
	},
	partial: {
		icon: Download04Icon,
		label: (cache) => `${Math.round(cache.progress * 100)}%`,
		className: "bg-cache-partial/15 text-cache-partial border-cache-partial/30",
	},
	not_cached: {
		icon: CloudDownloadIcon,
		label: () => "Not downloaded",
		className: "bg-surface-4 text-foreground-muted border-border",
	},
};

export function getCachePillConfig(
	cache: ModelCacheInfo | undefined,
): { icon: IconSvgElement; label: string; className: string } | null {
	if (!cache) {
		return null;
	}
	const config = CACHE_PILL_CONFIG[cache.state];
	return {
		icon: config.icon,
		label: config.label(cache),
		className: config.className,
	};
}

export function isCached(cache: ModelCacheInfo | undefined): boolean {
	return cache?.state === "cached";
}
