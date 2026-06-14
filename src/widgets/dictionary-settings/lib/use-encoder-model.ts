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
}
interface CompletePayload {
	present: boolean;
	cancelled: boolean;
}

export interface EncoderModel {
	downloadedBytes: number;
	progress: number; // 0..1
	state: EncoderModelState;
	totalBytes: number;
	cancel: () => void;
	pause: () => void;
	resume: () => void;
	start: () => void;
}

const INITIAL: Omit<
	EncoderModel,
	"start" | "pause" | "resume" | "cancel"
> = {
	state: "loading",
	progress: 0,
	downloadedBytes: 0,
	totalBytes: 0,
};

function applyStatus(p: StatusPayload) {
	return {
		state: p.state as EncoderModelState,
		progress: p.progress,
		downloadedBytes: p.downloadedBytes,
		totalBytes: p.totalBytes,
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
						? { state: "present", progress: 1, downloadedBytes: 0, totalBytes: 0 }
						: { state: "absent", progress: 0, downloadedBytes: 0, totalBytes: 0 },
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

	return { ...s, start, pause, resume, cancel };
}
