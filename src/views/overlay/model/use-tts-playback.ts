import { type MutableRefObject, useEffect, useRef } from "react";
import { useSettingsStore } from "@/entities/setting";
import {
	onTtsChunk,
	onTtsCompleted,
	onTtsDiscardPlayback,
	onTtsFailed,
	onTtsPausePlayback,
	onTtsResumePlayback,
	onTtsStarted,
	type TtsChunkPayload,
	type TtsCompletedPayload,
	ttsCancel,
	ttsReportPlaybackEnded,
	ttsReportPlaybackStarted,
	ttsRequestPlaybackPause,
	ttsRequestPlaybackResume,
} from "@/shared/api/ipc-client";
import { TtsPlaybackQueue } from "../lib/playback-queue";
import {
	discardTts,
	pauseTts,
	registerTtsQueue,
	resumeTts,
	unregisterTtsQueue,
	type TtsPlaybackStatus,
	useTtsPlaybackStore,
} from "./tts-playback-store";

function getTtsMediaSession(): MediaSession | null {
	if (typeof navigator === "undefined") {
		return null;
	}
	return navigator.mediaSession ?? null;
}

function setMediaSessionAction(
	session: MediaSession,
	action: MediaSessionAction,
	handler: MediaSessionActionHandler | null,
): void {
	try {
		session.setActionHandler(action, handler);
	} catch {
		// Some Chromium/WebView builds expose Media Session but reject individual
		// actions. Dropping that action is better than breaking TTS playback setup.
	}
}

export function ttsMediaSessionPlaybackState(
	status: TtsPlaybackStatus,
): MediaSessionPlaybackState {
	if (status === "paused") {
		return "paused";
	}
	if (status === "loading" || status === "speaking") {
		return "playing";
	}
	return "none";
}

function updateTtsMediaSession(
	status: TtsPlaybackStatus,
	requestId: string | null,
): void {
	const session = getTtsMediaSession();
	if (session == null) {
		return;
	}
	session.playbackState = ttsMediaSessionPlaybackState(status);
	if (requestId == null) {
		session.metadata = null;
		return;
	}
	if (typeof MediaMetadata !== "undefined") {
		session.metadata ??= new MediaMetadata({
			title: "Read Aloud",
			artist: "WinSTT",
		});
	}
}

export function installTtsMediaSessionHandlers(
	session: MediaSession | null = getTtsMediaSession(),
): () => void {
	if (session == null) {
		return () => {
			/* Media Session unavailable. */
		};
	}
	setMediaSessionAction(session, "pause", () => {
		ttsRequestPlaybackPause("media-session");
	});
	setMediaSessionAction(session, "play", () => {
		ttsRequestPlaybackResume("media-session");
	});
	return () => {
		setMediaSessionAction(session, "pause", null);
		setMediaSessionAction(session, "play", null);
		session.playbackState = "none";
		session.metadata = null;
	};
}

export function handleTtsPausePlaybackControl(status: TtsPlaybackStatus): void {
	if (status === "speaking" || status === "loading") {
		pauseTts();
	}
}

export function handleTtsResumePlaybackControl(
	status: TtsPlaybackStatus,
): void {
	if (status === "paused") {
		resumeTts();
	}
}

/**
 * Subscribe to a server ``tts:chunk``: record the active id (so the
 * later id-less ``onEnd`` can name the request to main) and forward
 * the payload into the playback queue.
 */
export function handleTtsChunkPayload(
	queue: TtsPlaybackQueue,
	activeIdRef: MutableRefObject<string | null>,
	payload: TtsChunkPayload,
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
	payload: TtsCompletedPayload,
): void {
	// `tts_complete` only means generation finished — buffered audio
	// is usually still playing. Let the queue play out; `onEnd`
	// fires once the last scheduled source actually stops.
	queue.markComplete(payload.requestId);
	if (payload.cancelled) {
		queue.stop();
		const store = useTtsPlaybackStore.getState();
		if (store.requestId === payload.requestId || payload.requestId === "") {
			store.markEnded();
		}
		return;
	}
	const store = useTtsPlaybackStore.getState();
	if (
		store.requestId === payload.requestId &&
		queue.currentRequestId !== payload.requestId
	) {
		store.markEnded();
	}
}

/**
 * Globally-mounted hook that owns the Web Audio playback queue and the IPC
 * chunk / complete / failed subscriptions. It routes payloads into the queue,
 * drives the shared `useTtsPlaybackStore` (so the overlay pill + its controls
 * read one source of truth), and reports back to the main process when the
 * audio truly finishes playing (the queue's `onEnd`, which fires after the last
 * buffered source stops — not when the server's much-earlier `tts_complete`
 * arrives). Main re-broadcasts that as `tts:playback-ended` so a play/stop
 * control in a window without a queue (the settings window) can stay in sync.
 *
 * Mount once **in the overlay window** (it's the visible window during a read,
 * so the analyser the visualiser taps reads accurate levels; `backgroundThrottling`
 * is disabled on the overlay so its rAF keeps running even while hidden).
 */
export function useTtsPlayback(): void {
	const queueRef = useRef<TtsPlaybackQueue | null>(null);
	const outputDeviceId = useSettingsStore(
		(s) => s.settings.general.outputDeviceId,
	);
	const status = useTtsPlaybackStore((s) => s.status);
	const requestId = useTtsPlaybackStore((s) => s.requestId);
	// The id whose audio is currently scheduled — needed so `onEnd` (which
	// carries no id) can tell main *which* request finished.
	const activeIdRef = useRef<string | null>(null);

	useEffect(() => {
		if (queueRef.current === null) {
			queueRef.current = new TtsPlaybackQueue();
		}
		const queue = queueRef.current;
		registerTtsQueue(queue);
		const store = useTtsPlaybackStore.getState;

		const unStart = queue.onStart(() => {
			ttsReportPlaybackStarted(activeIdRef.current ?? "");
			store().markPlaying();
		});
		const unEnd = queue.onEnd(() => {
			const endedId = activeIdRef.current;
			activeIdRef.current = null;
			store().markEnded();
			// Tell every window that audio truly stopped. Always emit (even
			// with an empty id) so a wildcard listener can reset.
			ttsReportPlaybackEnded(endedId ?? "");
		});
		const unStarted = onTtsStarted((payload) => {
			activeIdRef.current = payload.requestId;
			store().markStarted(payload.requestId);
		});
		const unChunk = onTtsChunk((payload) =>
			handleTtsChunkPayload(queue, activeIdRef, payload),
		);
		const unCompleted = onTtsCompleted((payload) =>
			handleTtsCompletedPayload(queue, payload),
		);
		const unPausePlayback = onTtsPausePlayback(() => {
			handleTtsPausePlaybackControl(store().status);
		});
		const unResumePlayback = onTtsResumePlayback(() => {
			handleTtsResumePlaybackControl(store().status);
		});
		const unDiscardPlayback = onTtsDiscardPlayback(() => {
			discardTts();
		});
		const unFailed = onTtsFailed((payload) => {
			queue.stop();
			activeIdRef.current = null;
			store().markFailed(payload.reason);
		});

		return () => {
			unStarted();
			unChunk();
			unCompleted();
			unPausePlayback();
			unResumePlayback();
			unDiscardPlayback();
			unFailed();
			unStart();
			unEnd();
			unregisterTtsQueue(queue);
		};
	}, []);

	// Live-route to the user's currently selected output device. Kept as a
	// separate effect so the heavy IPC subscriber wiring above doesn't churn
	// every time outputDeviceId changes.
	useEffect(() => {
		queueRef.current?.setOutputDeviceId(outputDeviceId);
	}, [outputDeviceId]);

	useEffect(() => installTtsMediaSessionHandlers(), []);

	useEffect(() => {
		updateTtsMediaSession(status, requestId);
	}, [status, requestId]);

	useEffect(
		() => () => {
			queueRef.current?.dispose();
			queueRef.current = null;
		},
		[],
	);
}

/** Imperatively stop the active TTS playback (also cancels the server-side run). */
export function stopTts(requestId?: string): void {
	ttsCancel(requestId);
}
