import { useEffect } from "react";
import {
	type DownloadProgressPayload,
	onModelDownloadComplete,
	onModelDownloadPaused,
	onModelDownloadProgress,
	onModelDownloadStart,
} from "@/shared/api/ipc-client";
import { useDownloadStore } from "../model/download-store";

// ~12fps. The server emits one ``model_download_progress`` per ~64KB chunk —
// hundreds/sec on a fast CDN. The detached model-picker subscribes to the
// whole ``quantDownloads`` map, so applying every chunk re-renders all ~44
// model cards, saturating that window's renderer (it feels frozen and drops
// clicks). Coalescing the per-quant ticks to this cadence keeps the bar smooth
// while the picker stays responsive enough to switch models mid-download.
const QUANT_PROGRESS_FLUSH_MS = 80;

function quantBufferKey(model: string, quantization: string): string {
	return `${model}@${quantization}`;
}

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
 *
 * Per-quant progress is COALESCED (see ``QUANT_PROGRESS_FLUSH_MS``) so a
 * high-frequency download can't storm the picker's renderer; the legacy
 * singleton path stays synchronous (it updates a single slot, not a list).
 */
export function useDownloadListener(): void {
	const setDownloadStart = useDownloadStore((s) => s.setDownloadStart);
	const setDownloadProgress = useDownloadStore((s) => s.setDownloadProgress);
	const setDownloadComplete = useDownloadStore((s) => s.setDownloadComplete);
	const setQuantDownloadProgress = useDownloadStore(
		(s) => s.setQuantDownloadProgress,
	);
	const setQuantDownloadComplete = useDownloadStore(
		(s) => s.setQuantDownloadComplete,
	);
	const pauseQuantEntry = useDownloadStore((s) => s.pauseQuantEntry);
	const resumeQuantEntry = useDownloadStore((s) => s.resumeQuantEntry);

	useEffect(() => {
		const pending = new Map<string, DownloadProgressPayload>();
		let flushTimer: ReturnType<typeof setTimeout> | null = null;
		const flush = (): void => {
			flushTimer = null;
			for (const payload of pending.values()) {
				// ``quantization`` is always a string for buffered entries (only the
				// per-quant branch buffers), but narrow for the type checker.
				setQuantDownloadProgress(
					payload.model,
					payload.quantization ?? "",
					payload,
				);
			}
			pending.clear();
		};

		const offStart = onModelDownloadStart((model, quantization) => {
			// Per-quant starts are represented by the badge's optimistic seed +
			// the first progress frame; only whole-model downloads touch the
			// singleton slot here. A start re-emit is ALSO the resume signal
			// (predownload_quant re-emits it), so clear any paused flag this
			// window picked up from the pause broadcast — bytes are flowing again.
			if (typeof quantization === "string") {
				resumeQuantEntry(model, quantization);
				return;
			}
			setDownloadStart(model);
		});

		const offProgress = onModelDownloadProgress((payload) => {
			if (typeof payload.quantization === "string") {
				// Buffer the LATEST frame for this key; the trailing flush applies it.
				pending.set(
					quantBufferKey(payload.model, payload.quantization),
					payload,
				);
				if (flushTimer === null) {
					flushTimer = setTimeout(flush, QUANT_PROGRESS_FLUSH_MS);
				}
				return;
			}
			setDownloadProgress(payload);
		});

		const offPaused = onModelDownloadPaused((model, quantization) => {
			if (typeof quantization !== "string") {
				return;
			}
			// Drop any buffered progress for this key so a trailing flush can't
			// re-stamp the entry as un-paused after we've flipped it.
			pending.delete(quantBufferKey(model, quantization));
			pauseQuantEntry(model, quantization);
		});

		const offComplete = onModelDownloadComplete(
			(model, cancelled, quantization) => {
				if (typeof quantization === "string") {
					// Drop any buffered progress for this key FIRST so a pending flush
					// can't re-insert the entry we're about to clear (which would leave
					// a zombie "downloading" badge that never resolves).
					pending.delete(quantBufferKey(model, quantization));
					setQuantDownloadComplete(model, quantization, cancelled);
					return;
				}
				setDownloadComplete(cancelled);
			},
		);

		return () => {
			offStart();
			offProgress();
			offPaused();
			offComplete();
			const pendingFlush = flushTimer;
			flushTimer = null;
			if (pendingFlush !== null) {
				clearTimeout(pendingFlush);
			}
			pending.clear();
		};
	}, [
		setDownloadStart,
		setDownloadProgress,
		setDownloadComplete,
		setQuantDownloadProgress,
		setQuantDownloadComplete,
		pauseQuantEntry,
		resumeQuantEntry,
	]);
}
