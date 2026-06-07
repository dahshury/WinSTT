import { create } from "zustand";
import { ttsCancel } from "@/shared/api/ipc-client";
import type { TtsPlaybackQueue } from "../lib/playback-queue";

/**
 * Lifecycle of an audible TTS read, as surfaced in the overlay pill:
 *   - `idle`     — nothing playing.
 *   - `speaking` — synthesis started and/or audio is playing.
 *   - `paused`   — the user paused (AudioContext suspended); audio resumes in place.
 *   - `error`    — synthesis/playback failed; the reason is held in `error`.
 */
export type TtsPlaybackStatus = "idle" | "speaking" | "paused" | "error";

interface TtsPlaybackStore {
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
	/** The request id of the active read, or `null`. */
	requestId: string | null;
	/** Toggle the paused status without disturbing a non-playing state. */
	setPausedStatus: (paused: boolean) => void;
	status: TtsPlaybackStatus;
}

export const useTtsPlaybackStore = create<TtsPlaybackStore>()((set) => ({
	status: "idle",
	requestId: null,
	error: null,
	markStarted: (requestId) =>
		set({ status: "speaking", requestId, error: null }),
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
				: { ...s, status: "idle", requestId: null, error: null },
		),
	markFailed: (reason) =>
		set({ status: "error", requestId: null, error: reason }),
	setPausedStatus: (paused) =>
		set((s) => {
			if (paused) {
				return s.status === "speaking" ? { ...s, status: "paused" } : s;
			}
			return s.status === "paused" ? { ...s, status: "speaking" } : s;
		}),
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
