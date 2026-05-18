"use client";

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
 * subscriptions to the IPC chunk / complete / failed streams. Renderer
 * components read state via {@link useTtsPlaybackState} and trigger
 * cancellation via {@link stopTts}; this hook only mounts the
 * subscriptions and routes payloads into the queue.
 *
 * Mount once at the renderer root (RootLayout).
 */
export function useTtsPlayback(): TtsPlaybackState {
	const queueRef = useRef<TtsPlaybackQueue | null>(null);
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
			setState({ status: "speaking", error: null, requestId: payload.requestId });
		};

		const onChunk = (payload: TtsChunkPayload) => {
			queue.enqueue({
				requestId: payload.requestId,
				sampleRate: payload.sampleRate,
				channels: payload.channels,
				format: payload.format,
				pcm: payload.pcm,
			});
		};

		const onCompleted = (payload: TtsCompletedPayload) => {
			queue.markComplete(payload.requestId);
			if (payload.cancelled) {
				queue.stop();
			}
		};

		const onFailed = (payload: TtsFailedPayload) => {
			queue.stop();
			setState({ status: "error", error: payload.reason, requestId: null });
		};

		const unEnd = queue.onEnd(() => {
			setState((prev) =>
				prev.status === "speaking" ? { status: "idle", error: null, requestId: null } : prev
			);
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
