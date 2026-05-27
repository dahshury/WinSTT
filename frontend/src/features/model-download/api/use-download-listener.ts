import { useEffect } from "react";
import {
	onModelDownloadComplete,
	onModelDownloadProgress,
	onModelDownloadStart,
} from "@/shared/api/ipc-client";
import { useDownloadStore } from "../model/download-store";

export function useDownloadListener(): void {
	const setDownloadStart = useDownloadStore((s) => s.setDownloadStart);
	const setDownloadProgress = useDownloadStore((s) => s.setDownloadProgress);
	const setDownloadComplete = useDownloadStore((s) => s.setDownloadComplete);
	const setQuantDownloadProgress = useDownloadStore((s) => s.setQuantDownloadProgress);
	const setQuantDownloadComplete = useDownloadStore((s) => s.setQuantDownloadComplete);

	useEffect(
		() =>
			onModelDownloadStart((model) => {
				setDownloadStart(model);
			}),
		[setDownloadStart]
	);

	// Single progress event handles BOTH legacy snapshot-style downloads
	// (no quantization field — drives the singleton modelName/progress
	// slot the modal reads) AND the new per-quant streaming downloader
	// (quantization present — fans out into the per-badge map). Both
	// branches can fire for the same model id; the picker reads from the
	// per-quant map preferentially.
	useEffect(
		() =>
			onModelDownloadProgress((payload) => {
				setDownloadProgress(payload);
				if (typeof payload.quantization === "string") {
					setQuantDownloadProgress(payload.model, payload.quantization, payload);
				}
			}),
		[setDownloadProgress, setQuantDownloadProgress]
	);

	useEffect(
		() =>
			onModelDownloadComplete((model, cancelled, quantization) => {
				setDownloadComplete(cancelled);
				if (typeof quantization === "string") {
					setQuantDownloadComplete(model, quantization, cancelled);
				}
			}),
		[setDownloadComplete, setQuantDownloadComplete]
	);
}
