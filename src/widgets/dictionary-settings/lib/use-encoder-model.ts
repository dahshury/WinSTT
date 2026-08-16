import { useEffect, useState } from "react";
import { commands, type EncoderDownloadStatus, type Result } from "@/bindings";
import { hasNativeRuntime, ipcOnReady } from "@/shared/api/native-boundary";
import { NATIVE_EVENTS as IPC } from "@/shared/api/native-events";

/**
 * State + controls for the on-device encoder dictionary model (the non-LLM fallback).
 *
 * The model downloads via a managed backend flow (start/pause/resume/cancel). This hook subscribes
 * before taking its status snapshot, so leaving and returning to Vocabulary cannot overwrite a
 * newer progress event with stale mount-time state.
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
	error?: string | null;
}

interface ModelErrorPayload {
	error: string;
}

export interface EncoderModel {
	downloadedBytes: number;
	error: string | null;
	progress: number; // 0..1
	speedBps: number;
	state: EncoderModelState;
	totalBytes: number;
	cancel: () => void;
	pause: () => void;
	/** Load + warm the model in the background so the first dictation is fast (no-op if not present). */
	preload: () => void;
	/** Delete the model from disk (and any in-flight transfer). */
	remove: () => void;
	resume: () => void;
	start: () => void;
	/** Drop the loaded model from memory (keeps files on disk). */
	unload: () => void;
}

type EncoderModelSnapshot = Omit<
	EncoderModel,
	"start" | "pause" | "resume" | "cancel" | "remove" | "preload" | "unload"
>;

const INITIAL: EncoderModelSnapshot = {
	state: "loading",
	error: null,
	progress: 0,
	downloadedBytes: 0,
	totalBytes: 0,
	speedBps: 0,
};

const BROWSER_FALLBACK: EncoderModelSnapshot = {
	...INITIAL,
	state: "absent",
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

function applyStatus(payload: StatusPayload): EncoderModelSnapshot {
	return {
		state: normalizeEncoderState(payload.state),
		error: payload.error,
		progress: payload.progress,
		downloadedBytes: payload.downloadedBytes,
		totalBytes: payload.totalBytes,
		speedBps: payload.speedBps ?? 0,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function runEncoderCommand(
	promise: Promise<Result<null, string>>,
): Promise<void> {
	const result = await promise;
	if (result.status === "error") {
		throw new Error(result.error);
	}
}

export function useEncoderModel(): EncoderModel {
	const [snapshot, setSnapshot] = useState<EncoderModelSnapshot>(() =>
		hasNativeRuntime() ? INITIAL : BROWSER_FALLBACK,
	);

	const reconcileFromBackend = (surfacedError?: string) => {
		if (!hasNativeRuntime()) {
			return;
		}
		void commands
			.encoderDictStatus()
			.then((status) => {
				const next = applyStatus(status);
				setSnapshot({ ...next, error: surfacedError ?? next.error });
			})
			.catch((error) => {
				const message = surfacedError ?? errorMessage(error);
				console.error("[encoder-dict] status reconcile failed:", error);
				setSnapshot((previous) => ({ ...previous, error: message }));
			});
	};

	useEffect(() => {
		if (!hasNativeRuntime()) {
			return;
		}

		let active = true;
		let eventRevision = 0;
		const cleanups: Array<() => void> = [];
		const register = async <T>(
			channel: string,
			handle: (payload: T) => void,
		) => {
			const cleanup = await ipcOnReady(channel, (payload) => {
				if (!active) {
					return;
				}
				eventRevision += 1;
				handle(payload as T);
			});
			if (active) {
				cleanups.push(cleanup);
			} else {
				cleanup();
			}
		};

		void (async () => {
			try {
				await Promise.all([
					register<StatusPayload>(
						IPC.ENCODER_DICT_DOWNLOAD_PROGRESS,
						(payload) => setSnapshot(applyStatus(payload)),
					),
					register<CompletePayload>(
						IPC.ENCODER_DICT_DOWNLOAD_COMPLETE,
						(payload) => {
							if (payload.error) {
								setSnapshot((previous) => ({
									...previous,
									error: payload.error ?? null,
								}));
								reconcileFromBackend(payload.error);
								return;
							}
							setSnapshot(
								payload.present
									? {
											state: "present",
											error: null,
											progress: 1,
											downloadedBytes: 0,
											totalBytes: 0,
											speedBps: 0,
										}
									: BROWSER_FALLBACK,
							);
						},
					),
					register<ModelErrorPayload>(IPC.ENCODER_DICT_MODEL_ERROR, (payload) =>
						setSnapshot((previous) => ({
							...previous,
							error: payload.error,
						})),
					),
				]);
				const revisionBeforeSnapshot = eventRevision;
				const status = await commands.encoderDictStatus();
				if (active && eventRevision === revisionBeforeSnapshot) {
					setSnapshot(applyStatus(status));
				}
			} catch (error) {
				if (active) {
					const message = errorMessage(error);
					console.error("[encoder-dict] lifecycle setup failed:", error);
					setSnapshot((previous) => ({
						...previous,
						state: previous.state === "loading" ? "absent" : previous.state,
						error: message,
					}));
				}
			}
		})();

		return () => {
			active = false;
			for (const cleanup of cleanups) {
				cleanup();
			}
		};
	}, []);

	const runAction = (
		label: string,
		command: () => Promise<Result<null, string>>,
		optimistic?: EncoderModelSnapshot,
	) => {
		if (!hasNativeRuntime()) {
			return;
		}
		if (optimistic) {
			setSnapshot(optimistic);
		} else {
			setSnapshot((previous) => ({ ...previous, error: null }));
		}
		void runEncoderCommand(command()).catch((error) => {
			const message = errorMessage(error);
			console.error(`[encoder-dict] ${label} failed:`, error);
			reconcileFromBackend(message);
		});
	};

	const start = () =>
		runAction("download start", commands.encoderDictDownloadStart, {
			...snapshot,
			state: "downloading",
			error: null,
		});
	const pause = () =>
		runAction("download pause", commands.encoderDictDownloadPause, {
			...snapshot,
			state: "paused",
			error: null,
		});
	const resume = () =>
		runAction("download resume", commands.encoderDictDownloadResume, {
			...snapshot,
			state: "downloading",
			error: null,
		});
	const cancel = () =>
		runAction("download cancel", commands.encoderDictDownloadCancel);
	const preload = () => runAction("preload", commands.encoderDictPreload);
	const unload = () => runAction("unload", commands.encoderDictUnload);
	const remove = () =>
		runAction("remove", commands.encoderDictRemove, BROWSER_FALLBACK);

	return {
		...snapshot,
		start,
		pause,
		resume,
		cancel,
		remove,
		preload,
		unload,
	};
}
