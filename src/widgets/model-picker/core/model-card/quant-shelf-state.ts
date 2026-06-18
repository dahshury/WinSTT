import { formatBytes } from "@/shared/lib/format-bytes";
import type {
	QuantCacheSnapshot,
	QuantCacheState,
	QuantDownloadSnapshot,
	QuantShelfEntry,
	ResolvedQuantDownloadState,
} from "./QuantShelf";

export function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
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
	const fallbackSize = firstPositive(fallbackSizeBytes);
	const liveSize =
		download && download.totalBytes > 0
			? Math.max(download.totalBytes, download.downloadedBytes)
			: null;
	const cacheSize =
		cache && (cacheTotalBytes(cache) > 0 || cacheDownloadedBytes(cache) > 0)
			? Math.max(cacheTotalBytes(cache), cacheDownloadedBytes(cache))
			: null;
	const cacheOrCatalogSize =
		isPartial && fallbackSize !== null
			? Math.max(fallbackSize, cacheSize ?? 0)
			: cacheSize;
	return {
		cacheState: state,
		cacheProgress:
			isPartial && typeof cacheProgressValue === "number"
				? Math.min(0.99, Math.max(0, cacheProgressValue))
				: null,
		cacheStatusLabel: quantCacheStatusLabel(cache),
		downloadSizeBytes: liveSize ?? cacheOrCatalogSize ?? fallbackSize,
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
