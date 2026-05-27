import { create } from "zustand";
import {
	cancelDownload as ipcCancelDownload,
	cancelModelDownloadQuant as ipcCancelModelDownloadQuant,
	deleteModelCache as ipcDeleteModelCache,
	deleteModelQuantization as ipcDeleteModelQuantization,
	pauseModelDownload as ipcPauseModelDownload,
	predownloadModelQuant as ipcPredownloadModelQuant,
	resumeModelDownload as ipcResumeModelDownload,
} from "@/shared/api/ipc-client";

export interface DownloadProgressPayload {
	downloadedBytes?: number;
	etaSeconds?: number;
	progress: number;
	/** Optional — the server's streaming downloader includes this so the
	 *  store can fan out into ``quantDownloads`` keyed per-variant. Older
	 *  payloads from the legacy snapshot-download path omit it. */
	quantization?: string;
	speedBps?: number;
	totalBytes?: number;
}

/** Per-(modelId, quantization) live download snapshot — the badge inside
 *  ``SttModelCard`` reads these so each variant shows its own progress
 *  / paused / cancelled state independently. */
export interface QuantDownloadState {
	downloadedBytes: number;
	modelId: string;
	paused: boolean;
	/** 0–100, null = indeterminate (first event hasn't landed yet). */
	progress: number | null;
	quantization: string;
	speedBps: number;
	totalBytes: number;
}

/** Composite key used in the ``quantDownloads`` map. Empty quant maps to
 *  ``modelId@`` — distinguishable from a non-existent entry by the empty
 *  trailing segment. */
export function quantKey(modelId: string, quantization: string): string {
	return `${modelId}@${quantization}`;
}

interface DownloadState {
	cancelDownload: () => void;
	/** Per-quant cancel — drops the in-flight download for one variant
	 *  WITHOUT touching others. Leaves previously-completed files cached;
	 *  follow with discardQuantCache to wipe them too. */
	cancelQuantDownload: (modelId: string, quantization: string) => void;
	cancelled: boolean;
	discardCache: (modelId: string) => void;
	/** Per-quant delete — only removes the weight files matching
	 *  ``quantization``, leaving every other quant of ``modelId`` intact.
	 *  Pass ``""`` for the catalog default precision. */
	discardQuantCache: (modelId: string, quantization: string) => void;
	downloadedBytes: number;
	etaSeconds: number;
	isDownloading: boolean;
	modelName: string | null;
	/** Pause the in-flight per-quant download. .partial files are
	 *  preserved on disk; resume picks up via HTTP Range. */
	pauseQuantDownload: (modelId: string, quantization: string) => void;
	progress: number | null; // 0–100, null = indeterminate
	/** Mark a quant entry as paused locally (for instant UI feedback —
	 *  the server confirms via the next download event). */
	pauseQuantEntry: (modelId: string, quantization: string) => void;
	/** Kick off a byte-level pause/resume capable download for one
	 *  ``(modelId, quantization)`` tuple. Distinct from the legacy
	 *  "switch model + restart server" flow — this fetches into the HF
	 *  cache without changing the loaded model so the user can keep
	 *  using the current model while their download runs. */
	predownloadQuant: (modelId: string, quantization: string) => void;
	/** Per-quant download snapshots, keyed by ``quantKey()``. Cards read
	 *  this map to render their own progress / paused / cancelled chrome
	 *  on the badge without subscribing to the legacy ``modelName`` /
	 *  ``progress`` fields (which only track ONE download at a time). */
	quantDownloads: Record<string, QuantDownloadState>;
	/** Resume the in-flight per-quant download. Server re-runs the worker
	 *  which skips already-cached files. */
	resumeQuantDownload: (modelId: string, quantization: string) => void;
	setDownloadComplete: (cancelled?: boolean) => void;
	setDownloadProgress: (payload: DownloadProgressPayload) => void;
	setDownloadStart: (model: string) => void;
	/** Mark a quant entry as cleared from the live map — called when the
	 *  server emits download_complete for it. */
	setQuantDownloadComplete: (modelId: string, quantization: string, cancelled: boolean) => void;
	/** Update or insert the per-quant snapshot on a chunk event. */
	setQuantDownloadProgress: (
		modelId: string,
		quantization: string,
		payload: DownloadProgressPayload
	) => void;
	speedBps: number;
	totalBytes: number;
}

const PROGRESS_PAYLOAD_DEFAULTS = {
	downloadedBytes: 0,
	totalBytes: 0,
	speedBps: 0,
	etaSeconds: 0,
} satisfies Partial<DownloadProgressPayload>;

export function normalizeProgressPayload(payload: DownloadProgressPayload) {
	const merged = { ...PROGRESS_PAYLOAD_DEFAULTS, ...payload };
	return { ...merged, progress: Math.round(payload.progress * 100) };
}

export const useDownloadStore = create<DownloadState>()((set) => ({
	isDownloading: false,
	modelName: null,
	progress: null,
	downloadedBytes: 0,
	totalBytes: 0,
	speedBps: 0,
	etaSeconds: 0,
	cancelled: false,
	quantDownloads: {},
	setDownloadStart: (model) =>
		set({
			isDownloading: true,
			modelName: model,
			progress: 0,
			downloadedBytes: 0,
			totalBytes: 0,
			speedBps: 0,
			etaSeconds: 0,
			cancelled: false,
		}),
	setDownloadProgress: (payload) => set(normalizeProgressPayload(payload)),
	setDownloadComplete: (cancelled) => {
		if (cancelled) {
			set({ cancelled: true });
			// Brief display, then clear
			setTimeout(() => {
				set({ isDownloading: false, modelName: null, progress: null, cancelled: false });
			}, 2000);
		} else {
			set({ isDownloading: false, modelName: null, progress: null, cancelled: false });
		}
	},
	cancelDownload: () => {
		ipcCancelDownload();
	},
	discardCache: (modelId: string) => {
		ipcDeleteModelCache(modelId);
	},
	discardQuantCache: (modelId: string, quantization: string) => {
		ipcDeleteModelQuantization(modelId, quantization);
	},
	predownloadQuant: (modelId: string, quantization: string) => {
		// Seed the entry so the badge flips to "downloading" instantly
		// rather than waiting for the first server progress event.
		set((s) => ({
			quantDownloads: {
				...s.quantDownloads,
				[quantKey(modelId, quantization)]: {
					modelId,
					quantization,
					progress: null,
					downloadedBytes: 0,
					totalBytes: 0,
					speedBps: 0,
					paused: false,
				},
			},
		}));
		ipcPredownloadModelQuant(modelId, quantization);
	},
	pauseQuantDownload: (modelId: string, quantization: string) => {
		ipcPauseModelDownload(modelId, quantization);
	},
	pauseQuantEntry: (modelId: string, quantization: string) => {
		set((s) => {
			const key = quantKey(modelId, quantization);
			const entry = s.quantDownloads[key];
			if (!entry) {
				return s;
			}
			return {
				quantDownloads: { ...s.quantDownloads, [key]: { ...entry, paused: true } },
			};
		});
	},
	resumeQuantDownload: (modelId: string, quantization: string) => {
		set((s) => {
			const key = quantKey(modelId, quantization);
			const entry = s.quantDownloads[key];
			if (!entry) {
				return s;
			}
			return {
				quantDownloads: { ...s.quantDownloads, [key]: { ...entry, paused: false } },
			};
		});
		ipcResumeModelDownload(modelId, quantization);
	},
	cancelQuantDownload: (modelId: string, quantization: string) => {
		ipcCancelModelDownloadQuant(modelId, quantization);
	},
	setQuantDownloadProgress: (modelId, quantization, payload) => {
		set((s) => {
			const key = quantKey(modelId, quantization);
			const existing = s.quantDownloads[key];
			const merged = { ...PROGRESS_PAYLOAD_DEFAULTS, ...payload };
			return {
				quantDownloads: {
					...s.quantDownloads,
					[key]: {
						modelId,
						quantization,
						progress: Math.round(payload.progress * 100),
						downloadedBytes: merged.downloadedBytes,
						totalBytes: merged.totalBytes,
						speedBps: merged.speedBps,
						// Receiving a progress chunk implicitly clears the paused
						// flag — bytes only flow when the worker isn't paused.
						paused: existing?.paused === true ? false : false,
					},
				},
			};
		});
	},
	setQuantDownloadComplete: (modelId, quantization, _cancelled) => {
		set((s) => {
			const next = { ...s.quantDownloads };
			delete next[quantKey(modelId, quantization)];
			return { quantDownloads: next };
		});
	},
}));
