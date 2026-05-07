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
const PEAK_FLOOR = 0.1;
/** Per-frame decay applied to the tracked peak (~halflife 1.2s at 60fps). */
const PEAK_DECAY = 0.99;
/** audioLevel below this counts as silence. */
const SILENCE_THRESHOLD = 0.01;

export function useMultibandVolume(bands: number): number[] {
	const [volumes, setVolumes] = useState<number[]>(() => new Array(bands).fill(0));
	const rafRef = useRef(0);
	const bandsRef = useRef(bands);
	const peakRef = useRef(PEAK_FLOOR);
	bandsRef.current = bands;

	useEffect(() => {
		let running = true;

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
			} else {
				// AGC: track a slow-decaying max of recent levels, normalize against it.
				// Loud speech sets the peak; quiet speech is then stretched relative to it.
				const peak = Math.max(PEAK_FLOOR, audioLevel, peakRef.current * PEAK_DECAY);
				peakRef.current = peak;
				// sqrt curve gives quiet speech extra visual punch without flattening loud peaks.
				const amplified = Math.sqrt(Math.min(1, audioLevel / peak));

				const next: number[] = [];
				for (let i = 0; i < n; i++) {
					const phase = (i / n) * Math.PI * 2;
					const v1 = 0.3 * Math.sin(time * 3.7 + phase);
					const v2 = 0.2 * Math.sin(time * 7.3 + phase * 2.5);
					const v3 = 0.1 * Math.sin(time * 13.1 + phase * 0.7);
					next.push(Math.max(0.05, Math.min(1, amplified * (0.8 + v1 + v2 + v3))));
				}
				setVolumes(next);
			}

			rafRef.current = requestAnimationFrame(update);
		};

		rafRef.current = requestAnimationFrame(update);
		return () => {
			running = false;
			cancelAnimationFrame(rafRef.current);
		};
	}, []);

	return volumes;
}
