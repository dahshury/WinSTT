import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { commands, type EncoderDownloadStatus, type Result } from "@/bindings";
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

type StatusPayload = EncoderDownloadStatus;

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

type EncoderModelSnapshot = Omit<
	EncoderModel,
	"start" | "pause" | "resume" | "cancel" | "remove" | "preload" | "unload"
>;

const INITIAL: EncoderModelSnapshot = {
	state: "loading",
	progress: 0,
	downloadedBytes: 0,
	totalBytes: 0,
	speedBps: 0,
};

function normalizeEncoderState(
	state: StatusPayload["state"],
): EncoderModelState {
	switch (state) {
		case "absent":
		case "downloading":
		case "paused":
		case "present":
			return state;
		default:
			console.warn("[encoder-dict] unknown status state:", state);
			return "absent";
	}
}

function applyStatus(p: StatusPayload): EncoderModelSnapshot {
	return {
		state: normalizeEncoderState(p.state),
		progress: p.progress,
		downloadedBytes: p.downloadedBytes,
		totalBytes: p.totalBytes,
		speedBps: p.speedBps ?? 0,
	};
}

async function runEncoderCommand(
	promise: Promise<Result<null, string>>,
): Promise<void> {
	const result = await promise;
	if (result.status === "error") {
		throw new Error(result.error);
	}
}

function cancelEncoderDownload(): void {
	fireAndForget(
		runEncoderCommand(commands.encoderDictDownloadCancel()),
		"encoder_dict_download_cancel",
	);
}

function preloadEncoderModel(): void {
	fireAndForget(
		runEncoderCommand(commands.encoderDictPreload()),
		"encoder_dict_preload",
	);
}

function unloadEncoderModel(): void {
	fireAndForget(
		runEncoderCommand(commands.encoderDictUnload()),
		"encoder_dict_unload",
	);
}

export function useEncoderModel(): EncoderModel {
	const [s, setS] = useState(INITIAL);

	// Re-query the backend so an optimistic UI state (start → "downloading",
	// remove → "absent") self-corrects when the underlying invoke actually
	// failed. Without this, a rejected start/remove leaves the card showing a
	// state the backend never entered.
	const reconcileFromBackend = () => {
		commands
			.encoderDictStatus()
			.then((status) => setS(applyStatus(status)))
			.catch((error) => {
				console.error("[encoder-dict] status reconcile failed:", error);
			});
	};

	useEffect(() => {
		let active = true;
		commands
			.encoderDictStatus()
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
			(e) => {
				if (active) {
					setS(applyStatus(e.payload));
				}
			},
		);
		const offComplete = listen<CompletePayload>(
			"encoder-dict:download-complete",
			(e) => {
				if (!active) {
					return;
				}
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
				);
			},
		);
		return () => {
			active = false;
			offProgress
				.then((f) => f())
				.catch((error) => {
					console.error(
						"[encoder-dict] progress listener cleanup failed:",
						error,
					);
				});
			offComplete
				.then((f) => f())
				.catch((error) => {
					console.error(
						"[encoder-dict] complete listener cleanup failed:",
						error,
					);
				});
		};
	}, []);

	const start = () => {
		setS((prev) => ({ ...prev, state: "downloading" }));
		runEncoderCommand(commands.encoderDictDownloadStart()).catch((error) => {
			// The optimistic "downloading" state above is wrong if the start
			// invoke rejected — surface it and reconcile with the real status.
			console.error("[encoder-dict] download start failed:", error);
			reconcileFromBackend();
		});
	};
	const pause = () => {
		setS((prev) => ({ ...prev, state: "paused" }));
		runEncoderCommand(commands.encoderDictDownloadPause()).catch((error) => {
			console.error("[encoder-dict] download pause failed:", error);
			reconcileFromBackend();
		});
	};
	const resume = () => {
		setS((prev) => ({ ...prev, state: "downloading" }));
		runEncoderCommand(commands.encoderDictDownloadResume()).catch((error) => {
			console.error("[encoder-dict] download resume failed:", error);
			reconcileFromBackend();
		});
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
		runEncoderCommand(commands.encoderDictRemove()).catch((error) => {
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
