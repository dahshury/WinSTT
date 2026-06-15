import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";

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

export function useEncoderModel(): EncoderModel {
	const [s, setS] = useState(INITIAL);

	useEffect(() => {
		let active = true;
		invoke<StatusPayload>("encoder_dict_status")
			.then((status) => {
				if (active) {
					setS(applyStatus(status));
				}
			})
			.catch(() => {
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

	const start = useCallback(() => {
		setS((prev) => ({ ...prev, state: "downloading" }));
		invoke("encoder_dict_download_start").catch(() => {});
	}, []);
	const pause = useCallback(() => {
		setS((prev) => ({ ...prev, state: "paused" }));
		invoke("encoder_dict_download_pause").catch(() => {});
	}, []);
	const resume = useCallback(() => {
		setS((prev) => ({ ...prev, state: "downloading" }));
		invoke("encoder_dict_download_resume").catch(() => {});
	}, []);
	const cancel = useCallback(() => {
		invoke("encoder_dict_download_cancel").catch(() => {});
	}, []);
	const remove = useCallback(() => {
		// Optimistically drop to "absent" so the card reflects the off-switch
		// immediately; the backend `download-complete` event confirms it.
		setS({
			state: "absent",
			progress: 0,
			downloadedBytes: 0,
			totalBytes: 0,
			speedBps: 0,
		});
		invoke("encoder_dict_remove").catch(() => {});
	}, []);
	const preload = useCallback(() => {
		invoke("encoder_dict_preload").catch(() => {});
	}, []);
	const unload = useCallback(() => {
		invoke("encoder_dict_unload").catch(() => {});
	}, []);

	return { ...s, start, pause, resume, cancel, remove, preload, unload };
}
