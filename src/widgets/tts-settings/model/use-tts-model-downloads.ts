import { useCallback, useEffect, useRef, useState } from "react";
import { useTtsModelStateStore } from "@/entities/tts-catalog";
import {
	onTtsModelDownloadCompleteCatalog,
	onTtsModelDownloadProgressCatalog,
	ttsDownloadCancel,
	ttsDownloadPause,
	ttsDownloadResume,
	ttsPredownloadModel,
} from "@/shared/api/ipc-client";

/** Live per-(model,quant) download snapshot the TTS picker's quant shelf reads.
 *  Structurally matches the picker's `QuantDownloadSnapshot`. */
export interface TtsDownloadSnapshot {
	downloadedBytes: number;
	paused: boolean;
	/** 0–100, null = indeterminate (first event hasn't landed yet) — matches the
	 *  STT `QuantDownloadState` scale the shared QuantShelf renders. */
	progress: number | null;
	totalBytes: number;
}

type DownloadAction = "cancel" | "pause" | "resume" | "start";

const keyOf = (modelId: string, quant: string): string => `${modelId}@${quant}`;

/**
 * Drives the TTS picker's per-quant download controls: subscribes to the catalog
 * download events to keep a live snapshot map, dispatches start/pause/resume/cancel
 * to the backend, and re-fetches model state on completion so badges flip.
 */
export function useTtsModelDownloads(): {
	getSnapshot: (modelId: string, quant: string) => TtsDownloadSnapshot | undefined;
	onDownloadAction: (action: DownloadAction, modelId: string, quant: string) => void;
} {
	const [snaps, setSnaps] = useState<Record<string, TtsDownloadSnapshot>>({});
	const snapsRef = useRef(snaps);
	snapsRef.current = snaps;
	const refresh = useTtsModelStateStore((s) => s.refresh);

	useEffect(() => {
		const offProgress = onTtsModelDownloadProgressCatalog((p) => {
			const key = keyOf(p.model, p.quantization);
			setSnaps((prev) => ({
				...prev,
				[key]: {
					downloadedBytes: p.downloadedBytes,
					totalBytes: p.totalBytes,
					// Backend sends a 0.0–1.0 fraction; the shared QuantShelf (and the STT
					// path's download-store) work in 0–100, so scale here — without this a
					// finished download (fraction 1.0) rendered as a stuck "1%".
					progress: Math.round(p.progress * 100),
					paused: prev[key]?.paused ?? false,
				},
			}));
		});
		const offComplete = onTtsModelDownloadCompleteCatalog((model, _cancelled, quantization) => {
			const key = keyOf(model, quantization);
			setSnaps((prev) => {
				const next = { ...prev };
				delete next[key];
				return next;
			});
			// Re-fetch cache state so the "Downloaded" badge flips.
			refresh();
		});
		return () => {
			offProgress();
			offComplete();
		};
	}, [refresh]);

	const getSnapshot = useCallback(
		(modelId: string, quant: string): TtsDownloadSnapshot | undefined =>
			snapsRef.current[keyOf(modelId, quant)],
		[]
	);

	const onDownloadAction = useCallback(
		(action: DownloadAction, modelId: string, quant: string): void => {
			const key = keyOf(modelId, quant);
			if (action === "start") {
				ttsPredownloadModel(modelId, quant);
				setSnaps((prev) => ({
					...prev,
					[key]: { downloadedBytes: 0, totalBytes: 0, progress: null, paused: false },
				}));
			} else if (action === "pause") {
				ttsDownloadPause(modelId, quant);
				setSnaps((prev) => ({
					...prev,
					[key]: {
						...(prev[key] ?? { downloadedBytes: 0, totalBytes: 0, progress: null }),
						paused: true,
					},
				}));
			} else if (action === "resume") {
				ttsDownloadResume(modelId, quant);
				setSnaps((prev) => ({
					...prev,
					[key]: {
						...(prev[key] ?? { downloadedBytes: 0, totalBytes: 0, progress: null }),
						paused: false,
					},
				}));
			} else {
				ttsDownloadCancel(modelId, quant);
				setSnaps((prev) => {
					const next = { ...prev };
					delete next[key];
					return next;
				});
			}
		},
		[]
	);

	return { getSnapshot, onDownloadAction };
}
