import { useEffect, useRef, useState } from "react";
import {
	onTtsFailed,
	onTtsPlaybackEnded,
	onTtsPlaybackStarted,
	onTtsStarted,
} from "@/shared/api/ipc-client";

interface PlaybackState {
	playing: boolean;
	requestId: string | null;
}

export interface TtsPlayback {
	/** Last synthesis/playback failure reason, or `null`. */
	errorReason: string | null;
	/** Synthesis in flight: a request started but audio hasn't begun. */
	isLoading: boolean;
	/** Audio is actively playing. */
	isSpeaking: boolean;
	/** Raw playback state — `requestId` identifies the active preview. */
	playback: PlaybackState;
	/** Which voice the active preview belongs to (drives per-row affordances). */
	previewVoiceId: string | null;
	setPreviewVoiceId: (id: string | null) => void;
}

/**
 * Track *audible* TTS playback via the lifecycle events the main process
 * broadcasts to every window — so it works even though the audio queue lives in
 * a different window (the settings window has none). Lifecycle:
 * `onTtsStarted` → loading (synthesis ~1s); `onTtsPlaybackStarted` → speaking
 * (audio actually playing); `onTtsPlaybackEnded` → idle (buffered audio fully
 * played out, not the much-earlier `tts_complete`).
 *
 * `previewVoiceId` is set optimistically by the caller on click (the request id
 * isn't known until `onTtsStarted`) and cleared here whenever playback returns
 * to idle — that clear happens INLINE in the terminal handlers so no
 * `requestId === null` reflex effect is needed.
 */
export function useTtsPlayback(): TtsPlayback {
	const [playback, setPlayback] = useState<PlaybackState>({
		requestId: null,
		playing: false,
	});
	const [errorReason, setErrorReason] = useState<string | null>(null);
	const [previewVoiceId, setPreviewVoiceId] = useState<string | null>(null);

	// Latest playback snapshot, so the terminal (ended/failed) handlers can decide
	// whether the event targets the active preview WITHOUT reading state inside a
	// `setPlayback` updater — updaters must stay pure (no nested setState). Written
	// in an effect (never during render), which is the allowed ref-sync shape.
	const playbackRef = useRef(playback);
	useEffect(() => {
		playbackRef.current = playback;
	}, [playback]);

	useEffect(
		() =>
			onTtsStarted(({ requestId }) => {
				setPlayback({ requestId, playing: false });
				setErrorReason(null);
			}),
		[],
	);
	useEffect(
		() =>
			onTtsPlaybackStarted(({ requestId }) => {
				// Synthesis gap is over, audio is now playing. Exact-match so
				// a stale start from a superseded preview can't promote the
				// wrong request.
				setPlayback((p) =>
					p.requestId === requestId ? { requestId, playing: true } : p,
				);
			}),
		[],
	);
	useEffect(
		() =>
			onTtsPlaybackEnded(({ requestId }) => {
				// Exact-match only. `onTtsStarted` always delivers the real id
				// before audio plays, so we never need a wildcard reset — and
				// a stale empty-id "ended" (from the cancel that precedes
				// every preview) must NOT clear the freshly-started request.
				if (playbackRef.current.requestId !== requestId) {
					return;
				}
				// Playback truly ended for the active preview. Both state writes
				// happen here in the event handler (not inside an updater) so the
				// `setPlayback` updater stays pure.
				setPlayback({ requestId: null, playing: false });
				setPreviewVoiceId(null);
			}),
		[],
	);
	useEffect(
		() =>
			onTtsFailed(({ requestId, reason }) => {
				if (playbackRef.current.requestId === requestId) {
					setPlayback({ requestId: null, playing: false });
					setPreviewVoiceId(null);
				}
				setErrorReason(reason);
			}),
		[],
	);

	const isLoading = playback.requestId !== null && !playback.playing;
	const isSpeaking = playback.requestId !== null && playback.playing;

	return {
		playback,
		isLoading,
		isSpeaking,
		previewVoiceId,
		setPreviewVoiceId,
		errorReason,
	};
}
