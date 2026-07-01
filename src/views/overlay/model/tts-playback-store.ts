import { create } from "zustand";
import { ttsCancel } from "@/shared/api/ipc-client";
import type { TtsPlaybackQueue } from "../lib/playback-queue";

/**
 * Lifecycle of an audible TTS read, as surfaced in the overlay pill:
 *   - `idle`     - nothing playing.
 *   - `loading`  - synthesis started, waiting for the first playable chunk.
 *   - `speaking` - audio is playing.
 *   - `paused`   - the user paused (AudioContext suspended); audio resumes in place.
 *   - `error`    - synthesis/playback failed; the reason is held in `error`.
 */
export type TtsPlaybackStatus =
	| "idle"
	| "loading"
	| "speaking"
	| "paused"
	| "error";

interface TtsPlaybackStore {
	/** Furthest seekable point (seconds) — equals `duration` while we only retain
	 *  fully-decoded buffers; surfaced separately for the seek bar's buffered
	 *  underlay. */
	bufferedEnd: number;
	/** Played position in seconds, polled from the queue by the overlay rAF. */
	currentTime: number;
	/** Total buffered seconds — grows while streaming, final after `tts_complete`. */
	duration: number;
	/** Failure reason while `status === "error"`, else `null`. */
	error: string | null;
	/** Mark playback truly finished (queue drained / discarded). Preserves an
	 *  `error` status so the user can still read why it failed. */
	markEnded: () => void;
	/** Mark a synthesis/playback failure with its reason. */
	markFailed: (reason: string) => void;
	/** Mark the first audible buffer scheduled (idempotent confirm of `speaking`). */
	markPlaying: () => void;
	/** Mark a new read started (synthesis kicked off). */
	markStarted: (requestId: string) => void;
	/** Whether the user has muted playback (separate from `volume` so unmuting
	 *  restores the prior level). */
	muted: boolean;
	/** The request id of the active read, or `null`. */
	requestId: string | null;
	/** Toggle the paused status without disturbing a non-playing state. */
	setPausedStatus: (paused: boolean) => void;
	/** Batched continuous-position update from the overlay rAF (no-ops when the
	 *  three values are unchanged so it doesn't churn re-renders every frame). */
	setProgress: (
		currentTime: number,
		duration: number,
		bufferedEnd: number,
	) => void;
	/** Set the muted latch (mirrors the queue). */
	setMuted: (muted: boolean) => void;
	/** Set the pre-mute volume in `[0, 1]` (mirrors the queue). */
	setVolume: (volume: number) => void;
	status: TtsPlaybackStatus;
	/** Pre-mute playback volume in `[0, 1]`. */
	volume: number;
}

export const useTtsPlaybackStore = create<TtsPlaybackStore>()((set) => ({
	status: "idle",
	requestId: null,
	error: null,
	currentTime: 0,
	duration: 0,
	bufferedEnd: 0,
	volume: 1,
	muted: false,
	markStarted: (requestId) =>
		set({
			status: "loading",
			requestId,
			error: null,
			currentTime: 0,
			duration: 0,
			bufferedEnd: 0,
		}),
	// Audio actually scheduled — confirm `speaking` unless the user paused
	// before the first buffer landed (don't stomp a `paused` intent).
	markPlaying: () =>
		set((s) => (s.status === "paused" ? s : { ...s, status: "speaking" })),
	// `error` survives the queue's id-less `onEnd` (which fires right after
	// `markFailed` stops the queue) so the failure reason isn't clobbered.
	markEnded: () =>
		set((s) =>
			s.status === "error"
				? s
				: {
						...s,
						status: "idle",
						requestId: null,
						error: null,
						currentTime: 0,
						duration: 0,
						bufferedEnd: 0,
					},
		),
	markFailed: (reason) =>
		set({ status: "error", requestId: null, error: reason }),
	setPausedStatus: (paused) =>
		set((s) => {
			if (paused) {
				return s.status === "speaking" || s.status === "loading"
					? { ...s, status: "paused" }
					: s;
			}
			return s.status === "paused" ? { ...s, status: "speaking" } : s;
		}),
	// Bail when nothing changed so the per-frame rAF poll doesn't trigger a
	// re-render every tick (zustand re-renders subscribers on any new state).
	setProgress: (currentTime, duration, bufferedEnd) =>
		set((s) =>
			s.currentTime === currentTime &&
			s.duration === duration &&
			s.bufferedEnd === bufferedEnd
				? s
				: { ...s, currentTime, duration, bufferedEnd },
		),
	setVolume: (volume) => set({ volume }),
	setMuted: (muted) => set({ muted }),
}));

// The playback queue lives in whichever window mounts `TtsPlaybackMount` (the
// overlay). Holding a module-level reference lets the pill's controls reach the
// *same* queue without prop-drilling it through the view tree — the queue is a
// singleton per window and the controls are local to that window.
let activeQueue: TtsPlaybackQueue | null = null;

/** Register the window's playback queue so the pill controls can reach it. */
export function registerTtsQueue(queue: TtsPlaybackQueue): void {
	activeQueue = queue;
}

/** Drop the queue reference on unmount (only if it's still the active one). */
export function unregisterTtsQueue(queue: TtsPlaybackQueue): void {
	if (activeQueue === queue) {
		activeQueue = null;
	}
}

/**
 * Live playback level in ``[0, 1]`` off the active queue's analyser — read each
 * frame by the overlay's visualiser bridge. ``0`` when nothing is registered.
 */
export function getTtsLevel(): number {
	return activeQueue?.getLevel() ?? 0;
}

/**
 * Current played position / total / buffered seconds off the active queue —
 * polled each frame by the overlay rAF and pushed into the store via
 * {@link useTtsPlaybackStore.setProgress}. All-zero when nothing is registered.
 */
export function getTtsProgress(): {
	currentTime: number;
	duration: number;
	bufferedEnd: number;
} {
	const queue = activeQueue;
	if (queue == null) {
		return { currentTime: 0, duration: 0, bufferedEnd: 0 };
	}
	return {
		currentTime: queue.getCurrentTime(),
		duration: queue.getDuration(),
		bufferedEnd: queue.getBufferedEnd(),
	};
}

/**
 * Seek the active read to `seconds` (clamped by the queue to the buffered
 * range). Optimistically reflects the new position in the store so the seek
 * thumb doesn't snap back for one frame before the next rAF tick.
 */
export function seekTts(seconds: number): void {
	activeQueue?.seek(seconds);
	const { duration, bufferedEnd } = useTtsPlaybackStore.getState();
	useTtsPlaybackStore.getState().setProgress(seconds, duration, bufferedEnd);
}

/** Set the pre-mute playback volume (0..1) on the queue and reflect it. */
export function setTtsVolume(volume: number): void {
	activeQueue?.setVolume(volume);
	useTtsPlaybackStore.getState().setVolume(volume);
}

/** Toggle mute on the queue and reflect it in the store. */
export function toggleTtsMuted(): void {
	const next = !useTtsPlaybackStore.getState().muted;
	activeQueue?.setMuted(next);
	useTtsPlaybackStore.getState().setMuted(next);
}

/** Pause the active read (suspends the AudioContext) and reflect it in the store. */
export function pauseTts(): void {
	activeQueue?.pause();
	useTtsPlaybackStore.getState().setPausedStatus(true);
}

/** Resume a paused read and reflect it in the store. */
export function resumeTts(): void {
	activeQueue?.resume();
	useTtsPlaybackStore.getState().setPausedStatus(false);
}

/**
 * Discard the active read: stop the local audio immediately (so it goes silent
 * the instant the user clicks) AND cancel the server-side synthesis so no more
 * chunks arrive. The queue's `stop()` fires `onEnd` → the store collapses to
 * `idle`.
 */
export function discardTts(): void {
	const { requestId } = useTtsPlaybackStore.getState();
	activeQueue?.stop();
	ttsCancel(requestId ?? undefined);
}
