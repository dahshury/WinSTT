import { useModelSwapStore } from "@/entities/model-catalog";
import { useDownloadAggregate } from "@/features/model-download";

export interface DownloadProgressPropShape {
	/** Mean percent across every active download; null when all in-flight
	 *  downloads are still in their indeterminate first-tick window. */
	averagePercent: number | null;
	/** Total in-flight downloads (per-quant entries + the legacy singleton
	 *  whole-model swap slot). ``1`` renders the trigger's single-download
	 *  view; ``>=2`` switches it to the aggregate "Downloading N items · X%"
	 *  view. */
	count: number;
	/** Single-download view fields — the model the chip / trigger should
	 *  name when only one download is running (also the highest-progress
	 *  candidate when several are). */
	modelId: string;
	percent: number | null;
}

export interface SwapProgressSnapshot {
	/** Aggregate view of every active download. Null when idle. The picker
	 *  trigger renders single-vs-multi chrome off ``count``, the status-bar
	 *  chip shows the same numbers from the outside. Both surfaces share
	 *  ``useDownloadAggregate`` so they never disagree. */
	downloadProgress: DownloadProgressPropShape | null;
	/** True when the server is loading main-model weights (no bytes left to fetch). */
	mainSwapping: boolean;
	/** True when the server is loading realtime-model weights. */
	realtimeSwapping: boolean;
}

/**
 * Splits "downloading bytes" (the user can still pick another already-cached
 * model) from "loading weights" (server is restarting / mid-load; the picker
 * must freeze until it settles). The two states are different sub-phases of a
 * swap and the old `activeMain !== null` gate conflated them, which is why
 * selecting Cohere locked the picker into "Switching to Cohere" for the
 * entire 4 GB transfer.
 *
 * Per-quant streaming downloads (the new download-from-the-badge flow) DON'T
 * go through the swap store at all — they live in ``quantDownloads`` instead.
 * The aggregate captures both pathways so the trigger reflects "Downloading
 * <model> X%" or "Downloading N items · X%" regardless of which side kicked
 * off the bytes.
 */
export function useSwapProgress(): SwapProgressSnapshot {
	const mainSwapTarget = useModelSwapStore((s) => s.activeMain);
	const realtimeSwapTarget = useModelSwapStore((s) => s.activeRealtime);
	const aggregate = useDownloadAggregate();
	const downloadProgress: DownloadProgressPropShape | null = aggregate
		? {
				count: aggregate.count,
				averagePercent: aggregate.averagePercent,
				modelId: aggregate.primary.modelId,
				percent: aggregate.primary.percent,
			}
		: null;
	// The swap-active-but-downloading guard reads the *primary* download's
	// modelId. A user kicking off multiple per-quant downloads while a swap
	// to one of them is in flight only freezes the picker if THAT swap
	// target is also the highest-progress download — other concurrent
	// downloads (e.g. precaching a second quant) shouldn't change the swap
	// gate.
	const mainSwapping =
		mainSwapTarget !== null && !(downloadProgress && downloadProgress.modelId === mainSwapTarget);
	const realtimeSwapping =
		realtimeSwapTarget !== null &&
		!(downloadProgress && downloadProgress.modelId === realtimeSwapTarget);
	return { downloadProgress, mainSwapping, realtimeSwapping };
}
