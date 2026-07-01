import type {
	QuantDownloadAction,
	QuantDownloadSnapshot,
} from "@/features/model-download";

/** On-disk cache state of a single quantization (mirrors the server `CacheState`). */
export type QuantCacheState = "cached" | "partial" | "not_cached";

/** Re-export the canonical per-quant download types from the model-download
 *  feature. They live there (not here) so feature-layer dispatchers can depend
 *  on them without importing from this widget; the picker keeps importing them
 *  through this barrel for convenience. */
export type { QuantDownloadAction, QuantDownloadSnapshot };

/** Backend cache snapshots are snake_case for STT and camelCase for TTS.
 *  Normalize both shapes here so every picker derives badge status, progress,
 *  and action availability from one implementation. */
export interface QuantCacheSnapshot {
	downloadedBytes?: number | null;
	downloaded_bytes?: number | null;
	progress?: number | null;
	state?: QuantCacheState | string | null;
	totalBytes?: number | null;
	total_bytes?: number | null;
}

export interface ResolvedQuantDownloadState {
	cacheProgress: number | null;
	cacheState: QuantCacheState | undefined;
	cacheStatusLabel: string;
	canResumeDownload: boolean;
	canStartDownload: boolean;
	downloadSizeBytes: number | null;
	isCached: boolean;
	isPartial: boolean;
}

/**
 * One precision badge, fully normalized by the picker adapter so the shelf
 * stays state-shape agnostic. `value` is the badge's own precision id (the
 * select / start-download target); `actionQuant` is the concrete precision the
 * pause/resume/cancel/delete controls act on (they diverge only for a router
 * badge like TTS "Auto", whose actions target the server's effective quant).
 */
export interface QuantShelfEntry {
	/** Concrete precision the trailing pause/resume/cancel/delete controls act on. */
	actionQuant: string;
	/** Partial-download fraction (0..1) for the amber background fill, or null. */
	cacheProgress: number | null;
	/** On-disk state of `actionQuant`. */
	cacheState: QuantCacheState | undefined;
	/** Human status phrase for the tooltip ("Downloaded" / "47% downloaded" / …). */
	cacheStatusLabel: string;
	/** Body-click starts a background download (uncached concrete badge + dispatcher present). */
	canStartDownload: boolean;
	/** Show the trailing delete control (on disk + deleter present + not a router badge). */
	canDelete: boolean;
	/** Show resume/cancel controls for a paused resumable download. */
	canResumeDownload?: boolean;
	/** Live download snapshot for `actionQuant`, if any. */
	download: QuantDownloadSnapshot | undefined;
	/** Download size for this exact precision, when the catalog exposes it. */
	downloadSizeBytes?: number | null;
	/** Preformatted download size label, used when a backend already scraped one. */
	downloadSizeLabel?: string | null;
	/** This badge is the active / selected precision. */
	isActive: boolean;
	/** Mark with the sparkle + "(recommended for your hardware)" aria suffix. */
	isRecommended: boolean;
	/** Human label ("fp16" / "fp32" / "Auto"). */
	label: string;
	/** Render label in monospace for backend tag ids such as `q4_K_M`. */
	mono?: boolean;
	/** Full precision-explanation tooltip text. */
	tooltip: string;
	/** Badge precision id — the select / start-download value. `""` is allowed. */
	value: string;
	/** Optional backing model id when one visible card fronts multiple repos. */
	modelId?: string;
}

export interface QuantShelfProps {
	entries: readonly QuantShelfEntry[];
	modelDisplayName: string;
	modelId: string;
	/** Single dispatch for the four per-quant download actions. */
	onDownloadAction?:
		| ((
				action: QuantDownloadAction,
				modelId: string,
				quantization: string,
		  ) => void)
		| undefined;
	/** Trash-icon handler — when omitted, no delete control is rendered. */
	onRequestDeleteQuant?:
		| ((
				modelId: string,
				quantization: string,
				displayName: string,
				quantLabel: string,
		  ) => void)
		| undefined;
	onSelect: (modelId: string, quantization: string) => void;
	showIcon?: boolean;
}
