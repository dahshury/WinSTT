import { useEffect, useRef, useState } from "react";
import { useVisualizerStore } from "../model/visualizer-store";

/**
 * Generates multiband volume data from WinSTT's single RMS audio level.
 *
 * Replaces LiveKit's `useMultibandTrackVolume` by distributing the overall
 * audio level across N bands with time-varying per-band offsets to create
 * a natural-looking frequency distribution.
 */
/** Floor for the AGC peak — prevents silence/noise from being amplified. */
export const PEAK_FLOOR = 0.1;
/** Per-frame decay applied to the tracked peak (~halflife 1.2s at 60fps). */
export const PEAK_DECAY = 0.99;
/** audioLevel below this counts as silence. */
export const SILENCE_THRESHOLD = 0.01;

/**
 * Computes the AGC-normalized amplified level from a raw audio level and a
 * running peak. Returns the new peak and the amplified value.
 *
 * Extracted to be testable without the rAF loop.
 */
export function computeAmplified(
	audioLevel: number,
	prevPeak: number
): { amplified: number; peak: number } {
	const peak = Math.max(PEAK_FLOOR, audioLevel, prevPeak * PEAK_DECAY);
	const amplified = Math.sqrt(Math.min(1, audioLevel / peak));
	return { peak, amplified };
}

/**
 * Computes the per-band volume value for a single band index.
 *
 * Extracted to be testable without the rAF loop.
 */
export function computeBandValue(
	bandIndex: number,
	bands: number,
	time: number,
	amplified: number
): number {
	const phase = (bandIndex / bands) * Math.PI * 2;
	const v1 = 0.3 * Math.sin(time * 3.7 + phase);
	const v2 = 0.2 * Math.sin(time * 7.3 + phase * 2.5);
	const v3 = 0.1 * Math.sin(time * 13.1 + phase * 0.7);
	return Math.max(0.05, Math.min(1, amplified * (0.8 + v1 + v2 + v3)));
}

export function useMultibandVolume(bands: number): number[] {
	const [volumes, setVolumes] = useState<number[]>(() => new Array(bands).fill(0));
	const rafRef = useRef(0);
	const bandsRef = useRef(bands);
	const peakRef = useRef(PEAK_FLOOR);
	bandsRef.current = bands;

	// @crap-exclude rAF callback — AudioContext side effects; pure helpers (computeAmplified, computeBandValue) are unit tested
	useEffect(() => {
		let running = true;
		let zeroSettled = false;

		const update = () => {
			if (!running) {
				return;
			}

			const { audioLevel } = useVisualizerStore.getState();
			const n = bandsRef.current;
			const time = performance.now() / 1000;

			if (audioLevel < SILENCE_THRESHOLD) {
				// Decay peak toward floor while quiet so the next utterance
				// re-normalizes against a fresh baseline.
				peakRef.current = Math.max(PEAK_FLOOR, peakRef.current * PEAK_DECAY);
				setVolumes((prev) => {
					if (prev.length === n && prev.every((v) => v === 0)) {
						return prev;
					}
					return new Array(n).fill(0);
				});
				// Idle: park the loop once we've emitted one zero frame; the
				// subscription below restarts it as soon as audio comes in.
				// Without this, every visualizer instance burns ~60 fps of CPU
				// forever while disconnected.
				if (zeroSettled) {
					rafRef.current = 0;
					return;
				}
				zeroSettled = true;
			} else {
				zeroSettled = false;
				// AGC: track a slow-decaying max of recent levels, normalize against it.
				const { peak, amplified } = computeAmplified(audioLevel, peakRef.current);
				peakRef.current = peak;

				const next: number[] = [];
				for (let i = 0; i < n; i++) {
					next.push(computeBandValue(i, n, time, amplified));
				}
				setVolumes(next);
			}

			rafRef.current = requestAnimationFrame(update);
		};

		const ensureRunning = () => {
			if (!running || rafRef.current !== 0) {
				return;
			}
			zeroSettled = false;
			rafRef.current = requestAnimationFrame(update);
		};

		const unsubscribe = useVisualizerStore.subscribe((state, prev) => {
			if (state.audioLevel >= SILENCE_THRESHOLD && prev.audioLevel < SILENCE_THRESHOLD) {
				ensureRunning();
			}
		});

		rafRef.current = requestAnimationFrame(update);
		return () => {
			running = false;
			unsubscribe();
			if (rafRef.current !== 0) {
				cancelAnimationFrame(rafRef.current);
				rafRef.current = 0;
			}
		};
	}, []);

	return volumes;
}
