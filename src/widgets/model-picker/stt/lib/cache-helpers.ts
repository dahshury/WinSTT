import {
	CheckmarkCircle02Icon,
	CloudDownloadIcon,
	Download04Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type {
	CacheState,
	ModelCacheInfo,
	ModelStateEntry,
} from "@/shared/api/ipc-client";

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

/**
 * Resolve the cache info for a specific quantization. Falls back to the flat
 * overall `cache` for legacy aliases that report no per-quant breakdown.
 */
export function resolveQuantCache(
	entry: ModelStateEntry | undefined,
	quantization: string,
): ModelCacheInfo | undefined {
	if (!entry) {
		return;
	}
	return entry.cache_by_quantization?.[quantization] ?? entry.cache;
}

/**
 * The precision the server will *actually* load for a given selection.
 *
 * The auto sentinel (`"auto"`) is re-resolved by the server per model — its
 * RAM/VRAM-aware `fit_aware_auto_quant` picks the best-fitting precision for
 * the user's hardware (e.g. fp16 on a DirectML GPU, int8 on CPU). The server
 * surfaces that decision as `entry.effective_quantization`. NOTE: `""` is NO
 * LONGER auto — it now means EXPLICIT fp32 (the full base export), so it passes
 * through unchanged like any other concrete pick.
 * So when the user is on auto (selection is `"auto"`), honor the server's
 * effective precision; concrete picks (incl `""` = fp32, plus int8 / fp16 / …)
 * and entries without the field pass through unchanged.
 *
 * Without this, the download gate checks the default-export's cache state
 * (often on disk) for a model the server will load as `int8` (often NOT on
 * disk) — so clicking it silently kicks off a background download instead of
 * prompting. See the canary-1b-flash repro.
 */
export function resolveEffectiveQuant(
	entry: ModelStateEntry | undefined,
	selectedQuant: string,
): string {
	// Check PRESENCE, not truthiness: `effective_quantization` can legitimately be
	// "" (the recommended pick IS fp32), which must still override the "auto"
	// sentinel. Only an older server that omits the field (undefined) falls through.
	const effective = entry?.effective_quantization;
	if (selectedQuant === "auto" && effective !== undefined) {
		return effective;
	}
	return selectedQuant;
}

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
