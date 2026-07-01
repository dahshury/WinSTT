import { useEffect, useRef, useState } from "react";
import {
	alignTranscriptionHistoryAudio,
	loadTranscriptionHistoryAudio,
	type WordTiming,
} from "@/shared/api/ipc-client";
import { fireAndForget } from "@/shared/lib/fire-and-forget";

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
	loading: boolean;
	playing: boolean;
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
 * and the per-word timestamps, then tracks playback position with a rAF loop —
 * the word-highlight sweep doubles as the progress indicator. No-ops when the
 * entry has no recording; called unconditionally per row (Rules of Hooks).
 */
export function useHistoryPlayback(
	entryId: string,
	hasAudio: boolean,
	outputDeviceId: string,
): PlaybackState {
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const rafRef = useRef<number | null>(null);
	const [playing, setPlaying] = useState(false);
	const [loading, setLoading] = useState(false);
	const [words, setWords] = useState<WordTiming[] | null>(null);
	const [currentTime, setCurrentTime] = useState(0);

	useEffect(
		() => () => {
			if (rafRef.current !== null) {
				cancelAnimationFrame(rafRef.current);
			}
			audioRef.current?.pause();
			audioRef.current = null;
		},
		[],
	);

	const stopTicking = () => {
		if (rafRef.current !== null) {
			cancelAnimationFrame(rafRef.current);
			rafRef.current = null;
		}
	};

	const tick = () => {
		if (audioRef.current) {
			setCurrentTime(audioRef.current.currentTime);
		}
		rafRef.current = requestAnimationFrame(tick);
	};

	const beginPlayback = async () => {
		if (!audioRef.current) {
			setLoading(true);
			// Fetch WAV bytes + word timings together on first play.
			const [dataUri, timings] = await Promise.all([
				loadTranscriptionHistoryAudio(entryId),
				alignTranscriptionHistoryAudio(entryId),
			]);
			setLoading(false);
			if (!dataUri) {
				return;
			}
			if (timings.length > 0) {
				setWords(timings);
			}
			const el = new Audio(dataUri);
			el.onended = () => {
				setPlaying(false);
				setCurrentTime(0);
				stopTicking();
			};
			audioRef.current = el;
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
		stopTicking();
		rafRef.current = requestAnimationFrame(tick);
	};

	const toggle = () => {
		if (!hasAudio) {
			return;
		}
		if (playing && audioRef.current) {
			audioRef.current.pause();
			setPlaying(false);
			stopTicking();
			return;
		}
		fireAndForget(beginPlayback(), "history.beginPlayback");
	};

	const activeIndex =
		playing && words ? findActiveWordIndex(words, currentTime) : -1;
	return { activeIndex, loading, playing, toggle, words };
}
