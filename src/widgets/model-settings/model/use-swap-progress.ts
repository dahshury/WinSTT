import { useModelSwapStore } from "@/entities/model-catalog";
import {
	aggregateDownloadEntries,
	collectDownloadEntries,
	type DownloadEntry,
	type QuantDownloadState,
	type SttDownloadOwner,
	useDownloadStore,
} from "@/features/model-download";

export interface DownloadProgressPropShape {
	/** Mean percent across every active download; null when all in-flight
	 *  downloads are still in their indeterminate first-tick window. */
	averagePercent: number | null;
	/** Total active downloads (per-quant entries + the legacy singleton
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
	/** Aggregate view of every active download. Null when idle. Kept for
	 *  all-download consumers/tests; the two in-panel selector triggers use
	 *  the scoped fields below so one background download does not paint both. */
	downloadProgress: DownloadProgressPropShape | null;
	/** Active downloads that should paint the main model selector trigger. */
	mainDownloadProgress: DownloadProgressPropShape | null;
	/** Active downloads that should paint the realtime model selector trigger. */
	realtimeDownloadProgress: DownloadProgressPropShape | null;
	/** True when the server is loading main-model weights (no bytes left to fetch). */
	mainSwapping: boolean;
	/** True when the server is loading realtime-model weights. */
	realtimeSwapping: boolean;
}

interface SingletonDownload {
	active: boolean;
	modelId: string | null;
	percent: number | null;
}

function aggregateEntries(
	entries: readonly DownloadEntry[],
): DownloadProgressPropShape | null {
	const aggregate = aggregateDownloadEntries(entries);
	if (aggregate === null) {
		return null;
	}
	return {
		count: aggregate.count,
		averagePercent: aggregate.averagePercent,
		modelId: aggregate.primary.modelId,
		percent: aggregate.primary.percent,
	};
}

function inferUnownedOwner(
	modelId: string,
	mainSwapTarget: string | null,
	realtimeSwapTarget: string | null,
): SttDownloadOwner {
	return realtimeSwapTarget === modelId && mainSwapTarget !== modelId
		? "realtime"
		: "main";
}

function quantOwner(
	entry: QuantDownloadState,
	mainSwapTarget: string | null,
	realtimeSwapTarget: string | null,
): SttDownloadOwner {
	return (
		entry.owner ??
		inferUnownedOwner(entry.modelId, mainSwapTarget, realtimeSwapTarget)
	);
}

function singletonOwner(
	singleton: SingletonDownload,
	mainSwapTarget: string | null,
	realtimeSwapTarget: string | null,
): SttDownloadOwner {
	return singleton.modelId === null
		? "main"
		: inferUnownedOwner(singleton.modelId, mainSwapTarget, realtimeSwapTarget);
}

function collectEntries(
	quantDownloads: Record<string, QuantDownloadState>,
	singleton: SingletonDownload,
	mainSwapTarget: string | null,
	realtimeSwapTarget: string | null,
	owner?: SttDownloadOwner,
): DownloadEntry[] {
	return collectDownloadEntries(quantDownloads, singleton, {
		includeSingleton:
			owner === undefined ||
			singletonOwner(singleton, mainSwapTarget, realtimeSwapTarget) === owner,
		includeQuant:
			owner === undefined
				? undefined
				: (entry) =>
						quantOwner(entry, mainSwapTarget, realtimeSwapTarget) === owner,
	});
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
	const quantDownloads = useDownloadStore((s) => s.quantDownloads);
	const singletonModelId = useDownloadStore((s) => s.modelName);
	const singletonActive = useDownloadStore((s) => s.isDownloading);
	const singletonPercent = useDownloadStore((s) => s.progress);
	const singleton = {
		active: singletonActive,
		modelId: singletonModelId,
		percent: singletonPercent,
	};
	const downloadProgress = aggregateEntries(
		collectEntries(
			quantDownloads,
			singleton,
			mainSwapTarget,
			realtimeSwapTarget,
		),
	);
	const mainDownloadProgress = aggregateEntries(
		collectEntries(
			quantDownloads,
			singleton,
			mainSwapTarget,
			realtimeSwapTarget,
			"main",
		),
	);
	const realtimeDownloadProgress = aggregateEntries(
		collectEntries(
			quantDownloads,
			singleton,
			mainSwapTarget,
			realtimeSwapTarget,
			"realtime",
		),
	);
	// The swap-active-but-downloading guard reads the *primary* download's
	// modelId. A user kicking off multiple per-quant downloads while a swap
	// to one of them is in flight only freezes the picker if THAT swap
	// target is also the highest-progress download — other concurrent
	// downloads (e.g. precaching a second quant) shouldn't change the swap
	// gate.
	const mainSwapping =
		mainSwapTarget !== null &&
		!(mainDownloadProgress && mainDownloadProgress.modelId === mainSwapTarget);
	const realtimeSwapping =
		realtimeSwapTarget !== null &&
		!(
			realtimeDownloadProgress &&
			realtimeDownloadProgress.modelId === realtimeSwapTarget
		);
	return {
		downloadProgress,
		mainDownloadProgress,
		realtimeDownloadProgress,
		mainSwapping,
		realtimeSwapping,
	};
}
