import { create } from "zustand";
import type { DownloadProgressPayload as IpcDownloadProgressPayload } from "@/shared/api/ipc-client";
import {
	cancelModelDownloadQuant as ipcCancelModelDownloadQuant,
	cancelDownload as ipcCancelDownload,
	deleteModelCache as ipcDeleteModelCache,
	deleteModelQuantization as ipcDeleteModelQuantization,
	pauseModelDownload as ipcPauseModelDownload,
	predownloadModelQuant as ipcPredownloadModelQuant,
	resumeModelDownload as ipcResumeModelDownload,
	type SttModelLifecycleSnapshot,
} from "@/shared/api/ipc-client";
import {
	monotonicPercent,
	percentFromFraction,
	type QuantDownloadSeed,
} from "@/shared/lib/download-progress-core";

export {
	type QuantCacheSeedSource,
	type QuantDownloadSeed,
	quantDownloadSeedFromCache,
} from "@/shared/lib/download-progress-core";

/** The store's view of a download-progress event — the canonical IPC payload
 *  ({@link IpcDownloadProgressPayload}) minus its `model` field, which the store
 *  carries separately (in `modelName` / the per-quant map key) rather than on
 *  each progress record. Kept as an `Omit` so the two never drift. */
export type DownloadProgressPayload = Omit<IpcDownloadProgressPayload, "model">;

export type SttDownloadOwner = "main" | "realtime";

/** Per-(modelId, quantization) live download snapshot — the badge inside
 *  ``SttModelCard`` reads these so each variant shows its own progress
 *  / paused / cancelled state independently. */
export interface QuantDownloadState {
	downloadedBytes: number;
	modelId: string;
	owner?: SttDownloadOwner;
	paused: boolean;
	phase: Extract<
		SttModelLifecycleSnapshot["phase"],
		"queued" | "downloading" | "paused" | "verifying" | "installing"
	>;
	/** 0–100, null = indeterminate (first event hasn't landed yet). */
	progress: number | null;
	quantization: string;
	requestId: string;
	revision: number;
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
	/** Apply one backend-authoritative lifecycle frame. Lower/equal revisions are ignored. */
	applyLifecycleSnapshot: (snapshot: SttModelLifecycleSnapshot) => void;
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
	/** Last authoritative snapshot for every model/quant, including terminal activation states. */
	lifecycles: Record<string, SttModelLifecycleSnapshot>;
	/** UI-only provenance; never used to infer lifecycle phase or progress. */
	quantOwners: Record<string, SttDownloadOwner>;
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
	lifecycles: {},
	quantOwners: {},
	applyLifecycleSnapshot: (snapshot) => {
		set((state) => {
			const key = quantKey(snapshot.modelId, snapshot.quantization);
			const previous = state.lifecycles[key];
			if (previous && previous.revision >= snapshot.revision) {
				return state;
			}
			const lifecycles = { ...state.lifecycles, [key]: snapshot };
			const quantDownloads = { ...state.quantDownloads };
			if (
				snapshot.phase === "queued" ||
				snapshot.phase === "downloading" ||
				snapshot.phase === "paused" ||
				snapshot.phase === "verifying" ||
				snapshot.phase === "installing"
			) {
				const progress =
					snapshot.totalBytes > 0
						? Math.min(
								100,
								Math.round(
									(snapshot.downloadedBytes / snapshot.totalBytes) * 100,
								),
							)
						: null;
				quantDownloads[key] = {
					modelId: snapshot.modelId,
					quantization: snapshot.quantization,
					...ownerPatch(state.quantOwners[key]),
					phase: snapshot.phase,
					requestId: snapshot.requestId,
					revision: snapshot.revision,
					downloadedBytes: snapshot.downloadedBytes,
					totalBytes: snapshot.totalBytes,
					speedBps: snapshot.speedBps,
					progress,
					paused: snapshot.phase === "paused",
				};
			} else {
				delete quantDownloads[key];
			}
			return { lifecycles, quantDownloads };
		});
	},
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
			const lifecycles = { ...s.lifecycles };
			const quantOwners = { ...s.quantOwners };
			const key = quantKey(modelId, quantization);
			delete next[key];
			delete lifecycles[key];
			delete quantOwners[key];
			return { quantDownloads: next, lifecycles, quantOwners };
		});
		void ipcDeleteModelQuantization(modelId, quantization).catch((e) =>
			console.error("model quant delete failed", e),
		);
	},
	predownloadQuant: (
		modelId: string,
		quantization: string,
		owner?: SttDownloadOwner,
		_seed?: QuantDownloadSeed,
	) => {
		if (owner !== undefined) {
			set((state) => ({
				quantOwners: {
					...state.quantOwners,
					[quantKey(modelId, quantization)]: owner,
				},
			}));
		}
		void ipcPredownloadModelQuant(modelId, quantization).catch((e) =>
			console.error("model quant predownload failed", e),
		);
	},
	pauseQuantDownload: (modelId: string, quantization: string) => {
		void ipcPauseModelDownload(modelId, quantization).catch((e) =>
			console.error("model download pause failed", e),
		);
	},
	resumeQuantDownload: (
		modelId: string,
		quantization: string,
		owner?: SttDownloadOwner,
		_seed?: QuantDownloadSeed,
	) => {
		if (owner !== undefined) {
			set((state) => ({
				quantOwners: {
					...state.quantOwners,
					[quantKey(modelId, quantization)]: owner,
				},
			}));
		}
		void ipcResumeModelDownload(modelId, quantization).catch((e) =>
			console.error("model download resume failed", e),
		);
	},
	cancelQuantDownload: (modelId: string, quantization: string) => {
		void ipcCancelModelDownloadQuant(modelId, quantization).catch((e) =>
			console.error("model quant cancel failed", e),
		);
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
