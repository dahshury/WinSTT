import type { OnnxQuantization } from "@/shared/config/defaults";
import {
	resolveQuantCache,
	useModelStateStore,
} from "@/entities/model-catalog";
import type { QuantDownloadAction } from "@/shared/lib/download-progress-core";
import {
	quantDownloadSeedFromCache,
	type QuantDownloadState,
	type SttDownloadOwner,
	useDownloadStore,
} from "./download-store";

const seedFor = (modelId: string, quantization: OnnxQuantization) =>
	quantDownloadSeedFromCache(
		resolveQuantCache(
			useModelStateStore.getState().statesById[modelId],
			quantization,
		),
	);

interface QuantActions {
	/** Per-quant delete → AlertDialog confirm (rendered inside the picker) →
	 *  this callback → IPC delete. Server broadcasts model_cache_changed; the
	 *  model-state store listener refreshes the per-quant cache dots
	 *  automatically (no manual refetch needed). */
	handleDeleteQuant: (modelId: string, quantization: OnnxQuantization) => void;
	handleDownloadAction: (
		action: QuantDownloadAction,
		modelId: string,
		quantization: OnnxQuantization,
		owner?: SttDownloadOwner,
	) => void;
	handleDownloadSnapshot: (
		modelId: string,
		quantization: OnnxQuantization,
	) => QuantDownloadState | undefined;
}

/**
 * Single source of truth for the per-quant badge handlers the STT picker
 * exposes (delete + byte-level pause/resume/cancel). Both the settings panel
 * and the detached footer picker wire these into the same `SttModelSelector`,
 * so the controls stay identical across surfaces — the only thing that gated
 * them apart was whether the consumer passed these props.
 *
 * Live progress events, completion bookkeeping, and cache-state refreshes are
 * handled by useDownloadListener in app/providers. The badge looks up its live
 * snapshot via handleDownloadSnapshot — quantDownloads is the keyed map
 * ``${modelId}@${quant}`` that the listener writes to on every server progress
 * event.
 */
export function useQuantActions(): QuantActions {
	const quantDownloads = useDownloadStore((s) => s.quantDownloads);
	const predownloadQuant = useDownloadStore((s) => s.predownloadQuant);
	const pauseQuantDownload = useDownloadStore((s) => s.pauseQuantDownload);
	const pauseQuantEntry = useDownloadStore((s) => s.pauseQuantEntry);
	const resumeQuantDownload = useDownloadStore((s) => s.resumeQuantDownload);
	const cancelQuantDownload = useDownloadStore((s) => s.cancelQuantDownload);
	const discardQuantCache = useDownloadStore((s) => s.discardQuantCache);

	// Every store action below delegates to a fire-and-forget IPC wrapper
	// (download-store → `invokeOrDefault` in ipc-client). That wrapper catches
	// internally and resolves its fallback, so the returned promise NEVER
	// rejects — there is no unhandled rejection to guard and intentionally no
	// `.catch`/`await` here. A dropped command degrades silently to the
	// fallback (consistent with all ~64 `invokeOrDefault` call sites); the
	// server's broadcast events are the source of truth for the final UI state.
	const handleDeleteQuant = (
		modelId: string,
		quantization: OnnxQuantization,
	): void => {
		discardQuantCache(modelId, quantization);
	};

	const handleDownloadSnapshot = (
		modelId: string,
		quantization: OnnxQuantization,
	): QuantDownloadState | undefined =>
		quantDownloads[`${modelId}@${quantization}`];

	const handleDownloadAction = (
		action: QuantDownloadAction,
		modelId: string,
		quantization: OnnxQuantization,
		owner?: SttDownloadOwner,
	): void => {
		if (action === "start") {
			predownloadQuant(
				modelId,
				quantization,
				owner,
				seedFor(modelId, quantization),
			);
			return;
		}
		if (action === "pause") {
			// Optimistic local flip so the badge re-renders before the
			// server's confirmation event lands.
			pauseQuantEntry(modelId, quantization);
			pauseQuantDownload(modelId, quantization);
			return;
		}
		if (action === "resume") {
			resumeQuantDownload(
				modelId,
				quantization,
				owner,
				seedFor(modelId, quantization),
			);
			return;
		}
		if (action === "cancel") {
			cancelQuantDownload(modelId, quantization);
		}
	};

	return { handleDeleteQuant, handleDownloadAction, handleDownloadSnapshot };
}
