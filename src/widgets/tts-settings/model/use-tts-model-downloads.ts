import { useCallback, useEffect, useRef, useState } from "react";
import { useTtsModelStateStore } from "@/entities/tts-catalog";
import { quantDownloadSeedFromCache } from "@/features/model-download/model/download-store";
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

function percentFromFraction(progress: number): number {
	return Math.max(0, Math.min(100, Math.round(progress * 100)));
}

function monotonicPercent(
	previous: number | null | undefined,
	next: number,
): number {
	return previous == null ? next : Math.max(previous, next);
}

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
	const snapsRef = useRef(snaps);
	snapsRef.current = snaps;
	const statesById = useTtsModelStateStore((s) => s.statesById);
	const statesRef = useRef(statesById);
	statesRef.current = statesById;
	const refresh = useTtsModelStateStore((s) => s.refresh);

	useEffect(() => {
		const offProgress = onTtsModelDownloadProgressCatalog((p) => {
			const key = keyOf(p.model, p.quantization);
			setSnaps((prev) => {
				const previous = prev[key];
				const downloadedBytes = Math.max(
					previous?.downloadedBytes ?? 0,
					p.downloadedBytes,
				);
				return {
					...prev,
					[key]: {
						downloadedBytes,
						totalBytes: Math.max(
							previous?.totalBytes ?? 0,
							p.totalBytes,
							downloadedBytes,
						),
						// Backend sends a 0.0–1.0 fraction; the shared QuantShelf (and the STT
						// path's download-store) work in 0–100, so scale here — without this a
						// finished download (fraction 1.0) rendered as a stuck "1%".
						progress: monotonicPercent(
							previous?.progress,
							percentFromFraction(p.progress),
						),
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

	const getSnapshot = useCallback(
		(modelId: string, quant: string): TtsDownloadSnapshot | undefined =>
			snapsRef.current[keyOf(modelId, quant)],
		[],
	);

	const onDownloadAction = useCallback(
		(action: DownloadAction, modelId: string, quant: string): void => {
			const key = keyOf(modelId, quant);
			const seed = quantDownloadSeedFromCache(
				statesRef.current[modelId]?.cacheByQuantization?.[quant],
			);
			if (action === "start") {
				ttsPredownloadModel(modelId, quant);
				setSnaps((prev) => ({
					...prev,
					[key]: {
						downloadedBytes: Math.max(
							prev[key]?.downloadedBytes ?? 0,
							seed?.downloadedBytes ?? 0,
						),
						totalBytes: Math.max(
							prev[key]?.totalBytes ?? 0,
							seed?.totalBytes ?? 0,
							prev[key]?.downloadedBytes ?? 0,
							seed?.downloadedBytes ?? 0,
						),
						progress:
							seed?.progress == null
								? (prev[key]?.progress ?? null)
								: monotonicPercent(prev[key]?.progress, seed.progress),
						paused: false,
					},
				}));
			} else if (action === "pause") {
				ttsDownloadPause(modelId, quant);
				setSnaps((prev) => ({
					...prev,
					[key]: {
						...(prev[key] ?? {
							downloadedBytes: seed?.downloadedBytes ?? 0,
							totalBytes: seed?.totalBytes ?? 0,
							progress: seed?.progress ?? null,
						}),
						paused: true,
					},
				}));
			} else if (action === "resume") {
				ttsDownloadResume(modelId, quant);
				setSnaps((prev) => {
					const previous = prev[key];
					if (!previous) {
						if (!seed) {
							return prev;
						}
						return {
							...prev,
							[key]: {
								downloadedBytes: seed.downloadedBytes,
								totalBytes: seed.totalBytes,
								progress: seed.progress,
								paused: false,
							},
						};
					}
					return {
						...prev,
						[key]: {
							...previous,
							downloadedBytes: Math.max(
								previous.downloadedBytes,
								seed?.downloadedBytes ?? 0,
							),
							totalBytes: Math.max(
								previous.totalBytes,
								seed?.totalBytes ?? 0,
								previous.downloadedBytes,
								seed?.downloadedBytes ?? 0,
							),
							progress:
								seed?.progress == null
									? previous.progress
									: monotonicPercent(previous.progress, seed.progress),
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
		},
		[],
	);

	return { getSnapshot, onDownloadAction };
}
