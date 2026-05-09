import { create } from "zustand";
import { cancelDownload as ipcCancelDownload } from "@/shared/api/ipc-client";

interface DownloadState {
	cancelDownload: () => void;
	cancelled: boolean;
	downloadedBytes: number;
	etaSeconds: number;
	isDownloading: boolean;
	modelName: string | null;
	progress: number | null; // 0–100, null = indeterminate
	setDownloadComplete: (cancelled?: boolean) => void;
	setDownloadProgress: (payload: {
		progress: number;
		downloadedBytes?: number;
		totalBytes?: number;
		speedBps?: number;
		etaSeconds?: number;
	}) => void;
	setDownloadStart: (model: string) => void;
	speedBps: number;
	totalBytes: number;
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
	setDownloadProgress: (payload) =>
		set({
			progress: Math.round(payload.progress * 100),
			downloadedBytes: payload.downloadedBytes ?? 0,
			totalBytes: payload.totalBytes ?? 0,
			speedBps: payload.speedBps ?? 0,
			etaSeconds: payload.etaSeconds ?? 0,
		}),
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
}));
