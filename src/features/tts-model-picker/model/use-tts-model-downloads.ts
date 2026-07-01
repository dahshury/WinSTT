import { useEffect, useState } from "react";
import { useTtsModelStateStore } from "@/entities/tts-catalog";
import {
	onTtsModelDownloadCompleteCatalog,
	onTtsModelDownloadProgressCatalog,
	ttsDownloadCancel,
	ttsDownloadPause,
	ttsDownloadResume,
	ttsPredownloadModel,
} from "@/shared/api/ipc-client";
import {
	mergeProgressIntoSnapshot,
	mergeSeedIntoSnapshot,
	type QuantDownloadAction,
	type QuantDownloadSnapshot,
	quantDownloadSeedFromCache,
} from "@/shared/lib/download-progress-core";

const keyOf = (modelId: string, quant: string): string => `${modelId}@${quant}`;

/**
 * Drives the TTS picker's per-quant download controls: subscribes to the catalog
 * download events to keep a live snapshot map, dispatches start/pause/resume/cancel
 * to the backend, and re-fetches model state on completion so badges flip.
 *
 * Shared by the inline Settings TTS selector (`TtsModelSection`) and the detached
 * model-picker window's TTS mode (`DetachedTtsPicker`), so it lives in the
 * tts-model-picker feature rather than either widget.
 */
export function useTtsModelDownloads(): {
	getSnapshot: (
		modelId: string,
		quant: string,
	) => QuantDownloadSnapshot | undefined;
	onDownloadAction: (
		action: QuantDownloadAction,
		modelId: string,
		quant: string,
	) => void;
} {
	const [snaps, setSnaps] = useState<Record<string, QuantDownloadSnapshot>>({});
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
	): QuantDownloadSnapshot | undefined => snaps[keyOf(modelId, quant)];

	const onDownloadAction = (
		action: QuantDownloadAction,
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
