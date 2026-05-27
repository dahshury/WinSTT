import { useModelSwapStore } from "@/entities/model-catalog";
import { useDownloadStore } from "@/features/model-download";

export interface SwapProgressSnapshot {
	/** Live snapshot of any in-flight download (model id + percent), null when idle. */
	downloadProgress: { modelId: string; percent: number | null } | null;
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
 */
export function useSwapProgress(): SwapProgressSnapshot {
	const mainSwapTarget = useModelSwapStore((s) => s.activeMain);
	const realtimeSwapTarget = useModelSwapStore((s) => s.activeRealtime);
	const downloadingModelName = useDownloadStore((s) => s.modelName);
	const downloadingIsActive = useDownloadStore((s) => s.isDownloading);
	const downloadingPercent = useDownloadStore((s) => s.progress);
	const downloadProgress =
		downloadingIsActive && downloadingModelName !== null
			? { modelId: downloadingModelName, percent: downloadingPercent }
			: null;
	const mainSwapping =
		mainSwapTarget !== null && !(downloadProgress && downloadProgress.modelId === mainSwapTarget);
	const realtimeSwapping =
		realtimeSwapTarget !== null &&
		!(downloadProgress && downloadProgress.modelId === realtimeSwapTarget);
	return { downloadProgress, mainSwapping, realtimeSwapping };
}
