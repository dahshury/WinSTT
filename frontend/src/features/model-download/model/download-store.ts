import { create } from "zustand";
import {
	cancelDownload as ipcCancelDownload,
	deleteModelCache as ipcDeleteModelCache,
} from "@/shared/api/ipc-client";

export interface DownloadProgressPayload {
	downloadedBytes?: number;
	etaSeconds?: number;
	progress: number;
	speedBps?: number;
	totalBytes?: number;
}

interface DownloadState {
	cancelDownload: () => void;
	cancelled: boolean;
	discardCache: (modelId: string) => void;
	downloadedBytes: number;
	etaSeconds: number;
	isDownloading: boolean;
	modelName: string | null;
	progress: number | null; // 0–100, null = indeterminate
	setDownloadComplete: (cancelled?: boolean) => void;
	setDownloadProgress: (payload: DownloadProgressPayload) => void;
	setDownloadStart: (model: string) => void;
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
}));
