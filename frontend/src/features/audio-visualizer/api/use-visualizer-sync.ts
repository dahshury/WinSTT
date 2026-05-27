import { useEffect, useRef } from "react";
import {
	onAudioLevel,
	onFullSentence,
	onRecordingStart,
	onRecordingStop,
	onVadStart,
	onVadStop,
} from "@/shared/api/ipc-client";
import { useVisualizerStore } from "../model/visualizer-store";

/** Sentence pulse decay per frame. */
const PULSE_DECAY = 0.03;

/**
 * Subscribes to recording / VAD / audio-level IPC events and drives the
 * visualizer store with real RMS audio levels from the server.
 *
 * The rAF loop only runs while a recording is in progress. On
 * `recording_stop`, the store is committed to zero synchronously via
 * `recordingStopped()` — there is deliberately no post-stop fade-out tween.
 * A fade driven by rAF would pause along with the rest of the renderer
 * while the main window is hidden, leaving the last frame's audioLevel
 * frozen in the store and flashing the visualizer on next show. Snapping
 * to zero at the data layer is what makes hidden→shown paint correctly
 * from the first frame; visual smoothness, if needed, belongs to the
 * rendering layer (e.g. CSS transitions on bar height).
 */
export function useVisualizerSync(): void {
	const recordingStarted = useVisualizerStore((s) => s.recordingStarted);
	const recordingStopped = useVisualizerStore((s) => s.recordingStopped);
	const setSpeaking = useVisualizerStore((s) => s.setSpeaking);
	const setAudioLevel = useVisualizerStore((s) => s.setAudioLevel);
	const setSentencePulse = useVisualizerStore((s) => s.setSentencePulse);

	const rafRef = useRef(0);
	const activeRef = useRef(false);

	// Mutable accumulators updated from IPC callbacks, read in rAF loop.
	const rawLevelRef = useRef(0);
	const sentenceFiredRef = useRef(false);

	// Smoothed values persisted across frames.
	const pulseRef = useRef(0);

	// Hold the latest animate fn in a ref so subscription effects can schedule
	// frames without listing it as a dependency (the function closes over
	// store setters which are stable, but the ref keeps things honest).
	// @crap-exclude rAF callback — covered via E2E
	const animateRef = useRef<() => void>(() => {
		// noop placeholder, replaced on every render below
	});
	animateRef.current = () => {
		if (!activeRef.current) {
			return;
		}

		setAudioLevel(rawLevelRef.current);

		let pulse = pulseRef.current;
		if (sentenceFiredRef.current) {
			pulse = 1;
			sentenceFiredRef.current = false;
		} else {
			pulse = Math.max(0, pulse - PULSE_DECAY);
		}
		pulseRef.current = pulse;
		setSentencePulse(pulse);

		rafRef.current = requestAnimationFrame(() => animateRef.current());
	};

	useEffect(() => {
		// Cancel any in-flight frame before scheduling a new one. Without
		// this, rapid PTT cycles leak an extra rAF callback each cycle —
		// each callback calls requestAnimationFrame(animate) again, so the
		// scheduled-frame count grows exponentially and the renderer drowns
		// (which keeps the overlay BrowserWindow too busy to process its
		// hide() IPC, leaving the pill stuck on screen).
		return onRecordingStart(() => {
			cancelAnimationFrame(rafRef.current);
			activeRef.current = true;
			rawLevelRef.current = 0;
			pulseRef.current = 0;
			// Reset isRecording + audioLevel + sentencePulse in one store
			// update so the visualizer doesn't briefly render the previous
			// cycle's last frame after the pill re-shows.
			recordingStarted();
			rafRef.current = requestAnimationFrame(() => animateRef.current());
		});
	}, [recordingStarted]);

	useEffect(
		() =>
			onRecordingStop(() => {
				cancelAnimationFrame(rafRef.current);
				activeRef.current = false;
				rawLevelRef.current = 0;
				pulseRef.current = 0;
				sentenceFiredRef.current = false;
				// Store committed to zero atomically — see `recordingStopped`
				// docstring for why this beats an rAF fade for hidden windows.
				recordingStopped();
			}),
		[recordingStopped]
	);

	useEffect(() => {
		const unsubVadStart = onVadStart(() => setSpeaking(true));
		const unsubVadStop = onVadStop(() => setSpeaking(false));
		return () => {
			unsubVadStart();
			unsubVadStop();
		};
	}, [setSpeaking]);

	useEffect(() => {
		const unsubAudioLevel = onAudioLevel((level) => {
			rawLevelRef.current = level;
		});
		const unsubSentence = onFullSentence(() => {
			sentenceFiredRef.current = true;
		});
		return () => {
			unsubAudioLevel();
			unsubSentence();
		};
	}, []);

	useEffect(
		() => () => {
			activeRef.current = false;
			cancelAnimationFrame(rafRef.current);
		},
		[]
	);
}
