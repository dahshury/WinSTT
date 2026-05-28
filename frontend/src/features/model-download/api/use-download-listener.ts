import { useEffect } from "react";
import {
	onModelDownloadComplete,
	onModelDownloadProgress,
	onModelDownloadStart,
} from "@/shared/api/ipc-client";
import { useDownloadStore } from "../model/download-store";

/**
 * Bridge WS download events into the renderer's download store.
 *
 * Per-quant streaming downloads (events carrying a ``quantization`` field)
 * route ONLY to the per-quant ``quantDownloads`` map — the user-facing UI
 * for those is the badge's progress fill + the model-selector trigger's
 * download chrome, both of which read from that map. The legacy singleton
 * slot (``isDownloading`` / ``modelName`` / ``progress``) is reserved for
 * whole-model swap downloads (no quantization field on the event), where
 * the trigger's ``useSwapProgress`` hook needs them to render the
 * "Switching → Downloading" view.
 *
 * Before this gating, per-quant downloads also tripped the singleton flags
 * which made the (now-removed) main-window ``DownloadOverlay`` cover the
 * audio visualizer for every badge-initiated download — confusing because
 * the same progress was already visible inside the selector.
 */
export function useDownloadListener(): void {
	const setDownloadStart = useDownloadStore((s) => s.setDownloadStart);
	const setDownloadProgress = useDownloadStore((s) => s.setDownloadProgress);
	const setDownloadComplete = useDownloadStore((s) => s.setDownloadComplete);
	const setQuantDownloadProgress = useDownloadStore((s) => s.setQuantDownloadProgress);
	const setQuantDownloadComplete = useDownloadStore((s) => s.setQuantDownloadComplete);

	useEffect(
		() =>
			onModelDownloadStart((model, quantization) => {
				if (typeof quantization === "string") {
					return;
				}
				setDownloadStart(model);
			}),
		[setDownloadStart]
	);

	useEffect(
		() =>
			onModelDownloadProgress((payload) => {
				if (typeof payload.quantization === "string") {
					setQuantDownloadProgress(payload.model, payload.quantization, payload);
					return;
				}
				setDownloadProgress(payload);
			}),
		[setDownloadProgress, setQuantDownloadProgress]
	);

	useEffect(
		() =>
			onModelDownloadComplete((model, cancelled, quantization) => {
				if (typeof quantization === "string") {
					setQuantDownloadComplete(model, quantization, cancelled);
					return;
				}
				setDownloadComplete(cancelled);
			}),
		[setDownloadComplete, setQuantDownloadComplete]
	);
}
