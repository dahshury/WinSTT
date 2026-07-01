/**
 * Shared download-progress arithmetic for STT (`download-store.ts`) and TTS
 * (`use-tts-model-downloads.ts`). Both sides drive a per-(model, quant) snapshot
 * from the same two event sources — a streaming progress chunk and a
 * partial-cache seed — and both must keep the bar monotonic + pause sticky. This
 * module is the single place that arithmetic lives; the audit (H8) flagged the
 * copy-paste between the two sides where bugs accumulated in the TTS copy.
 *
 * Everything here is a pure function. The STT store and the TTS hook each hold
 * their own snapshot SHAPE (STT carries `modelId`/`quantization`/`speedBps`/
 * `owner`, TTS carries only the byte fields), so the merge helpers operate on
 * the byte-field subset both shapes share and let each caller spread the result
 * into its own record.
 */

/** A persisted partial-cache snapshot, as it arrives from the model-state store
 *  (camelCase from the typed DTO, snake_case from raw backend payloads). */
export interface QuantCacheSeedSource {
	downloadedBytes?: number | null;
	downloaded_bytes?: number | null;
	progress?: number | null;
	state?: string;
	totalBytes?: number | null;
	total_bytes?: number | null;
}

/** The live-scale seed derived from a partial cache: 0–100 progress (capped at
 *  99 — 100 is reserved for a fully `cached` model) plus the byte counters. */
export interface QuantDownloadSeed {
	downloadedBytes: number;
	progress: number | null;
	totalBytes: number;
}

/** The byte-field subset shared by every per-quant download snapshot
 *  (STT `QuantDownloadState` and the picker's `QuantDownloadSnapshot` both embed
 *  it). The merge helpers return this so each caller can spread it into its own
 *  shape. */
export interface ProgressSnapshotFields {
	downloadedBytes: number;
	/** 0–100, null = indeterminate (first event hasn't landed yet). */
	progress: number | null;
	totalBytes: number;
}

/** Per-(modelId, quant) live download snapshot a badge reads to flip into
 *  "downloading" / "paused" chrome. The picker's quant shelf, the STT card, and
 *  the TTS download hook all share this exact shape — the byte fields are the
 *  `ProgressSnapshotFields` the merge helpers produce; `paused` is the only
 *  addition. `undefined` at a call site means no active download for that badge.
 *  Lives here (model-download/lib) so both the tts-model-picker feature and the
 *  model-picker widget can depend on it without crossing FSD layers. */
export interface QuantDownloadSnapshot extends ProgressSnapshotFields {
	paused: boolean;
}

/** The four per-quant download controls a badge dispatches. Canonical here so
 *  feature-layer dispatchers don't have to import from the widget. */
export type QuantDownloadAction = "start" | "pause" | "resume" | "cancel";

/** Clamp a backend 0.0–1.0 fraction to an integer 0–100 percent. */
export function percentFromFraction(progress: number): number {
	return Math.max(0, Math.min(100, Math.round(progress * 100)));
}

/** Never let the bar go backwards: keep the larger of the prior and next
 *  percent. A null/undefined prior means "no observation yet" → take next. */
export function monotonicPercent(
	previous: number | null | undefined,
	next: number,
): number {
	return previous == null ? next : Math.max(previous, next);
}

/** Take the larger of the prior progress and the seed's, or keep the prior when
 *  the seed has no progress to contribute. */
export function seedProgress(
	previous: number | null | undefined,
	seed: QuantDownloadSeed | undefined,
): number | null {
	if (seed?.progress == null) {
		return previous ?? null;
	}
	return monotonicPercent(previous, seed.progress);
}

/** Monotonic downloaded-bytes seed: never below the prior nor the seed. */
export function seedDownloadedBytes(
	previous: number | undefined,
	seed: QuantDownloadSeed | undefined,
): number {
	return Math.max(previous ?? 0, seed?.downloadedBytes ?? 0);
}

/** Monotonic total-bytes seed, floored at `downloadedBytes` so the bar can
 *  never report having downloaded more than the total. */
export function seedTotalBytes(
	previous: number | undefined,
	seed: QuantDownloadSeed | undefined,
	downloadedBytes: number,
): number {
	return Math.max(previous ?? 0, seed?.totalBytes ?? 0, downloadedBytes);
}

function cacheBytes(cache: QuantCacheSeedSource | null | undefined): {
	downloaded: number;
	total: number;
} {
	return {
		downloaded: Math.max(
			0,
			cache?.downloadedBytes ?? cache?.downloaded_bytes ?? 0,
		),
		total: Math.max(0, cache?.totalBytes ?? cache?.total_bytes ?? 0),
	};
}

/** Convert a persisted partial-cache snapshot into the live 0-100 snapshot
 *  scale. A partial cache is capped at 99%; 100% is reserved for `cached`. */
export function quantDownloadSeedFromCache(
	cache: QuantCacheSeedSource | null | undefined,
): QuantDownloadSeed | undefined {
	if (cache?.state !== "partial") {
		return undefined;
	}
	const { downloaded, total } = cacheBytes(cache);
	const progressValue = cache?.progress;
	const rawProgress =
		typeof progressValue === "number"
			? Math.round(progressValue * 100)
			: total > 0
				? Math.round((downloaded / total) * 100)
				: null;
	const progress =
		rawProgress == null ? null : Math.min(99, Math.max(0, rawProgress));
	return {
		downloadedBytes: downloaded,
		totalBytes: Math.max(total, downloaded),
		progress,
	};
}

/** Merge a streaming progress event into a snapshot's byte fields, monotonically.
 *  The backend sends a 0.0–1.0 fraction; callers store 0–100. */
export function mergeProgressIntoSnapshot(
	previous: ProgressSnapshotFields | undefined,
	event: { downloadedBytes: number; progress: number; totalBytes: number },
): ProgressSnapshotFields {
	const downloadedBytes = Math.max(
		previous?.downloadedBytes ?? 0,
		event.downloadedBytes,
	);
	return {
		downloadedBytes,
		totalBytes: Math.max(
			previous?.totalBytes ?? 0,
			event.totalBytes,
			downloadedBytes,
		),
		progress: monotonicPercent(
			previous?.progress,
			percentFromFraction(event.progress),
		),
	};
}

/** Merge a partial-cache seed into a snapshot's byte fields, monotonically.
 *  When `previous` is absent the seed becomes the initial snapshot. */
export function mergeSeedIntoSnapshot(
	previous: ProgressSnapshotFields | undefined,
	seed: QuantDownloadSeed | undefined,
): ProgressSnapshotFields {
	const downloadedBytes = seedDownloadedBytes(previous?.downloadedBytes, seed);
	return {
		downloadedBytes,
		totalBytes: seedTotalBytes(previous?.totalBytes, seed, downloadedBytes),
		progress: seedProgress(previous?.progress, seed),
	};
}
