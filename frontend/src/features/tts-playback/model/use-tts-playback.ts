import { useCallback, useEffect, useRef, useState } from "react";
import {
	onTtsChunk,
	onTtsCompleted,
	onTtsFailed,
	onTtsStarted,
	type TtsChunkPayload,
	type TtsCompletedPayload,
	type TtsFailedPayload,
	type TtsStartedPayload,
	ttsCancel,
	ttsReportPlaybackEnded,
	ttsReportPlaybackStarted,
} from "@/shared/api/ipc-client";
import { TtsPlaybackQueue } from "../lib/playback-queue";

export type TtsStatus = "idle" | "speaking" | "error";

export interface TtsPlaybackState {
	error: string | null;
	requestId: string | null;
	status: TtsStatus;
}

/**
 * Globally-mounted hook that owns the Web Audio playback queue and the
 * IPC chunk / complete / failed subscriptions. It routes payloads into
 * the queue and — crucially — reports back to the main process when the
 * audio truly finishes playing (the queue's `onEnd`, which fires after
 * the last buffered source stops, not when the server's much-earlier
 * `tts_complete` arrives). Main re-broadcasts that as `tts:playback-ended`
 * so a play/stop control in a window without a queue (the settings
 * window) can stay in sync.
 *
 * Mount once at the renderer root (RootLayout).
 */
export function useTtsPlayback(): TtsPlaybackState {
	const queueRef = useRef<TtsPlaybackQueue | null>(null);
	// The id whose audio is currently scheduled — needed so `onEnd` (which
	// carries no id) can tell main *which* request finished.
	const activeIdRef = useRef<string | null>(null);
	const [state, setState] = useState<TtsPlaybackState>({
		status: "idle",
		error: null,
		requestId: null,
	});

	const ensureQueue = useCallback((): TtsPlaybackQueue => {
		if (queueRef.current == null) {
			queueRef.current = new TtsPlaybackQueue();
		}
		return queueRef.current;
	}, []);

	useEffect(() => {
		const queue = ensureQueue();

		const onStarted = (payload: TtsStartedPayload) => {
			activeIdRef.current = payload.requestId;
			setState({ status: "speaking", error: null, requestId: payload.requestId });
		};

		const onChunk = (payload: TtsChunkPayload) => {
			if (payload.requestId) {
				activeIdRef.current = payload.requestId;
			}
			queue.enqueue({
				requestId: payload.requestId,
				sampleRate: payload.sampleRate,
				channels: payload.channels,
				format: payload.format,
				pcm: payload.pcm,
			});
		};

		const onCompleted = (payload: TtsCompletedPayload) => {
			// `tts_complete` only means generation finished — buffered audio
			// is usually still playing. Let the queue play out; `onEnd`
			// fires once the last scheduled source actually stops.
			queue.markComplete(payload.requestId);
			if (payload.cancelled) {
				queue.stop();
			}
		};

		const onFailed = (payload: TtsFailedPayload) => {
			queue.stop();
			activeIdRef.current = null;
			setState({ status: "error", error: payload.reason, requestId: null });
		};

		const unStart = queue.onStart(() => {
			ttsReportPlaybackStarted(activeIdRef.current ?? "");
		});

		const unEnd = queue.onEnd(() => {
			const endedId = activeIdRef.current;
			activeIdRef.current = null;
			setState((prev) =>
				prev.status === "speaking" ? { status: "idle", error: null, requestId: null } : prev
			);
			// Tell every window that audio truly stopped. Always emit (even
			// with an empty id) so a wildcard listener can reset.
			ttsReportPlaybackEnded(endedId ?? "");
		});

		const unStarted = onTtsStarted(onStarted);
		const unChunk = onTtsChunk(onChunk);
		const unCompleted = onTtsCompleted(onCompleted);
		const unFailed = onTtsFailed(onFailed);

		return () => {
			unStarted();
			unChunk();
			unCompleted();
			unFailed();
			unStart();
			unEnd();
		};
	}, [ensureQueue]);

	useEffect(
		() => () => {
			queueRef.current?.dispose();
			queueRef.current = null;
		},
		[]
	);

	return state;
}

/** Imperatively stop the active TTS playback (also cancels the server-side run). */
export function stopTts(requestId?: string): void {
	ttsCancel(requestId);
}
