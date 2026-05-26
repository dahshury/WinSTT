import { type MutableRefObject, useEffect, useRef, useState } from "react";
import { useSettingsStore } from "@/entities/setting";
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

type TtsStatus = "idle" | "speaking" | "error";

export interface TtsPlaybackState {
	error: string | null;
	requestId: string | null;
	status: TtsStatus;
}

const INITIAL_STATE: TtsPlaybackState = {
	status: "idle",
	error: null,
	requestId: null,
};

/**
 * Subscribe to a server ``tts:chunk``: record the active id (so the
 * later id-less ``onEnd`` can name the request to main) and forward
 * the payload into the playback queue.
 */
export function handleTtsChunkPayload(
	queue: TtsPlaybackQueue,
	activeIdRef: MutableRefObject<string | null>,
	payload: TtsChunkPayload
): void {
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
}

/**
 * Handle a server ``tts:complete``. Mark the queue so it can fire
 * onEnd once the last buffered source drains; if the request was
 * cancelled, abort playback immediately.
 */
export function handleTtsCompletedPayload(
	queue: TtsPlaybackQueue,
	payload: TtsCompletedPayload
): void {
	// `tts_complete` only means generation finished — buffered audio
	// is usually still playing. Let the queue play out; `onEnd`
	// fires once the last scheduled source actually stops.
	queue.markComplete(payload.requestId);
	if (payload.cancelled) {
		queue.stop();
	}
}

/**
 * Build the ``onEnd`` callback for the queue. Reports the truly-ended
 * id to main and only collapses the local state back to ``idle`` from
 * a ``speaking`` baseline so a concurrent ``error`` isn't clobbered.
 */
export function makeQueueEndHandler(
	activeIdRef: MutableRefObject<string | null>,
	setState: (updater: (prev: TtsPlaybackState) => TtsPlaybackState) => void
): () => void {
	return () => {
		const endedId = activeIdRef.current;
		activeIdRef.current = null;
		setState(reduceQueueEnd);
		// Tell every window that audio truly stopped. Always emit (even
		// with an empty id) so a wildcard listener can reset.
		ttsReportPlaybackEnded(endedId ?? "");
	};
}

/**
 * Pure state reducer for the queue-end transition: collapse a
 * ``speaking`` state to idle, leave any other status (``error``)
 * untouched so the user can still see why playback failed.
 */
export function reduceQueueEnd(prev: TtsPlaybackState): TtsPlaybackState {
	if (prev.status === "speaking") {
		return INITIAL_STATE;
	}
	return prev;
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
	const outputDeviceId = useSettingsStore((s) => s.settings.general.outputDeviceId);
	// The id whose audio is currently scheduled — needed so `onEnd` (which
	// carries no id) can tell main *which* request finished.
	const activeIdRef = useRef<string | null>(null);
	const [state, setState] = useState<TtsPlaybackState>(INITIAL_STATE);

	useEffect(() => {
		queueRef.current ??= new TtsPlaybackQueue();
		const queue = queueRef.current;

		const onStarted = (payload: TtsStartedPayload) => {
			activeIdRef.current = payload.requestId;
			setState({ status: "speaking", error: null, requestId: payload.requestId });
		};
		const onChunk = (payload: TtsChunkPayload) =>
			handleTtsChunkPayload(queue, activeIdRef, payload);
		const onCompleted = (payload: TtsCompletedPayload) => handleTtsCompletedPayload(queue, payload);
		const onFailed = (payload: TtsFailedPayload) => {
			queue.stop();
			activeIdRef.current = null;
			setState({ status: "error", error: payload.reason, requestId: null });
		};

		const unStart = queue.onStart(() => {
			ttsReportPlaybackStarted(activeIdRef.current ?? "");
		});
		const unEnd = queue.onEnd(makeQueueEndHandler(activeIdRef, setState));
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
	}, []);

	// Live-route to the user's currently selected output device. Kept as a
	// separate effect so the heavy IPC subscriber wiring above doesn't churn
	// every time outputDeviceId changes.
	useEffect(() => {
		queueRef.current?.setOutputDeviceId(outputDeviceId);
	}, [outputDeviceId]);

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
