import { formatBytes } from "@/shared/lib/format-bytes";
import type {
	QuantCacheSnapshot,
	QuantCacheState,
	QuantDownloadSnapshot,
	QuantShelfEntry,
	ResolvedQuantDownloadState,
} from "./quant-shelf-types";

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

/** Idle (non-selected) precision-badge tint, by on-disk state. Muted-semantic
 *  tints (emerald = on disk, amber = partial, neutral = not cached). Exported so
 *  every picker's quant shelf reads with the same palette. */
export function badgeToneForCache(state: QuantCacheState | undefined): string {
	if (state === "cached") {
		return "bg-cache-complete/[0.08] text-cache-complete/80 hover:bg-cache-complete/[0.14]";
	}
	if (state === "partial") {
		return "bg-cache-partial/[0.08] text-cache-partial/80 hover:bg-cache-partial/[0.14]";
	}
	return "bg-foreground/[0.04] text-foreground-muted hover:bg-foreground/[0.08]";
}

/** Percentage [0..100] to amber-fill the badge for an in-progress / partly-cached
 *  quant, or `null` to skip the overlay. Active downloads win over the on-disk
 *  snapshot so the bar ticks live. Exported so the STT latency shelf renders the
 *  identical partial/downloading fill as the precision badges. */
export function resolveProgressFillPct(
	cacheState: QuantCacheState | undefined,
	cacheProgress: number | null,
	download: QuantDownloadSnapshot | undefined,
): number | null {
	if (download && typeof download.progress === "number") {
		return clampPercent(download.progress);
	}
	if (cacheState === "partial") {
		return Math.min(99, clampPercent(Math.round((cacheProgress ?? 0) * 100)));
	}
	return null;
}

function cacheDownloadedBytes(cache: QuantCacheSnapshot | undefined): number {
	return Math.max(0, cache?.downloadedBytes ?? cache?.downloaded_bytes ?? 0);
}

function cacheTotalBytes(cache: QuantCacheSnapshot | undefined): number {
	return Math.max(0, cache?.totalBytes ?? cache?.total_bytes ?? 0);
}

function normalizedCacheState(
	cache: QuantCacheSnapshot | undefined,
): QuantCacheState | undefined {
	if (
		cache?.state === "cached" ||
		cache?.state === "partial" ||
		cache?.state === "not_cached"
	) {
		return cache.state;
	}
	return undefined;
}

function firstPositive(
	values: readonly (number | null | undefined)[],
): number | null {
	for (const value of values) {
		if (typeof value === "number" && value > 0) {
			return value;
		}
	}
	return null;
}

function quantPartialCachePercent(
	cache: QuantCacheSnapshot | undefined,
): number | null {
	if (normalizedCacheState(cache) !== "partial") {
		return null;
	}
	const total = cacheTotalBytes(cache);
	const downloaded = cacheDownloadedBytes(cache);
	const progress = cache?.progress;
	const raw =
		typeof progress === "number"
			? Math.round(progress * 100)
			: total > 0
				? Math.round((downloaded / total) * 100)
				: 0;
	return Math.min(99, clampPercent(raw));
}

function quantCacheStatusLabel(cache: QuantCacheSnapshot | undefined): string {
	const state = normalizedCacheState(cache);
	if (state === "cached") {
		return "Downloaded";
	}
	if (state === "partial") {
		return `${quantPartialCachePercent(cache) ?? 0}% downloaded`;
	}
	return "Not downloaded";
}

export function resolveQuantDownloadState({
	cache,
	canStart = true,
	download,
	fallbackSizeBytes = [],
	hasDownloadAction,
}: {
	cache: QuantCacheSnapshot | undefined;
	canStart?: boolean;
	download: QuantDownloadSnapshot | undefined;
	fallbackSizeBytes?: readonly (number | null | undefined)[];
	hasDownloadAction: boolean;
}): ResolvedQuantDownloadState {
	const state = normalizedCacheState(cache);
	const isCached = state === "cached";
	const isPartial = state === "partial";
	const cacheProgressValue = cache?.progress;
	// A model's download size is a static, known fact: the catalog ships it per
	// quant, so it's authoritative whenever present — full stop. Trusting a
	// runtime number over it is exactly what let a small on-disk artifact (a
	// dedup'd/shared file, or a partial download's progress bytes) masquerade as
	// the real multi-GB size — e.g. a fully-cached cohere q4 showing "2 MB". This
	// mirrors the card-meta resolver (`resolveSttDownloadSizeBytes`).
	const fallbackSize = firstPositive(fallbackSizeBytes);
	const liveSize =
		download && download.totalBytes > 0
			? Math.max(download.totalBytes, download.downloadedBytes)
			: null;
	// On-disk size: trust the cache's real *total* (valid for cached and partial),
	// and its downloaded bytes ONLY when fully cached (then downloaded == size).
	// A partial's downloaded bytes are progress, not size — never surface them.
	const cacheTotal = cacheTotalBytes(cache);
	const cacheDownloaded = cacheDownloadedBytes(cache);
	const cacheSize =
		cacheTotal > 0
			? cacheTotal
			: isCached && cacheDownloaded > 0
				? cacheDownloaded
				: null;
	return {
		cacheState: state,
		cacheProgress:
			isPartial && typeof cacheProgressValue === "number"
				? Math.min(0.99, Math.max(0, cacheProgressValue))
				: null,
		cacheStatusLabel: quantCacheStatusLabel(cache),
		downloadSizeBytes: fallbackSize ?? liveSize ?? cacheSize,
		isCached,
		isPartial,
		canResumeDownload: isPartial && hasDownloadAction,
		canStartDownload:
			canStart &&
			!(download !== undefined || isCached || isPartial) &&
			hasDownloadAction,
	};
}

function formatQuantDownloadSize(entry: QuantShelfEntry): string {
	if (entry.download !== undefined && entry.download.totalBytes > 0) {
		return (
			formatBytes(
				Math.max(entry.download.totalBytes, entry.download.downloadedBytes),
				{ minUnit: "B" },
			) ?? "Unknown"
		);
	}
	const label = entry.downloadSizeLabel?.trim();
	if (label) {
		return label;
	}
	return formatBytes(entry.downloadSizeBytes, { minUnit: "B" }) ?? "Unknown";
}

export function buildQuantTooltipContent(
	entry: QuantShelfEntry,
	actionHint: string | null,
): string {
	const lines = [
		`${entry.label}${entry.isRecommended ? " (recommended)" : ""}`,
		`Status: ${
			actionHint
				? `${entry.cacheStatusLabel}. ${actionHint}`
				: entry.cacheStatusLabel
		}`,
		`Download size: ${formatQuantDownloadSize(entry)}`,
	];
	const detail = entry.tooltip.trim();
	if (detail.length > 0) {
		lines.push(`Precision: ${detail}`);
	}
	return lines.join("\n");
}
