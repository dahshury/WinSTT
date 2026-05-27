import { type QuantDownloadState, useDownloadStore } from "@/features/model-download";
import type { OnnxQuantization } from "@/shared/config/defaults";

export interface QuantDownloadActions {
	handleDownloadAction: (
		action: "start" | "pause" | "resume" | "cancel",
		modelId: string,
		quantization: OnnxQuantization
	) => void;
	handleDownloadSnapshot: (
		modelId: string,
		quantization: OnnxQuantization
	) => QuantDownloadState | undefined;
}

/**
 * Per-quant byte-level pause/resume wiring. The badge inside the picker
 * dispatches one of four actions; everything else (live progress events,
 * completion bookkeeping) is handled by useDownloadListener in app/providers.
 * The badge looks up its live snapshot via getDownloadSnapshot — quantDownloads
 * is the keyed map ``${modelId}@${quant}`` that the listener writes to on
 * every server progress event.
 */
export function useQuantDownloads(): QuantDownloadActions {
	const quantDownloads = useDownloadStore((s) => s.quantDownloads);
	const predownloadQuant = useDownloadStore((s) => s.predownloadQuant);
	const pauseQuantDownload = useDownloadStore((s) => s.pauseQuantDownload);
	const pauseQuantEntry = useDownloadStore((s) => s.pauseQuantEntry);
	const resumeQuantDownload = useDownloadStore((s) => s.resumeQuantDownload);
	const cancelQuantDownload = useDownloadStore((s) => s.cancelQuantDownload);

	const handleDownloadSnapshot = (
		modelId: string,
		quantization: OnnxQuantization
	): QuantDownloadState | undefined => quantDownloads[`${modelId}@${quantization}`];

	const handleDownloadAction = (
		action: "start" | "pause" | "resume" | "cancel",
		modelId: string,
		quantization: OnnxQuantization
	): void => {
		if (action === "start") {
			predownloadQuant(modelId, quantization);
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
			resumeQuantDownload(modelId, quantization);
			return;
		}
		if (action === "cancel") {
			cancelQuantDownload(modelId, quantization);
		}
	};

	return { handleDownloadAction, handleDownloadSnapshot };
}
