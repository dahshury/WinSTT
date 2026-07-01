import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { fireAndForget } from "@/shared/lib/fire-and-forget";

/**
 * State + controls for the on-device encoder dictionary model (the non-LLM fallback).
 *
 * The model downloads via a managed backend flow (start/pause/resume/cancel). This hook seeds
 * itself from `encoder_dict_status` on mount — so leaving the Vocabulary tab mid-download and
 * returning shows the CURRENT progress — and then tracks live `encoder-dict:download-*` events.
 */
export type EncoderModelState =
	| "loading"
	| "absent"
	| "downloading"
	| "paused"
	| "present";

interface StatusPayload {
	state: string;
	progress: number;
	downloadedBytes: number;
	totalBytes: number;
	speedBps?: number;
}
interface CompletePayload {
	present: boolean;
	cancelled: boolean;
}

export interface EncoderModel {
	downloadedBytes: number;
	progress: number; // 0..1
	speedBps: number;
	state: EncoderModelState;
	totalBytes: number;
	cancel: () => void;
	pause: () => void;
	/** Load + warm the model in the background so the first dictation is fast (no-op if not present). */
	preload: () => void;
	/** Delete the model from disk (and any in-flight transfer) — used when the feature is turned off. */
	remove: () => void;
	resume: () => void;
	start: () => void;
	/** Drop the loaded model from memory (keeps files on disk) — frees RAM when the feature is off. */
	unload: () => void;
}

const INITIAL: Omit<
	EncoderModel,
	"start" | "pause" | "resume" | "cancel" | "remove" | "preload" | "unload"
> = {
	state: "loading",
	progress: 0,
	downloadedBytes: 0,
	totalBytes: 0,
	speedBps: 0,
};

function applyStatus(p: StatusPayload) {
	return {
		state: p.state as EncoderModelState,
		progress: p.progress,
		downloadedBytes: p.downloadedBytes,
		totalBytes: p.totalBytes,
		speedBps: p.speedBps ?? 0,
	};
}

function cancelEncoderDownload(): void {
	fireAndForget(
		invoke("encoder_dict_download_cancel"),
		"encoder_dict_download_cancel",
	);
}

function preloadEncoderModel(): void {
	fireAndForget(invoke("encoder_dict_preload"), "encoder_dict_preload");
}

function unloadEncoderModel(): void {
	fireAndForget(invoke("encoder_dict_unload"), "encoder_dict_unload");
}

export function useEncoderModel(): EncoderModel {
	const [s, setS] = useState(INITIAL);

	// Re-query the backend so an optimistic UI state (start → "downloading",
	// remove → "absent") self-corrects when the underlying invoke actually
	// failed. Without this, a rejected start/remove leaves the card showing a
	// state the backend never entered.
	const reconcileFromBackend = () => {
		invoke<StatusPayload>("encoder_dict_status")
			.then((status) => setS(applyStatus(status)))
			.catch((error) => {
				console.error("[encoder-dict] status reconcile failed:", error);
			});
	};

	useEffect(() => {
		let active = true;
		invoke<StatusPayload>("encoder_dict_status")
			.then((status) => {
				if (active) {
					setS(applyStatus(status));
				}
			})
			.catch((error) => {
				console.error("[encoder-dict] initial status query failed:", error);
				if (active) {
					setS((prev) => ({ ...prev, state: "absent" }));
				}
			});
		const offProgress = listen<StatusPayload>(
			"encoder-dict:download-progress",
			(e) => setS(applyStatus(e.payload)),
		);
		const offComplete = listen<CompletePayload>(
			"encoder-dict:download-complete",
			(e) =>
				setS(
					e.payload.present
						? {
								state: "present",
								progress: 1,
								downloadedBytes: 0,
								totalBytes: 0,
								speedBps: 0,
							}
						: {
								state: "absent",
								progress: 0,
								downloadedBytes: 0,
								totalBytes: 0,
								speedBps: 0,
							},
				),
		);
		return () => {
			active = false;
			offProgress.then((f) => f());
			offComplete.then((f) => f());
		};
	}, []);

	const start = () => {
		setS((prev) => ({ ...prev, state: "downloading" }));
		invoke("encoder_dict_download_start").catch((error) => {
			// The optimistic "downloading" state above is wrong if the start
			// invoke rejected — surface it and reconcile with the real status.
			console.error("[encoder-dict] download start failed:", error);
			reconcileFromBackend();
		});
	};
	const pause = () => {
		setS((prev) => ({ ...prev, state: "paused" }));
		fireAndForget(
			invoke("encoder_dict_download_pause"),
			"encoder_dict_download_pause",
		);
	};
	const resume = () => {
		setS((prev) => ({ ...prev, state: "downloading" }));
		fireAndForget(
			invoke("encoder_dict_download_resume"),
			"encoder_dict_download_resume",
		);
	};
	const remove = () => {
		// Optimistically drop to "absent" so the card reflects the off-switch
		// immediately; the backend `download-complete` event confirms it.
		setS({
			state: "absent",
			progress: 0,
			downloadedBytes: 0,
			totalBytes: 0,
			speedBps: 0,
		});
		invoke("encoder_dict_remove").catch((error) => {
			// The optimistic "absent" state above is wrong if remove rejected —
			// surface it and reconcile with the real on-disk status.
			console.error("[encoder-dict] remove failed:", error);
			reconcileFromBackend();
		});
	};

	return {
		...s,
		start,
		pause,
		resume,
		cancel: cancelEncoderDownload,
		remove,
		preload: preloadEncoderModel,
		unload: unloadEncoderModel,
	};
}
