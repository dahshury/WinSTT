import { create } from "zustand";
import {
	mergeProgressIntoSnapshot,
	mergeSeedIntoSnapshot,
	monotonicPercent,
	percentFromFraction,
	type QuantCacheSeedSource,
	type QuantDownloadSeed,
	quantDownloadSeedFromCache,
} from "@/features/model-download/lib/download-progress-core";
import {
	cancelDownload as ipcCancelDownload,
	deleteModelCache as ipcDeleteModelCache,
	deleteModelQuantization as ipcDeleteModelQuantization,
	pauseModelDownload as ipcPauseModelDownload,
	predownloadModelQuant as ipcPredownloadModelQuant,
	resumeModelDownload as ipcResumeModelDownload,
} from "@/shared/api/ipc-client";

export {
	type QuantCacheSeedSource,
	type QuantDownloadSeed,
	quantDownloadSeedFromCache,
} from "@/features/model-download/lib/download-progress-core";

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

export type SttDownloadOwner = "main" | "realtime";

/** Per-(modelId, quantization) live download snapshot — the badge inside
 *  ``SttModelCard`` reads these so each variant shows its own progress
 *  / paused / cancelled state independently. */
export interface QuantDownloadState {
	downloadedBytes: number;
	modelId: string;
	owner?: SttDownloadOwner;
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
function quantKey(modelId: string, quantization: string): string {
	return `${modelId}@${quantization}`;
}

function ownerPatch(owner: SttDownloadOwner | undefined) {
	return owner === undefined ? {} : { owner };
}

interface DownloadState {
	cancelDownload: () => void;
	cancelled: boolean;
	/** Per-quant cancel — drops the in-flight download for one variant
	 *  WITHOUT touching others. Leaves previously-completed files cached;
	 *  follow with discardQuantCache to wipe them too. */
	cancelQuantDownload: (modelId: string, quantization: string) => void;
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
	/** Mark a quant entry as paused locally (for instant UI feedback —
	 *  the server confirms via the next download event). Also the handler for
	 *  the server's ``stt:model-download-paused`` broadcast, so EVERY window
	 *  (not just the one that clicked pause) leaves the downloading state. */
	pauseQuantEntry: (modelId: string, quantization: string) => void;
	/** Clear the paused flag on an existing quant entry WITHOUT touching the
	 *  server — the inverse of {@link pauseQuantEntry}. Driven by the server's
	 *  ``stt:model-download-start`` re-emit on resume so windows that only
	 *  observed the download (and got the pause broadcast) re-enter the
	 *  downloading state when bytes start flowing again. No-op when the entry
	 *  is absent or already active. */
	resumeQuantEntry: (modelId: string, quantization: string) => void;
	/** Kick off a byte-level pause/resume capable download for one
	 *  ``(modelId, quantization)`` tuple. Distinct from the legacy
	 *  "switch model + restart server" flow — this fetches into the HF
	 *  cache without changing the loaded model so the user can keep
	 *  using the current model while their download runs. */
	predownloadQuant: (
		modelId: string,
		quantization: string,
		owner?: SttDownloadOwner,
		seed?: QuantDownloadSeed,
	) => void;
	progress: number | null; // 0–100, null = indeterminate
	/** Per-quant download snapshots, keyed by ``quantKey()``. Cards read
	 *  this map to render their own progress / paused / cancelled chrome
	 *  on the badge without subscribing to the legacy ``modelName`` /
	 *  ``progress`` fields (which only track ONE download at a time). */
	quantDownloads: Record<string, QuantDownloadState>;
	/** Resume the in-flight per-quant download. Server re-runs the worker
	 *  which skips already-cached files. */
	resumeQuantDownload: (
		modelId: string,
		quantization: string,
		owner?: SttDownloadOwner,
		seed?: QuantDownloadSeed,
	) => void;
	setDownloadComplete: (cancelled?: boolean) => void;
	setDownloadProgress: (payload: DownloadProgressPayload) => void;
	setDownloadStart: (model: string) => void;
	/** Mark a quant entry as cleared from the live map — called when the
	 *  server emits download_complete for it. */
	setQuantDownloadComplete: (
		modelId: string,
		quantization: string,
		cancelled: boolean,
	) => void;
	/** Update or insert the per-quant snapshot on a chunk event. */
	setQuantDownloadProgress: (
		modelId: string,
		quantization: string,
		payload: DownloadProgressPayload,
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
	return { ...merged, progress: percentFromFraction(payload.progress) };
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
	setDownloadProgress: (payload) =>
		set((s) => {
			const next = normalizeProgressPayload(payload);
			const downloadedBytes = Math.max(s.downloadedBytes, next.downloadedBytes);
			return {
				...next,
				progress: monotonicPercent(s.progress, next.progress),
				downloadedBytes,
				totalBytes: Math.max(s.totalBytes, next.totalBytes, downloadedBytes),
			};
		}),
	setDownloadComplete: (cancelled) => {
		if (cancelled) {
			set({ cancelled: true });
			// Brief display, then clear
			setTimeout(() => {
				set({
					isDownloading: false,
					modelName: null,
					progress: null,
					cancelled: false,
				});
			}, 2000);
		} else {
			set({
				isDownloading: false,
				modelName: null,
				progress: null,
				cancelled: false,
			});
		}
	},
	cancelDownload: () => {
		void ipcCancelDownload().catch((e) =>
			console.error("model download cancel failed", e),
		);
	},
	discardCache: (modelId: string) => {
		void ipcDeleteModelCache(modelId).catch((e) =>
			console.error("model cache delete failed", e),
		);
	},
	discardQuantCache: (modelId: string, quantization: string) => {
		// Drop the local snapshot synchronously so the badge's
		// pause/resume/cancel chrome disappears the moment the user
		// confirms delete — without this the seeded entry survives the
		// IPC round-trip and the server's ``model_download_complete``
		// (outcome=cancelled), and the user sees a green "cached" badge
		// with stale stop/pause buttons because the cache state and
		// download snapshot disagree.
		set((s) => {
			const next = { ...s.quantDownloads };
			delete next[quantKey(modelId, quantization)];
			return { quantDownloads: next };
		});
		void ipcDeleteModelQuantization(modelId, quantization).catch((e) =>
			console.error("model quant delete failed", e),
		);
	},
	predownloadQuant: (
		modelId: string,
		quantization: string,
		owner?: SttDownloadOwner,
		seed?: QuantDownloadSeed,
	) => {
		// Seed the entry so the badge flips to "downloading" instantly
		// rather than waiting for the first server progress event.
		set((s) => {
			const key = quantKey(modelId, quantization);
			const existing = s.quantDownloads[key];
			const resolvedOwner = owner ?? existing?.owner;
			return {
				quantDownloads: {
					...s.quantDownloads,
					[key]: {
						modelId,
						quantization,
						...ownerPatch(resolvedOwner),
						...mergeSeedIntoSnapshot(existing, seed),
						speedBps: existing?.speedBps ?? 0,
						paused: false,
					},
				},
			};
		});
		void ipcPredownloadModelQuant(modelId, quantization).catch((e) =>
			console.error("model quant predownload failed", e),
		);
	},
	pauseQuantDownload: (modelId: string, quantization: string) => {
		void ipcPauseModelDownload(modelId, quantization).catch((e) =>
			console.error("model download pause failed", e),
		);
	},
	pauseQuantEntry: (modelId: string, quantization: string) => {
		set((s) => {
			const key = quantKey(modelId, quantization);
			const entry = s.quantDownloads[key];
			if (!entry || entry.paused) {
				return s;
			}
			return {
				quantDownloads: {
					...s.quantDownloads,
					[key]: { ...entry, paused: true },
				},
			};
		});
	},
	resumeQuantEntry: (modelId: string, quantization: string) => {
		set((s) => {
			const key = quantKey(modelId, quantization);
			const entry = s.quantDownloads[key];
			if (!entry || !entry.paused) {
				return s;
			}
			return {
				quantDownloads: {
					...s.quantDownloads,
					[key]: { ...entry, paused: false },
				},
			};
		});
	},
	resumeQuantDownload: (
		modelId: string,
		quantization: string,
		owner?: SttDownloadOwner,
		seed?: QuantDownloadSeed,
	) => {
		set((s) => {
			const key = quantKey(modelId, quantization);
			const entry = s.quantDownloads[key];
			if (!entry) {
				if (owner === undefined && seed === undefined) {
					return s;
				}
				return {
					quantDownloads: {
						...s.quantDownloads,
						[key]: {
							modelId,
							quantization,
							...ownerPatch(owner),
							...mergeSeedIntoSnapshot(undefined, seed),
							speedBps: 0,
							paused: false,
						},
					},
				};
			}
			const resolvedOwner = owner ?? entry.owner;
			return {
				quantDownloads: {
					...s.quantDownloads,
					[key]: {
						...entry,
						...ownerPatch(resolvedOwner),
						...mergeSeedIntoSnapshot(entry, seed),
						paused: false,
					},
				},
			};
		});
		void ipcResumeModelDownload(modelId, quantization).catch((e) =>
			console.error("model download resume failed", e),
		);
	},
	cancelQuantDownload: (modelId: string, quantization: string) => {
		set((s) => {
			const next = { ...s.quantDownloads };
			delete next[quantKey(modelId, quantization)];
			return { quantDownloads: next };
		});
		void ipcDeleteModelQuantization(modelId, quantization).catch((e) =>
			console.error("model quant cancel/discard failed", e),
		);
	},
	setQuantDownloadProgress: (modelId, quantization, payload) => {
		set((s) => {
			const key = quantKey(modelId, quantization);
			const entry = s.quantDownloads[key];
			const merged = { ...PROGRESS_PAYLOAD_DEFAULTS, ...payload };
			return {
				quantDownloads: {
					...s.quantDownloads,
					[key]: {
						modelId,
						quantization,
						...ownerPatch(entry?.owner),
						...mergeProgressIntoSnapshot(entry, merged),
						speedBps: merged.speedBps,
						paused: entry?.paused ?? false,
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

/** Whether ``(modelId, quantization)`` has an in-flight streaming download.
 *
 *  Read synchronously (not a hook) so non-React callers — notably the swap
 *  controller's selection guard, which must NOT let the user switch to a model
 *  whose target precision is still downloading — can check the live map. */
export function isQuantDownloading(
	modelId: string,
	quantization: string,
): boolean {
	return (
		useDownloadStore.getState().quantDownloads[
			quantKey(modelId, quantization)
		] !== undefined
	);
}
