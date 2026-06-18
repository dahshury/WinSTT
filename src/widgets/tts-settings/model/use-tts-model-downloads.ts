import { useEffect, useState } from "react";
import { useTtsModelStateStore } from "@/entities/tts-catalog";
import {
	mergeProgressIntoSnapshot,
	mergeSeedIntoSnapshot,
	quantDownloadSeedFromCache,
} from "@/features/model-download";
import {
	onTtsModelDownloadCompleteCatalog,
	onTtsModelDownloadProgressCatalog,
	ttsDownloadCancel,
	ttsDownloadPause,
	ttsDownloadResume,
	ttsPredownloadModel,
} from "@/shared/api/ipc-client";

/** Live per-(model,quant) download snapshot the TTS picker's quant shelf reads.
 *  Structurally matches the picker's `QuantDownloadSnapshot`. The byte fields
 *  (`downloadedBytes`/`totalBytes`/`progress`) are the shared
 *  `ProgressSnapshotFields` the model-download core merges; `paused` is the only
 *  TTS-local addition. */
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
	getSnapshot: (
		modelId: string,
		quant: string,
	) => TtsDownloadSnapshot | undefined;
	onDownloadAction: (
		action: DownloadAction,
		modelId: string,
		quant: string,
	) => void;
} {
	const [snaps, setSnaps] = useState<Record<string, TtsDownloadSnapshot>>({});
	const statesById = useTtsModelStateStore((s) => s.statesById);
	const states = statesById ?? {};
	const refresh = useTtsModelStateStore((s) => s.refresh);

	useEffect(() => {
		const offProgress = onTtsModelDownloadProgressCatalog((p) => {
			const key = keyOf(p.model, p.quantization);
			setSnaps((prev) => {
				const previous = prev[key];
				// Backend sends a 0.0–1.0 fraction; the shared core scales to the
				// 0–100 the QuantShelf renders and keeps the bar monotonic — without
				// this a finished download (fraction 1.0) rendered as a stuck "1%".
				return {
					...prev,
					[key]: {
						...mergeProgressIntoSnapshot(previous, p),
						paused: previous?.paused ?? false,
					},
				};
			});
		});
		const offComplete = onTtsModelDownloadCompleteCatalog(
			(model, _cancelled, quantization) => {
				const key = keyOf(model, quantization);
				setSnaps((prev) => {
					const next = { ...prev };
					delete next[key];
					return next;
				});
				// Re-fetch cache state so the "Downloaded" badge flips.
				refresh();
			},
		);
		return () => {
			offProgress();
			offComplete();
		};
	}, [refresh]);

	const getSnapshot = (
		modelId: string,
		quant: string,
	): TtsDownloadSnapshot | undefined => snaps[keyOf(modelId, quant)];

	const onDownloadAction = (
		action: DownloadAction,
		modelId: string,
		quant: string,
	): void => {
		const key = keyOf(modelId, quant);
		const seed = quantDownloadSeedFromCache(
			states[modelId]?.cacheByQuantization?.[quant],
		);
		if (action === "start") {
			ttsPredownloadModel(modelId, quant);
			setSnaps((prev) => ({
				...prev,
				[key]: {
					...mergeSeedIntoSnapshot(prev[key], seed),
					paused: false,
				},
			}));
		} else if (action === "pause") {
			ttsDownloadPause(modelId, quant);
			setSnaps((prev) => ({
				...prev,
				[key]: {
					...mergeSeedIntoSnapshot(prev[key], seed),
					paused: true,
				},
			}));
		} else if (action === "resume") {
			ttsDownloadResume(modelId, quant);
			setSnaps((prev) => {
				const previous = prev[key];
				// No live entry and nothing to seed → don't create a
				// zero-progress ghost (locked by the resume-without-snapshot test).
				if (!previous && !seed) {
					return prev;
				}
				return {
					...prev,
					[key]: {
						...mergeSeedIntoSnapshot(previous, seed),
						paused: false,
					},
				};
			});
		} else {
			ttsDownloadCancel(modelId, quant);
			setSnaps((prev) => {
				const next = { ...prev };
				delete next[key];
				return next;
			});
		}
	};

	return { getSnapshot, onDownloadAction };
}
