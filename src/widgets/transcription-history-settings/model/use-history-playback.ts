import { useEffect, useRef, useState } from "react";
import {
	alignTranscriptionHistoryAudio,
	loadTranscriptionHistoryAudio,
	loadTtsHistoryAudio,
	type WordTiming,
} from "@/shared/api/ipc-client";
import { fireAndForget } from "@/shared/lib/fire-and-forget";

/** Which history table the clip belongs to — picks the audio loader, and only
 *  STT recordings get word-alignment (TTS playback has no spoken-word sweep). */
export type PlaybackSource = "stt" | "tts";

/**
 * Switch the underlying audio sink for an HTMLAudioElement. `setSinkId` is
 * gated on a "speaker-selection" permission that the reference grants by default
 * for the file-loaded renderer, but the call still fails on devices that
 * don't exist or aren't reachable — swallow that case (the play silently
 * falls back to the system default rather than throwing inside the JSX).
 */
async function routeAudioToSink(
	el: HTMLAudioElement,
	deviceId: string,
): Promise<void> {
	if (!deviceId) {
		return;
	}
	const setSinkId = (
		el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
	).setSinkId;
	if (!setSinkId) {
		return;
	}
	try {
		await setSinkId.call(el, deviceId);
	} catch {
		// device unavailable — system default takes over
	}
}

export interface PlaybackState {
	activeIndex: number;
	/** Playhead position (seconds) — drives the seek bar and the paused highlight. */
	currentTime: number;
	/** Total recording length (seconds), known once metadata loads. */
	duration: number;
	/** True once the recording has been loaded (play pressed at least once), so
	 *  the row can reveal the media controls and keep them visible when paused. */
	hasStarted: boolean;
	loading: boolean;
	playing: boolean;
	/** Playback speed multiplier (1 = normal). Applied live to the `<audio>` element. */
	rate: number;
	/** Jump the playhead to `seconds` (word click / seek-bar drag). Highlights and
	 *  the bar follow immediately, whether playing or paused. */
	seek: (seconds: number) => void;
	/** Set the playback speed (1 / 1.5 / 2). Takes effect immediately, playing or paused. */
	setRate: (rate: number) => void;
	toggle: () => void;
	words: WordTiming[] | null;
}

/**
 * Binary-search the last word whose start time has been reached, so silences
 * and gaps keep the prior word lit. Returns -1 before the first word.
 */
function findActiveWordIndex(words: WordTiming[], t: number): number {
	let lo = 0;
	let hi = words.length - 1;
	let ans = -1;
	while (lo <= hi) {
		const mid = Math.floor((lo + hi) / 2);
		const word = words[mid];
		if (word && word.start <= t) {
			ans = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return ans;
}

/**
 * Owns a row's `<audio>` element. On first play it lazily fetches both the WAV
 * and the per-word timestamps, then tracks playback position from the media
 * element's own events. No-ops when the entry has no recording; called
 * unconditionally per row (Rules of Hooks).
 */
export function useHistoryPlayback(
	entryId: string,
	hasAudio: boolean,
	outputDeviceId: string,
	source: PlaybackSource = "stt",
): PlaybackState {
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const detachAudioEventsRef = useRef<(() => void) | null>(null);
	const playbackRequestRef = useRef(0);
	const [playing, setPlaying] = useState(false);
	const [loading, setLoading] = useState(false);
	const [words, setWords] = useState<WordTiming[] | null>(null);
	const [currentTime, setCurrentTime] = useState(0);
	const [duration, setDuration] = useState(0);
	const [hasStarted, setHasStarted] = useState(false);
	const [rate, setRateState] = useState(1);
	// Mirrors `rate` for `beginPlayback`, which creates the `<audio>` element inside
	// an async closure that would otherwise capture a stale rate.
	const rateRef = useRef(1);

	useEffect(
		() => () => {
			playbackRequestRef.current += 1;
			detachAudioEventsRef.current?.();
			detachAudioEventsRef.current = null;
			audioRef.current?.pause();
			audioRef.current = null;
		},
		[],
	);

	const beginPlayback = async () => {
		if (!audioRef.current) {
			const request = ++playbackRequestRef.current;
			setLoading(true);
			// Fetch the audio + word timings together on first play. TTS clips have
			// no spoken-word alignment — the seek bar alone carries scrubbing.
			const [dataUri, timings] = await Promise.all([
				source === "tts"
					? loadTtsHistoryAudio(entryId)
					: loadTranscriptionHistoryAudio(entryId),
				source === "tts"
					? Promise.resolve([])
					: alignTranscriptionHistoryAudio(entryId),
			]);
			if (playbackRequestRef.current !== request) {
				return;
			}
			setLoading(false);
			if (!dataUri) {
				return;
			}
			if (timings.length > 0) {
				setWords(timings);
			}
			const el = new Audio(dataUri);
			const syncCurrentTime = () => setCurrentTime(el.currentTime);
			// Duration for the seek bar. WAV metadata resolves near-instantly from
			// the data URI; guard against the transient `Infinity`/`NaN` browsers
			// report before the header is parsed.
			const captureDuration = () => {
				if (Number.isFinite(el.duration) && el.duration > 0) {
					setDuration(el.duration);
				}
			};
			const handleEnded = () => {
				el.currentTime = 0;
				setCurrentTime(0);
				setPlaying(false);
			};
			const handlePlay = () => setPlaying(true);
			const handlePause = () => setPlaying(false);
			const eventBindings = [
				["timeupdate", syncCurrentTime],
				["seeking", syncCurrentTime],
				["seeked", syncCurrentTime],
				["loadedmetadata", captureDuration],
				["durationchange", captureDuration],
				["play", handlePlay],
				["pause", handlePause],
				["ended", handleEnded],
			] as const;
			for (const [eventName, listener] of eventBindings) {
				el.addEventListener(eventName, listener);
			}
			detachAudioEventsRef.current = () => {
				for (const [eventName, listener] of eventBindings) {
					el.removeEventListener(eventName, listener);
				}
			};
			captureDuration();
			el.playbackRate = rateRef.current;
			audioRef.current = el;
			setHasStarted(true);
		}
		await routeAudioToSink(audioRef.current, outputDeviceId);
		try {
			await audioRef.current.play();
		} catch (err) {
			// Don't leave the button stuck in a fake "playing" state if the
			// element can't start (decode/CSP/device) — surface it and bail.
			console.error("[history] playback failed", err);
			setPlaying(false);
			return;
		}
		setPlaying(true);
	};

	const toggle = () => {
		if (!hasAudio) {
			return;
		}
		if (playing && audioRef.current) {
			audioRef.current.pause();
			setPlaying(false);
			return;
		}
		fireAndForget(beginPlayback(), "history.beginPlayback");
	};

	// Move the playhead (word click / seek-bar drag). The `<audio>` element is the
	// source of truth, so set its `currentTime` and mirror it into state right away
	// — the highlight and bar update instantly even while paused, without waiting
	// for the browser's next `seeking` / `timeupdate` event. No-op until the
	// recording has been loaded.
	const seek = (seconds: number) => {
		const el = audioRef.current;
		if (!el) {
			return;
		}
		const clamped = Math.max(
			0,
			duration > 0 ? Math.min(seconds, duration) : seconds,
		);
		el.currentTime = clamped;
		setCurrentTime(clamped);
	};

	// Change the playback speed. The `<audio>` element applies it live (playing or
	// paused); the ref keeps `beginPlayback`'s element creation in sync so a rate
	// picked before first play carries over.
	const setRate = (next: number) => {
		rateRef.current = next;
		setRateState(next);
		if (audioRef.current) {
			audioRef.current.playbackRate = next;
		}
	};

	// Highlight follows the playhead whenever the clip is loaded — not just while
	// playing — so seeking (or a word click) relights the right word when paused.
	const activeIndex =
		hasStarted && words ? findActiveWordIndex(words, currentTime) : -1;
	return {
		activeIndex,
		currentTime,
		duration,
		hasStarted,
		loading,
		playing,
		rate,
		seek,
		setRate,
		toggle,
		words,
	};
}
